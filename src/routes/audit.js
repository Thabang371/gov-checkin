import { Router } from 'express';
import { pool } from '../db.js';
import { asyncRoute } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { allow } from '../middleware/auth.js';

export const auditRouter = Router();

// GET /api/audit?action=VIEW_PERSON&limit=100 — national admins only; reading the log is itself logged
auditRouter.get(
  '/',
  allow({ staff: ['NATIONAL_ADMIN'] }),
  asyncRoute(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const action = req.query.action ? String(req.query.action).toUpperCase() : null;
    const { rows } = await pool.query(
      `SELECT a.id, a.at, a.action, a.entity, a.entity_id, host(a.ip) AS ip, a.details,
              u.full_name AS actor, st.name AS station
         FROM audit_log a
         LEFT JOIN staff_users u ON u.id = a.actor_id
         LEFT JOIN scanner_stations st ON st.id = a.station_id
        WHERE ($1::text IS NULL OR a.action = $1)
        ORDER BY a.id DESC LIMIT $2`,
      [action, limit],
    );
    await audit(pool, req, { action: 'VIEW_AUDIT_LOG', entity: 'audit_log', details: { action, count: rows.length } });
    res.json(rows.map((r) => ({ ...r, id: Number(r.id) })));
  }),
);
