import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { config } from '../config.js';
import { asyncRoute, HttpError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { allow, assertSiteAccess, ALL_STAFF } from '../middleware/auth.js';
import { notifySite, subscribe } from '../events.js';

export const queueRouter = Router();

const SERVERS = ['OFFICER', 'SITE_ADMIN', 'NATIONAL_ADMIN']; // who may call and serve tickets

// Allowed ticket status changes
const TRANSITIONS = {
  CALLED: ['SERVING', 'DONE', 'SKIPPED'],
  SERVING: ['DONE'],
};

function idParam(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, `Invalid ${label}`);
  return id;
}

const TODAY = `(now() AT TIME ZONE $2)::date`;
const ISSUED_TODAY = `(q.issued_at AT TIME ZONE $2)::date = ${TODAY}`;

// GET /api/sites/:id/desks
queueRouter.get(
  '/sites/:id/desks',
  allow({ staff: ALL_STAFF }),
  asyncRoute(async (req, res) => {
    const siteId = idParam(req.params.id, 'site id');
    assertSiteAccess(req, siteId);
    const { rows } = await pool.query(
      `SELECT d.id, d.name, d.service_type_id, st.name AS service,
              (SELECT q.ticket_no FROM queue_tickets q WHERE q.desk_id = d.id AND q.status IN ('CALLED','SERVING')
                ORDER BY q.called_at DESC LIMIT 1) AS current_ticket
         FROM desks d LEFT JOIN service_types st ON st.id = d.service_type_id
        WHERE d.site_id = $1 ORDER BY d.id`,
      [siteId],
    );
    res.json(rows.map((d) => ({ id: d.id, name: d.name, serviceTypeId: d.service_type_id, service: d.service, currentTicket: d.current_ticket })));
  }),
);

