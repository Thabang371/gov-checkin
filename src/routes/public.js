// Citizen-facing online booking. No staff login: a citizen confirms who they are with their
// ID number + date of birth (checked against the mock registry) and gets a 30-minute token.
import crypto from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { pool, withTransaction } from '../db.js';
import { config } from '../config.js';
import { asyncRoute, HttpError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { hashIdNumber, validateIdNumber } from '../lib/idhash.js';
import { requireCitizen, signCitizenToken } from '../middleware/auth.js';

export const publicRouter = Router();

const SLOT_MIN = 20;
const BOOK_AHEAD_DAYS = 14;
const MIN_NOTICE_MIN = 30;
const MAX_UPCOMING = 2;
const HOURS = { weekday: ['08:00', '15:40'], saturday: ['08:00', '11:40'] }; // first and last slot start
const NOT_BOOKABLE = ['ENQUIRY']; // general enquiries are walk-in only

// Limits: verification is the sensitive part (stops guessing ID + birthday pairs)
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.VERIFY_LIMIT) || 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' } });
const generalLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
publicRouter.use(generalLimiter);

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const dow = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

function slotTimes(date) {
  const d = dow(date);
  if (d === 0) return [];
  const [a, b] = d === 6 ? HOURS.saturday : HOURS.weekday;
  const out = [];
  for (let m = toMin(a); m <= toMin(b); m += SLOT_MIN) out.push(toHHMM(m));
  return out;
}

async function nowLocal(db = pool) {
  const { rows } = await db.query(
    `SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS d, to_char(now() AT TIME ZONE $1, 'HH24:MI') AS t`,
    [config.timezone],
  );
  return { date: rows[0].d, minutes: toMin(rows[0].t) };
}

function bookableDays(today) {
  const days = [];
  for (let i = 0; i <= BOOK_AHEAD_DAYS; i++) {
    const d = addDays(today, i);
    if (slotTimes(d).length) days.push(d);
  }
  return days;
}

function newRef() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
  const bytes = crypto.randomBytes(6);
  return `APT-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')}`;
}

// GET /api/public/options — what can be booked
publicRouter.get(
  '/options',
  asyncRoute(async (req, res) => {
    const [sites, services, now] = await Promise.all([
      pool.query('SELECT id, name, district FROM sites ORDER BY id'), // pilot site first
      pool.query(`SELECT id, name, prefix FROM service_types WHERE slot_capacity > 0 AND code <> ALL($1) ORDER BY prefix`, [NOT_BOOKABLE]),
      nowLocal(),
    ]);
    res.json({ sites: sites.rows, services: services.rows, days: bookableDays(now.date), slotMinutes: SLOT_MIN });
  }),
);

// POST /api/public/verify { idType, idNumber, dateOfBirth } — same answer whether the ID or the birthday is wrong
publicRouter.post(
  '/verify',
  verifyLimiter,
  asyncRoute(async (req, res) => {
    const idType = String(req.body?.idType ?? '').toUpperCase();
    const { idNumber, dateOfBirth } = req.body ?? {};
    const err = validateIdNumber(idType, idNumber);
    if (err) throw new HttpError(400, err);
    if (!ISO.test(String(dateOfBirth ?? ''))) throw new HttpError(400, 'Enter your date of birth');
    const { rows } = await pool.query(
      'SELECT id, full_name, date_of_birth FROM persons WHERE id_type = $1 AND id_hash = $2',
      [idType, hashIdNumber(idType, idNumber)],
    );
    const p = rows[0];
    const ok = p && p.date_of_birth === dateOfBirth;
    await audit(pool, req, { action: ok ? 'CITIZEN_VERIFY' : 'CITIZEN_VERIFY_FAILED', entity: 'persons', entityId: ok ? p.id : null, details: { idType } });
    if (!ok) throw new HttpError(401, "Those details don't match our records. Check your ID number and date of birth.");
    res.json({ token: signCitizenToken(p.id), firstName: p.full_name.split(' ')[0], expiresInMinutes: 30 });
  }),
);

