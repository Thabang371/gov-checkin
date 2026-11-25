import { HttpError } from '../lib/errors.js';
import { config } from '../config.js';

/** Issue the next ticket number for a site + service today, e.g. B007. Numbers reset daily. */
export async function issueTicket(db, { siteId, serviceTypeId, visitId, appointmentId = null, priority = false }) {
  const svc = await db.query('SELECT id, prefix, name FROM service_types WHERE id = $1', [serviceTypeId]);
  if (!svc.rows[0]) throw new HttpError(400, 'Unknown serviceTypeId');
  const { prefix, name } = svc.rows[0];

  const counter = await db.query(
    `INSERT INTO ticket_counters (site_id, service_type_id, day, last_no)
     VALUES ($1, $2, (now() AT TIME ZONE $3)::date, 1)
     ON CONFLICT (site_id, service_type_id, day) DO UPDATE SET last_no = ticket_counters.last_no + 1
     RETURNING last_no`,
    [siteId, serviceTypeId, config.timezone],
  );
  const ticketNo = `${prefix}${String(counter.rows[0].last_no).padStart(3, '0')}`;

  const { rows } = await db.query(
    `INSERT INTO queue_tickets (site_id, service_type_id, visit_id, appointment_id, ticket_no, priority)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, ticket_no, priority, status, issued_at`,
    [siteId, serviceTypeId, visitId, appointmentId, ticketNo, priority],
  );
  const t = rows[0];
  const ahead = await db.query(
    `SELECT count(*)::int AS n FROM queue_tickets
      WHERE site_id = $1 AND service_type_id = $2 AND status = 'WAITING' AND id <> $3
        AND (priority > $4 OR (priority = $4 AND issued_at <= $5))`,
    [siteId, serviceTypeId, t.id, t.priority, t.issued_at],
  );
  return {
    id: Number(t.id),
    ticketNo: t.ticket_no,
    service: name,
    priority: t.priority,
    status: t.status,
    peopleAhead: ahead.rows[0].n,
  };
}