// GET /api/sites/:id/queue — today's open tickets + headline numbers for the dashboard
queueRouter.get(
  '/sites/:id/queue',
  allow({ staff: ALL_STAFF }),
  asyncRoute(async (req, res) => {
    const siteId = idParam(req.params.id, 'site id');
    assertSiteAccess(req, siteId);
    const { rows } = await pool.query(
      `SELECT q.id, q.ticket_no, q.status, q.priority, q.issued_at, q.called_at, q.desk_id, d.name AS desk,
              st.name AS service, q.service_type_id, p.full_name, p.id_type, p.id_last4, a.booking_ref,
              u.full_name AS served_by
         FROM queue_tickets q
         JOIN visits v ON v.id = q.visit_id
         JOIN persons p ON p.id = v.person_id
         JOIN service_types st ON st.id = q.service_type_id
         LEFT JOIN desks d ON d.id = q.desk_id
         LEFT JOIN appointments a ON a.id = q.appointment_id
         LEFT JOIN staff_users u ON u.id = q.served_by
        WHERE q.site_id = $1 AND ${ISSUED_TODAY} AND q.status IN ('WAITING','CALLED','SERVING')
        ORDER BY CASE q.status WHEN 'WAITING' THEN 1 ELSE 0 END, q.priority DESC, q.issued_at`,
      [siteId, config.timezone],
    );
    const stats = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM visits WHERE site_id = $1 AND checked_out_at IS NULL) AS inside,
         count(*) FILTER (WHERE q.status = 'WAITING')::int AS waiting,
         count(*) FILTER (WHERE q.status = 'DONE')::int AS served,
         count(*) FILTER (WHERE q.status = 'SKIPPED')::int AS skipped,
         round(avg(extract(epoch FROM q.called_at - q.issued_at) / 60) FILTER (WHERE q.called_at IS NOT NULL))::int AS avg_wait_min
       FROM queue_tickets q WHERE q.site_id = $1 AND ${ISSUED_TODAY}`,
      [siteId, config.timezone],
    );
    const s = stats.rows[0];
    res.json({
      stats: { inside: s.inside, waiting: s.waiting, servedToday: s.served, skippedToday: s.skipped, avgWaitMin: s.avg_wait_min },
      tickets: rows.map((t) => ({
        id: Number(t.id),
        ticketNo: t.ticket_no,
        status: t.status,
        priority: t.priority,
        service: t.service,
        serviceTypeId: t.service_type_id,
        issuedAt: t.issued_at,
        calledAt: t.called_at,
        deskId: t.desk_id,
        desk: t.desk,
        servedBy: t.served_by,
        bookingRef: t.booking_ref,
        fullName: t.full_name,
        idType: t.id_type,
        idLast4: t.id_last4,
      })),
    });
  }),
);

// POST /api/desks/:id/call-next — the next ticket for this desk's service (any service if the desk has none)
queueRouter.post(
  '/desks/:id/call-next',
  allow({ staff: SERVERS }),
  asyncRoute(async (req, res) => {
    const deskId = idParam(req.params.id, 'desk id');
    const ticket = await withTransaction(async (db) => {
      const d = await db.query('SELECT id, site_id, name, service_type_id FROM desks WHERE id = $1 FOR UPDATE', [deskId]);
      const desk = d.rows[0];
      if (!desk) throw new HttpError(404, 'Desk not found');
      assertSiteAccess(req, desk.site_id);

      const busy = await db.query(
        `SELECT ticket_no FROM queue_tickets WHERE desk_id = $1 AND status IN ('CALLED','SERVING')`,
        [deskId],
      );
      if (busy.rows[0]) throw new HttpError(409, `Finish ${busy.rows[0].ticket_no} at this desk first`);

      // SKIP LOCKED: two desks pressing "Call next" at the same moment never get the same person
      const next = await db.query(
        `SELECT q.id FROM queue_tickets q
          WHERE q.site_id = $1 AND q.status = 'WAITING' AND ${ISSUED_TODAY}
            AND ($3::int IS NULL OR q.service_type_id = $3)
          ORDER BY q.priority DESC, q.issued_at
          LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [desk.site_id, config.timezone, desk.service_type_id],
      );
      if (!next.rows[0]) return null;

      const { rows } = await db.query(
        `UPDATE queue_tickets SET status = 'CALLED', desk_id = $2, served_by = $3, called_at = now()
          WHERE id = $1 RETURNING id, ticket_no, status, priority, called_at`,
        [next.rows[0].id, deskId, req.staff.id],
      );
      await notifySite(db, desk.site_id, 'called', { ticketNo: rows[0].ticket_no, desk: desk.name });
      await audit(db, req, { action: 'CALL_TICKET', entity: 'queue_tickets', entityId: rows[0].id, details: { desk: desk.name } });
      return { id: Number(rows[0].id), ticketNo: rows[0].ticket_no, status: rows[0].status, priority: rows[0].priority, desk: desk.name };
    });
    if (!ticket) return res.json({ ticket: null, message: 'Nobody is waiting for this desk' });
    res.json({ ticket });
  }),
);

// PATCH /api/tickets/:id { status: SERVING | DONE | SKIPPED }
queueRouter.patch(
  '/tickets/:id',
  allow({ staff: SERVERS }),
  asyncRoute(async (req, res) => {
    const ticketId = idParam(req.params.id, 'ticket id');
    const status = String(req.body?.status ?? '').toUpperCase();
    const result = await withTransaction(async (db) => {
      const t = await db.query('SELECT id, site_id, status, appointment_id, ticket_no FROM queue_tickets WHERE id = $1 FOR UPDATE', [ticketId]);
      const ticket = t.rows[0];
      if (!ticket) throw new HttpError(404, 'Ticket not found');
      assertSiteAccess(req, ticket.site_id);
      const allowed = TRANSITIONS[ticket.status] || [];
      if (!allowed.includes(status)) {
        throw new HttpError(409, `Ticket ${ticket.ticket_no} is ${ticket.status}; it can't become ${status || '(blank)'}`);
      }
      const finished = status === 'DONE' || status === 'SKIPPED';
      const { rows } = await db.query(
        `UPDATE queue_tickets SET status = $2, done_at = CASE WHEN $3 THEN now() ELSE done_at END
          WHERE id = $1 RETURNING id, ticket_no, status`,
        [ticketId, status, finished],
      );
      if (status === 'DONE' && ticket.appointment_id) {
        await db.query(`UPDATE appointments SET status = 'SERVED' WHERE id = $1`, [ticket.appointment_id]);
      }
      if (status === 'SKIPPED' && ticket.appointment_id) {
        await db.query(`UPDATE appointments SET status = 'NO_SHOW' WHERE id = $1`, [ticket.appointment_id]);
      }
      await notifySite(db, ticket.site_id, 'ticket-status');
      await audit(db, req, { action: `TICKET_${status}`, entity: 'queue_tickets', entityId: ticketId });
      return { id: Number(rows[0].id), ticketNo: rows[0].ticket_no, status: rows[0].status };
    });
    res.json(result);
  }),
);