// GET /api/public/slots?siteId=&serviceTypeId=&date=
publicRouter.get(
  '/slots',
  requireCitizen,
  asyncRoute(async (req, res) => {
    const siteId = Number(req.query.siteId);
    const serviceTypeId = Number(req.query.serviceTypeId);
    const date = String(req.query.date ?? '');
    if (!Number.isInteger(siteId) || !Number.isInteger(serviceTypeId) || !ISO.test(date)) throw new HttpError(400, 'siteId, serviceTypeId and date are required');
    const now = await nowLocal();
    if (!bookableDays(now.date).includes(date)) return res.json({ date, slots: [] });
    const svc = await pool.query('SELECT slot_capacity FROM service_types WHERE id = $1', [serviceTypeId]);
    if (!svc.rows[0]) throw new HttpError(400, 'Unknown service');
    const cap = svc.rows[0].slot_capacity;
    const taken = await pool.query(
      `SELECT to_char(scheduled_for AT TIME ZONE $4, 'HH24:MI') AS t, count(*)::int AS n
         FROM appointments
        WHERE site_id = $1 AND service_type_id = $2 AND status IN ('BOOKED','CHECKED_IN','SERVED')
          AND (scheduled_for AT TIME ZONE $4)::date = $3::date
        GROUP BY 1`,
      [siteId, serviceTypeId, date, config.timezone],
    );
    const used = Object.fromEntries(taken.rows.map((r) => [r.t, r.n]));
    const slots = slotTimes(date)
      .filter((t) => date !== now.date || toMin(t) >= now.minutes + MIN_NOTICE_MIN)
      .map((t) => ({ time: t, available: Math.max(0, cap - (used[t] || 0)) }));
    res.json({ date, slots });
  }),
);

async function myBookings(personId) {
  const { rows } = await pool.query(
    `SELECT a.booking_ref, a.scheduled_for, a.status, s.name AS site, s.id AS site_id, st.name AS service,
            to_char(a.scheduled_for AT TIME ZONE $2, 'YYYY-MM-DD') AS date, to_char(a.scheduled_for AT TIME ZONE $2, 'HH24:MI') AS time
       FROM appointments a JOIN sites s ON s.id = a.site_id JOIN service_types st ON st.id = a.service_type_id
      WHERE a.person_id = $1 AND a.status IN ('BOOKED','CHECKED_IN')
        AND (a.scheduled_for AT TIME ZONE $2)::date >= (now() AT TIME ZONE $2)::date
      ORDER BY a.scheduled_for`,
    [personId, config.timezone],
  );
  return rows.map((r) => ({ bookingRef: r.booking_ref, date: r.date, time: r.time, status: r.status, site: r.site, siteId: r.site_id, service: r.service }));
}

// GET /api/public/bookings — my upcoming appointments
publicRouter.get(
  '/bookings',
  requireCitizen,
  asyncRoute(async (req, res) => res.json(await myBookings(req.citizen.personId))),
);

