import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { config } from '../config.js';
import { asyncRoute, HttpError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { allow, assertSiteAccess, ALL_STAFF, FRONT_DESK, ADMINS } from '../middleware/auth.js';
import { notifySite } from '../events.js';

export const sitesRouter = Router();

function siteParam(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Invalid site id');
  return id;
}

// GET /api/sites — national admins see all sites, everyone else sees their own
sitesRouter.get(
  '/',
  allow({ staff: ALL_STAFF }),
  asyncRoute(async (req, res) => {
    const national = req.staff.role === 'NATIONAL_ADMIN';
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.district, s.max_occupancy,
              (SELECT count(*)::int FROM visits v WHERE v.site_id = s.id AND v.checked_out_at IS NULL) AS inside
         FROM sites s ${national ? '' : 'WHERE s.id = $1'} ORDER BY s.id`,
      national ? [] : [req.staff.site_id],
    );
    res.json(rows.map((s) => ({ id: s.id, name: s.name, district: s.district, maxOccupancy: s.max_occupancy, inside: s.inside })));
  }),
);

// GET /api/sites/:id/occupancy — who is inside right now
sitesRouter.get(
  '/:id/occupancy',
  allow({ staff: FRONT_DESK }),
  asyncRoute(async (req, res) => {
    const siteId = siteParam(req);
    assertSiteAccess(req, siteId);
    const { rows } = await pool.query(
      `SELECT v.id, v.checked_in_at, v.method, v.purpose,
              p.full_name, p.id_type, p.id_last4,
              q.ticket_no, q.status AS ticket_status, st.name AS service
         FROM visits v
         JOIN persons p ON p.id = v.person_id
         LEFT JOIN LATERAL (SELECT * FROM queue_tickets q WHERE q.visit_id = v.id ORDER BY q.id DESC LIMIT 1) q ON true
         LEFT JOIN service_types st ON st.id = q.service_type_id
        WHERE v.site_id = $1 AND v.checked_out_at IS NULL
        ORDER BY v.checked_in_at`,
      [siteId],
    );
    await audit(pool, req, { action: 'VIEW_OCCUPANCY', entity: 'sites', entityId: siteId, details: { count: rows.length } });
    res.json({
      siteId,
      inside: rows.length,
      people: rows.map((r) => ({
        visitId: Number(r.id),
        fullName: r.full_name,
        idType: r.id_type,
        idLast4: r.id_last4,
        checkedInAt: r.checked_in_at,
        method: r.method,
        purpose: r.purpose,
        ticket: r.ticket_no ? { ticketNo: r.ticket_no, status: r.ticket_status, service: r.service } : null,
      })),
    });
  }),
);

// GET /api/sites/:id/visits?from=YYYY-MM-DD&to=YYYY-MM-DD — history, admins only
sitesRouter.get(
  '/:id/visits',
  allow({ staff: ADMINS }),
  asyncRoute(async (req, res) => {
    const siteId = siteParam(req);
    assertSiteAccess(req, siteId);
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    const from = req.query.from ?? null;
    const to = req.query.to ?? null;
    if ((from && !iso.test(from)) || (to && !iso.test(to))) throw new HttpError(400, 'from/to must be YYYY-MM-DD');
    const limit = Math.min(Number(req.query.limit) || 200, 1000);

    const { rows } = await pool.query(
      `SELECT v.id, v.checked_in_at, v.checked_out_at, v.method, v.purpose, v.auto_closed,
              p.full_name, p.id_type, p.id_last4
         FROM visits v JOIN persons p ON p.id = v.person_id
        WHERE v.site_id = $1
          AND ($2::date IS NULL OR (v.checked_in_at AT TIME ZONE $4)::date >= $2::date)
          AND ($3::date IS NULL OR (v.checked_in_at AT TIME ZONE $4)::date <= $3::date)
        ORDER BY v.checked_in_at DESC
        LIMIT $5`,
      [siteId, from, to, config.timezone, limit],
    );
    await audit(pool, req, { action: 'VIEW_VISIT_HISTORY', entity: 'sites', entityId: siteId, details: { from, to, count: rows.length } });
    res.json(
      rows.map((r) => ({
        visitId: Number(r.id),
        fullName: r.full_name,
        idType: r.id_type,
        idLast4: r.id_last4,
        checkedInAt: r.checked_in_at,
        checkedOutAt: r.checked_out_at,
        method: r.method,
        purpose: r.purpose,
        autoClosed: r.auto_closed,
      })),
    );
  }),
);

// POST /api/sites/:id/close-day — checks out everyone still inside at closing time and flags them
sitesRouter.post(
  '/:id/close-day',
  allow({ staff: ADMINS }),
  asyncRoute(async (req, res) => {
    const siteId = siteParam(req);
    assertSiteAccess(req, siteId);
    const closed = await withTransaction(async (db) => {
      const r = await db.query(
        `UPDATE visits SET checked_out_at = now(), auto_closed = true
          WHERE site_id = $1 AND checked_out_at IS NULL RETURNING id`,
        [siteId],
      );
      const ids = r.rows.map((x) => x.id);
      if (ids.length) {
        await db.query(
          `UPDATE queue_tickets SET status = 'SKIPPED', done_at = now()
            WHERE visit_id = ANY($1) AND status IN ('WAITING','CALLED','SERVING')`,
          [ids],
        );
      }
      await db.query(
        `UPDATE appointments SET status = 'NO_SHOW'
          WHERE site_id = $1 AND status = 'BOOKED'
            AND (scheduled_for AT TIME ZONE $2)::date <= (now() AT TIME ZONE $2)::date`,
        [siteId, config.timezone],
      );
      await notifySite(db, siteId, 'close-day');
      await audit(db, req, { action: 'CLOSE_DAY', entity: 'sites', entityId: siteId, details: { autoClosed: ids.length } });
      return ids.length;
    });
    res.json({ siteId, autoClosedVisits: closed });
  }),
);
