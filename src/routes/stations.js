import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { asyncRoute, HttpError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { allow, assertSiteAccess, ALL_STAFF, FRONT_DESK } from '../middleware/auth.js';
import { issueTicket } from '../services/queue.js';

export const stationsRouter = Router();

// GET /api/stations/me — a station checks its key and learns which site it belongs to
stationsRouter.get(
  '/stations/me',
  allow({ station: true }),
  asyncRoute(async (req, res) => {
    const { rows } = await pool.query('SELECT name FROM sites WHERE id = $1', [req.station.siteId]);
    res.json({ stationId: req.station.id, stationName: req.station.name, siteId: req.station.siteId, siteName: rows[0]?.name });
  }),
);

// GET /api/service-types — the list a visitor picks from
stationsRouter.get(
  '/service-types',
  allow({ station: true, staff: ALL_STAFF }),
  asyncRoute(async (req, res) => {
    const { rows } = await pool.query('SELECT id, code, name, prefix FROM service_types ORDER BY prefix');
    res.json(rows);
  }),
);

// POST /api/visits/:id/ticket { serviceTypeId } — walk-in picks a service after scanning in
stationsRouter.post(
  '/visits/:id/ticket',
  allow({ station: true, staff: FRONT_DESK }),
  asyncRoute(async (req, res) => {
    const visitId = Number(req.params.id);
    const serviceTypeId = Number(req.body?.serviceTypeId);
    if (!Number.isInteger(visitId) || !Number.isInteger(serviceTypeId)) throw new HttpError(400, 'visit id and serviceTypeId are required');

    const ticket = await withTransaction(async (db) => {
      const v = await db.query('SELECT id, site_id FROM visits WHERE id = $1 AND checked_out_at IS NULL FOR UPDATE', [visitId]);
      if (!v.rows[0]) throw new HttpError(404, 'No open visit with that id');
      assertSiteAccess(req, v.rows[0].site_id);
      const existing = await db.query(
        `SELECT 1 FROM queue_tickets WHERE visit_id = $1 AND status IN ('WAITING','CALLED','SERVING')`,
        [visitId],
      );
      if (existing.rows[0]) throw new HttpError(409, 'This visit already has a ticket in the queue');
      const t = await issueTicket(db, { siteId: v.rows[0].site_id, serviceTypeId, visitId });
      await audit(db, req, { action: 'ISSUE_TICKET', entity: 'queue_tickets', entityId: t.id, details: { visitId, ticket: t.ticketNo } });
      return t;
    });
    res.status(201).json(ticket);
  }),
);