// POST /api/public/bookings { siteId, serviceTypeId, date, time }
publicRouter.post(
  '/bookings',
  requireCitizen,
  asyncRoute(async (req, res) => {
    const siteId = Number(req.body?.siteId);
    const serviceTypeId = Number(req.body?.serviceTypeId);
    const date = String(req.body?.date ?? '');
    const time = String(req.body?.time ?? '');
    if (!Number.isInteger(siteId) || !Number.isInteger(serviceTypeId) || !ISO.test(date) || !HHMM.test(time)) {
      throw new HttpError(400, 'siteId, serviceTypeId, date and time are required');
    }
    const personId = req.citizen.personId;

    const booking = await withTransaction(async (db) => {
      const now = await nowLocal(db);
      if (!bookableDays(now.date).includes(date) || !slotTimes(date).includes(time)) throw new HttpError(400, 'That time is not open for booking');
      if (date === now.date && toMin(time) < now.minutes + MIN_NOTICE_MIN) throw new HttpError(400, 'That time is too soon. Please pick a later slot.');
      const site = await db.query('SELECT id, name FROM sites WHERE id = $1', [siteId]);
      const svc = await db.query(`SELECT id, name, slot_capacity, code FROM service_types WHERE id = $1`, [serviceTypeId]);
      if (!site.rows[0] || !svc.rows[0] || NOT_BOOKABLE.includes(svc.rows[0].code) || svc.rows[0].slot_capacity < 1) {
        throw new HttpError(400, 'That office or service cannot be booked online');
      }

      // One person at a time (stops double-clicks creating two bookings), then one slot at a time
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`person:${personId}`]);
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`slot:${siteId}:${serviceTypeId}:${date}:${time}`]);

      const mine = await db.query(
        `SELECT service_type_id FROM appointments
          WHERE person_id = $1 AND status = 'BOOKED' AND scheduled_for >= now()`,
        [personId],
      );
      if (mine.rows.some((r) => r.service_type_id === serviceTypeId)) throw new HttpError(409, `You already have a booking for ${svc.rows[0].name}. Cancel it first to choose a new time.`);
      if (mine.rows.length >= MAX_UPCOMING) throw new HttpError(409, `You can have at most ${MAX_UPCOMING} upcoming bookings.`);

      const scheduled = await db.query(`SELECT ($1::date + $2::time) AT TIME ZONE $3 AS ts`, [date, time, config.timezone]);
      const ts = scheduled.rows[0].ts;
      const taken = await db.query(
        `SELECT count(*)::int AS n FROM appointments
          WHERE site_id = $1 AND service_type_id = $2 AND scheduled_for = $3 AND status IN ('BOOKED','CHECKED_IN','SERVED')`,
        [siteId, serviceTypeId, ts],
      );
      if (taken.rows[0].n >= svc.rows[0].slot_capacity) throw new HttpError(409, 'Sorry, that time has just been taken. Please pick another.');

      let ref;
      for (let i = 0; i < 5; i++) {
        ref = newRef();
        const clash = await db.query('SELECT 1 FROM appointments WHERE booking_ref = $1', [ref]);
        if (!clash.rows[0]) break;
      }
      await db.query(
        `INSERT INTO appointments (booking_ref, person_id, site_id, service_type_id, scheduled_for, source)
         VALUES ($1, $2, $3, $4, $5, 'ONLINE')`,
        [ref, personId, siteId, serviceTypeId, ts],
      );
      await audit(db, req, { action: 'BOOK_ONLINE', entity: 'appointments', entityId: ref, details: { personId, siteId, date, time } });
      return { bookingRef: ref, site: site.rows[0].name, service: svc.rows[0].name, date, time };
    });
    res.status(201).json(booking);
  }),
);

// DELETE /api/public/bookings/:ref — cancel one of my own future bookings
publicRouter.delete(
  '/bookings/:ref',
  requireCitizen,
  asyncRoute(async (req, res) => {
    const ref = String(req.params.ref).toUpperCase();
    const out = await withTransaction(async (db) => {
      const { rows } = await db.query(
        `SELECT id, status, scheduled_for FROM appointments WHERE booking_ref = $1 AND person_id = $2 FOR UPDATE`,
        [ref, req.citizen.personId],
      );
      const a = rows[0];
      if (!a) throw new HttpError(404, 'Booking not found'); // also when it belongs to someone else
      if (a.status !== 'BOOKED') throw new HttpError(409, 'This booking can no longer be cancelled');
      if (new Date(a.scheduled_for) < new Date()) throw new HttpError(409, 'This appointment time has already passed');
      await db.query(`UPDATE appointments SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1`, [a.id]);
      await audit(db, req, { action: 'CANCEL_ONLINE', entity: 'appointments', entityId: ref, details: { personId: req.citizen.personId } });
      return { bookingRef: ref, status: 'CANCELLED' };
    });
    res.json(out);
  }),
);
