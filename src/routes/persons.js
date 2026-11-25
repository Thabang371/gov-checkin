import { Router } from 'express';
import { pool } from '../db.js';
import { asyncRoute, HttpError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { allow, FRONT_DESK } from '../middleware/auth.js';
import { hashIdNumber, validateIdNumber } from '../lib/idhash.js';

export const personsRouter = Router();

// GET /api/persons/lookup?type=OMANG&number=123456789 — every lookup is audited, found or not
personsRouter.get(
  '/lookup',
  allow({ staff: FRONT_DESK }),
  asyncRoute(async (req, res) => {
    const type = String(req.query.type ?? '').toUpperCase();
    const number = req.query.number;
    const err = validateIdNumber(type, number);
    if (err) throw new HttpError(400, err);

    const { rows } = await pool.query(
      `SELECT id, id_type, id_last4, full_name, nationality, date_of_birth, doc_expiry
         FROM persons WHERE id_type = $1 AND id_hash = $2`,
      [type, hashIdNumber(type, number)],
    );
    const p = rows[0];
    await audit(pool, req, { action: 'VIEW_PERSON', entity: 'persons', entityId: p?.id ?? null, details: { type, found: !!p } });
    if (!p) throw new HttpError(404, 'No record for that ID');

    // Site staff only see visits at their own site
    const national = req.staff.role === 'NATIONAL_ADMIN';
    const visits = await pool.query(
      `SELECT v.id, s.name AS site, v.checked_in_at, v.checked_out_at
         FROM visits v JOIN sites s ON s.id = v.site_id
        WHERE v.person_id = $1 ${national ? '' : 'AND v.site_id = $2'}
        ORDER BY v.checked_in_at DESC LIMIT 10`,
      national ? [p.id] : [p.id, req.staff.site_id],
    );
    const appts = await pool.query(
      `SELECT a.booking_ref, a.scheduled_for, a.status, st.name AS service, s.name AS site
         FROM appointments a JOIN service_types st ON st.id = a.service_type_id JOIN sites s ON s.id = a.site_id
        WHERE a.person_id = $1 AND a.scheduled_for > now() - interval '30 days'
          ${national ? '' : 'AND a.site_id = $2'}
        ORDER BY a.scheduled_for DESC LIMIT 10`,
      national ? [p.id] : [p.id, req.staff.site_id],
    );

    res.json({
      id: p.id,
      fullName: p.full_name,
      idType: p.id_type,
      idLast4: p.id_last4,
      nationality: p.nationality,
      dateOfBirth: p.date_of_birth,
      docExpiry: p.doc_expiry,
      recentVisits: visits.rows.map((v) => ({ visitId: Number(v.id), site: v.site, checkedInAt: v.checked_in_at, checkedOutAt: v.checked_out_at })),
      appointments: appts.rows.map((a) => ({ bookingRef: a.booking_ref, scheduledFor: a.scheduled_for, status: a.status, service: a.service, site: a.site })),
    });
  }),
);