// POST /api/tickets/:id/recall — call the same number again on the screen
queueRouter.post(
  '/tickets/:id/recall',
  allow({ staff: SERVERS }),
  asyncRoute(async (req, res) => {
    const ticketId = idParam(req.params.id, 'ticket id');
    const out = await withTransaction(async (db) => {
      const t = await db.query(
        `SELECT q.id, q.site_id, q.status, q.ticket_no, d.name AS desk
           FROM queue_tickets q LEFT JOIN desks d ON d.id = q.desk_id WHERE q.id = $1 FOR UPDATE OF q`,
        [ticketId],
      );
      const ticket = t.rows[0];
      if (!ticket) throw new HttpError(404, 'Ticket not found');
      assertSiteAccess(req, ticket.site_id);
      if (ticket.status !== 'CALLED') throw new HttpError(409, 'Only a called ticket can be recalled');
      await db.query('UPDATE queue_tickets SET called_at = now() WHERE id = $1', [ticketId]);
      await notifySite(db, ticket.site_id, 'called', { ticketNo: ticket.ticket_no, desk: ticket.desk, recall: true });
      await audit(db, req, { action: 'RECALL_TICKET', entity: 'queue_tickets', entityId: ticketId });
      return { ticketNo: ticket.ticket_no, desk: ticket.desk };
    });
    res.json(out);
  }),
);

// GET /api/display — for the waiting-area screen (station key). Ticket numbers and desks only, never names.
queueRouter.get(
  '/display',
  allow({ station: true }),
  asyncRoute(async (req, res) => {
    const siteId = req.station.siteId;
    const site = await pool.query('SELECT name FROM sites WHERE id = $1', [siteId]);
    const called = await pool.query(
      `SELECT q.ticket_no, q.status, q.called_at, d.name AS desk
         FROM queue_tickets q LEFT JOIN desks d ON d.id = q.desk_id
        WHERE q.site_id = $1 AND ${ISSUED_TODAY} AND q.called_at IS NOT NULL
        ORDER BY q.called_at DESC LIMIT 8`,
      [siteId, config.timezone],
    );
    const waiting = await pool.query(
      `SELECT st.name AS service, st.prefix, count(*)::int AS n
         FROM queue_tickets q JOIN service_types st ON st.id = q.service_type_id
        WHERE q.site_id = $1 AND ${ISSUED_TODAY} AND q.status = 'WAITING'
        GROUP BY st.name, st.prefix ORDER BY st.prefix`,
      [siteId, config.timezone],
    );
    res.json({
      site: site.rows[0]?.name,
      called: called.rows.map((r) => ({ ticketNo: r.ticket_no, desk: r.desk, status: r.status, calledAt: r.called_at })),
      waiting: waiting.rows.map((r) => ({ service: r.service, prefix: r.prefix, count: r.n })),
    });
  }),
);

// GET /api/sites/:id/events — Server-Sent Events: a small "something changed" message per change.
// Clients then re-fetch what they show. Works for staff (Bearer) and stations (X-Station-Key).
queueRouter.get(
  '/sites/:id/events',
  allow({ station: true, staff: ALL_STAFF }),
  asyncRoute(async (req, res) => {
    const siteId = idParam(req.params.id, 'site id');
    assertSiteAccess(req, siteId);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('event: ready\ndata: {}\n\n');

    // Stations only learn which ticket was called; staff get the event type too. No names are ever sent.
    const send = (evt) => {
      const data = req.station ? { type: evt.type, ticketNo: evt.ticketNo, desk: evt.desk, recall: evt.recall } : evt;
      res.write(`event: change\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const unsubscribe = await subscribe(siteId, send);
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }),
);
