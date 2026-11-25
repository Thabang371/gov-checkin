import { Router } from 'express';
import ExcelJS from 'exceljs';
import { pool, withTransaction } from '../db.js';
import { config } from '../config.js';
import { asyncRoute, HttpError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { allow, assertSiteAccess, ALL_STAFF, FRONT_DESK, ADMINS } from '../middleware/auth.js';
import { notifySite } from '../events.js';

export const reportsRouter = Router();

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const siteParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Invalid site id');
  return id;
};
async function todayLocal() {
  return (await pool.query('SELECT (now() AT TIME ZONE $1)::date::text AS d', [config.timezone])).rows[0].d;
}
async function resolveDate(req, { anyDate }) {
  const today = await todayLocal();
  const date = req.query.date || today;
  if (!ISO.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  if (!anyDate && date !== today) throw new HttpError(403, 'Reception can only see today. Ask a site admin for older days.');
  return date;
}

// ---------- Walk-in visitors (not queueing for a service) ----------

// GET /api/sites/:id/departments — offices a visitor can choose
reportsRouter.get(
  '/sites/:id/departments',
  allow({ station: true, staff: ALL_STAFF }),
  asyncRoute(async (req, res) => {
    const siteId = siteParam(req);
    assertSiteAccess(req, siteId);
    const { rows } = await pool.query('SELECT id, name FROM departments WHERE site_id = $1 AND active ORDER BY name', [siteId]);
    res.json(rows);
  }),
);

// POST /api/visits/:id/purpose { departmentId, hostName? } — "I'm here to see an office or a person"
reportsRouter.post(
  '/visits/:id/purpose',
  allow({ station: true, staff: FRONT_DESK }),
  asyncRoute(async (req, res) => {
    const visitId = Number(req.params.id);
    const departmentId = Number(req.body?.departmentId);
    const hostName = req.body?.hostName ? String(req.body.hostName).trim().replace(/\s+/g, ' ').slice(0, 80) : null;
    if (!Number.isInteger(visitId) || !Number.isInteger(departmentId)) throw new HttpError(400, 'visit id and departmentId are required');

    const out = await withTransaction(async (db) => {
      const v = await db.query('SELECT id, site_id FROM visits WHERE id = $1 AND checked_out_at IS NULL FOR UPDATE', [visitId]);
      if (!v.rows[0]) throw new HttpError(404, 'No open visit with that id');
      const siteId = v.rows[0].site_id;
      assertSiteAccess(req, siteId);
      const dep = await db.query('SELECT id, name FROM departments WHERE id = $1 AND site_id = $2 AND active', [departmentId, siteId]);
      if (!dep.rows[0]) throw new HttpError(400, 'Unknown office for this site');
      const busy = await db.query(`SELECT 1 FROM queue_tickets WHERE visit_id = $1 AND status IN ('WAITING','CALLED','SERVING')`, [visitId]);
      if (busy.rows[0]) throw new HttpError(409, 'This visit is already in the service queue');
      await db.query(
        `UPDATE visits SET department_id = $2, host_name = $3, purpose = 'Visiting an office', reason_added_by = $4 WHERE id = $1`,
        [visitId, departmentId, hostName, req.staff?.id ?? null],
      );
      await notifySite(db, siteId, 'visitor');
      await audit(db, req, { action: 'VISIT_PURPOSE', entity: 'visits', entityId: visitId, details: { department: dep.rows[0].name } });
      return { visitId, department: dep.rows[0].name, hostName };
    });
    res.json(out);
  }),
);

// ---------- Visitor register (replaces the paper sign-in book) ----------

async function registerRows(siteId, date) {
  const { rows } = await pool.query(
    `SELECT v.id, v.checked_in_at, v.checked_out_at, v.method, v.auto_closed, v.host_name, v.purpose,
            v.reason_added_by, ra.full_name AS reason_added_by_name,
            p.full_name, p.id_type, p.id_last4, p.nationality,
            dep.name AS department, q.ticket_no, q.status AS ticket_status, st.name AS service,
            round(extract(epoch FROM coalesce(v.checked_out_at, now()) - v.checked_in_at) / 60)::int AS minutes
       FROM visits v
       JOIN persons p ON p.id = v.person_id
       LEFT JOIN departments dep ON dep.id = v.department_id
       LEFT JOIN staff_users ra ON ra.id = v.reason_added_by
       LEFT JOIN LATERAL (SELECT * FROM queue_tickets q WHERE q.visit_id = v.id ORDER BY q.id DESC LIMIT 1) q ON true
       LEFT JOIN service_types st ON st.id = q.service_type_id
      WHERE v.site_id = $1 AND (v.checked_in_at AT TIME ZONE $3)::date = $2::date
      ORDER BY v.checked_in_at`,
    [siteId, date, config.timezone],
  );
  return rows.map((r) => ({
    visitId: Number(r.id),
    checkedInAt: r.checked_in_at,
    checkedOutAt: r.checked_out_at,
    minutesInside: r.minutes,
    stillInside: !r.checked_out_at,
    autoClosed: r.auto_closed,
    fullName: r.full_name,
    idType: r.id_type,
    idLast4: r.id_last4,
    nationality: r.nationality,
    method: r.method,
    reason: r.service ? r.service : r.department ? `Visiting: ${r.department}${r.host_name ? ` (${r.host_name})` : ''}` : 'Not given',
    kind: r.service ? 'service' : r.department ? 'visitor' : 'unknown',
    ticketNo: r.ticket_no,
    ticketStatus: r.ticket_status,
    reasonAddedBy: r.reason_added_by_name || null,
  }));
}

function toCsv(rows, timezone) {
  const fmt = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: timezone }) : '');
  // Stop spreadsheet formula injection: a cell starting with = + - @ is prefixed with '
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Time in', 'Time out', 'Minutes inside', 'Name', 'ID type', 'ID last 4', 'Nationality', 'Reason', 'Ticket', 'Ticket status', 'Scanned by', 'Auto checked out'];
  const lines = rows.map((r) => [
    fmt(r.checkedInAt), fmt(r.checkedOutAt), r.minutesInside, r.fullName, r.idType, r.idLast4, r.nationality,
    r.reason, r.ticketNo, r.ticketStatus, r.method, r.autoClosed ? 'yes' : '',
  ].map(cell).join(','));
  return [header.join(','), ...lines].join('\r\n');
}

async function toXlsx(rows, { siteName, date, timezone }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Gov ID Check-in';
  wb.created = new Date();
  const ws = wb.addWorksheet('Visitor register', {
    views: [{ state: 'frozen', ySplit: 4 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
    headerFooter: { oddFooter: '&LGov ID Check-in visitor register&RPage &P of &N' },
  });
  const cols = [
    { header: 'Time in', key: 'in', width: 9 },
    { header: 'Time out', key: 'out', width: 9 },
    { header: 'Minutes inside', key: 'mins', width: 9 },
    { header: 'Name', key: 'name', width: 26 },
    { header: 'ID type', key: 'idType', width: 11 },
    { header: 'ID last 4', key: 'last4', width: 9 },
    { header: 'Nationality', key: 'nat', width: 11 },
    { header: 'Reason for visit', key: 'reason', width: 38 },
    { header: 'Ticket', key: 'ticket', width: 8 },
    { header: 'Ticket status', key: 'status', width: 12 },
    { header: 'Scanned by', key: 'method', width: 10 },
    { header: 'Note', key: 'note', width: 22 },
  ];
  ws.columns = cols.map(({ key, width }) => ({ key, width }));
  const longDate = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  ws.mergeCells(1, 1, 1, cols.length);
  ws.getCell(1, 1).value = `Visitor register: ${siteName}`;
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  ws.mergeCells(2, 1, 2, cols.length);
  const inside = rows.filter((r) => r.stillInside).length;
  ws.getCell(2, 1).value = `${longDate} · ${rows.length} people · ${inside} still inside · ID numbers shown as last 4 digits only`;
  ws.getCell(2, 1).font = { color: { argb: 'FF5B6470' } };
  const header = ws.getRow(4);
  cols.forEach((c, i) => { header.getCell(i + 1).value = c.header; });
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.height = 30;
  header.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111418' } }; });

  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: timezone }) : '');
  rows.forEach((r, i) => {
    // Every value is written as plain text or a number, never as a formula
    const row = ws.addRow({
      in: time(r.checkedInAt),
      out: r.stillInside ? 'Inside' : time(r.checkedOutAt),
      mins: r.minutesInside,
      name: r.fullName,
      idType: r.idType === 'OMANG' ? 'Omang' : r.idType === 'PASSPORT' ? 'Passport' : 'Permit',
      last4: r.idLast4,
      nat: r.nationality || '',
      reason: r.reason,
      ticket: r.ticketNo || '',
      status: r.ticketStatus || '',
      method: r.method,
      note: [r.autoClosed ? 'Did not scan out' : '', r.reasonAddedBy ? `Reason added by ${r.reasonAddedBy}` : ''].filter(Boolean).join('; '),
    });
    row.getCell('last4').numFmt = '@';
    if (i % 2 === 1) row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F7FA' } }; });
    if (r.reason === 'Not given') row.getCell('reason').font = { color: { argb: 'FF9A5B00' } };
    if (r.stillInside) row.getCell('out').font = { color: { argb: 'FF1E7F4F' }, bold: true };
  });
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: cols.length } };
  return wb.xlsx.writeBuffer();
}

// GET /api/sites/:id/register?date=YYYY-MM-DD[&format=csv|xlsx] — reception: today; admins: any day
reportsRouter.get(
  '/sites/:id/register',
  allow({ staff: FRONT_DESK }),
  asyncRoute(async (req, res) => {
    const siteId = siteParam(req);
    assertSiteAccess(req, siteId);
    const date = await resolveDate(req, { anyDate: ADMINS.includes(req.staff.role) });
    const rows = await registerRows(siteId, date);
    const format = ['csv', 'xlsx'].includes(req.query.format) ? req.query.format : 'json';
    await audit(pool, req, { action: format === 'json' ? 'VIEW_REGISTER' : 'EXPORT_REGISTER', entity: 'sites', entityId: siteId, details: { date, count: rows.length, format } });
    if (format === 'xlsx') {
      const site = await pool.query('SELECT name FROM sites WHERE id = $1', [siteId]);
      const buf = await toXlsx(rows, { siteName: site.rows[0]?.name || `Site ${siteId}`, date, timezone: config.timezone });
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="visitor-register-site${siteId}-${date}.xlsx"`);
      return res.send(Buffer.from(buf));
    }
    if (format === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="visitor-register-site${siteId}-${date}.csv"`);
      return res.send(`﻿${toCsv(rows, config.timezone)}`); // BOM so Excel reads UTF-8 names correctly
    }
    res.json({ date, siteId, count: rows.length, rows });
  }),
);

// ---------- Daily report (admins) ----------

reportsRouter.get(
  '/sites/:id/report',
  allow({ staff: ADMINS }),
  asyncRoute(async (req, res) => {
    const siteId = siteParam(req);
    assertSiteAccess(req, siteId);
    const date = await resolveDate(req, { anyDate: true });
    const tz = config.timezone;
    const DAY = `(v.checked_in_at AT TIME ZONE $3)::date = $2::date`;
    const TDAY = `(q.issued_at AT TIME ZONE $3)::date = $2::date`;
    const args = [siteId, date, tz];

    const [site, totals, tickets, byHour, byService, appts, byDept, trend] = await Promise.all([
      pool.query('SELECT name FROM sites WHERE id = $1', [siteId]),
      pool.query(
        `SELECT count(*)::int AS visits,
                count(DISTINCT v.person_id)::int AS people,
                count(*) FILTER (WHERE v.department_id IS NOT NULL)::int AS visitors,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM queue_tickets q WHERE q.visit_id = v.id))::int AS with_ticket,
                count(*) FILTER (WHERE v.checked_out_at IS NULL)::int AS still_inside,
                count(*) FILTER (WHERE v.auto_closed)::int AS auto_closed,
                round(avg(extract(epoch FROM v.checked_out_at - v.checked_in_at) / 60) FILTER (WHERE v.checked_out_at IS NOT NULL AND NOT v.auto_closed))::int AS avg_inside_min
           FROM visits v WHERE v.site_id = $1 AND ${DAY}`, args),
      pool.query(
        `SELECT count(*)::int AS issued,
                count(*) FILTER (WHERE q.status = 'DONE')::int AS served,
                count(*) FILTER (WHERE q.status = 'SKIPPED')::int AS skipped,
                count(*) FILTER (WHERE q.status IN ('WAITING','CALLED','SERVING'))::int AS open,
                round(avg(extract(epoch FROM q.called_at - q.issued_at) / 60))::int AS avg_wait,
                round((percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM q.called_at - q.issued_at) / 60))::numeric)::int AS p90_wait,
                count(*) FILTER (WHERE q.called_at - q.issued_at > interval '30 minutes')::int AS over_30
           FROM queue_tickets q WHERE q.site_id = $1 AND ${TDAY}`, args),
      pool.query(
        `SELECT extract(hour FROM v.checked_in_at AT TIME ZONE $3)::int AS hour, count(*)::int AS checkins,
                round(avg(extract(epoch FROM q.called_at - q.issued_at) / 60))::int AS avg_wait
           FROM visits v LEFT JOIN queue_tickets q ON q.visit_id = v.id
          WHERE v.site_id = $1 AND ${DAY} GROUP BY 1 ORDER BY 1`, args),
      pool.query(
        `SELECT st.name AS service, st.prefix, count(*)::int AS tickets,
                count(*) FILTER (WHERE q.status = 'DONE')::int AS served,
                count(*) FILTER (WHERE q.status = 'SKIPPED')::int AS skipped,
                round(avg(extract(epoch FROM q.called_at - q.issued_at) / 60))::int AS avg_wait,
                round(max(extract(epoch FROM q.called_at - q.issued_at) / 60))::int AS max_wait,
                round(avg(extract(epoch FROM q.done_at - q.called_at) / 60) FILTER (WHERE q.status = 'DONE'))::int AS avg_service
           FROM queue_tickets q JOIN service_types st ON st.id = q.service_type_id
          WHERE q.site_id = $1 AND ${TDAY} GROUP BY st.name, st.prefix ORDER BY tickets DESC`, args),
      pool.query(
        `SELECT count(*)::int AS booked,
                count(*) FILTER (WHERE status = 'SERVED')::int AS served,
                count(*) FILTER (WHERE status = 'NO_SHOW')::int AS no_show,
                count(*) FILTER (WHERE status = 'CHECKED_IN')::int AS checked_in,
                count(*) FILTER (WHERE status = 'BOOKED')::int AS pending
           FROM appointments WHERE site_id = $1 AND (scheduled_for AT TIME ZONE $3)::date = $2::date`, args),
      pool.query(
        `SELECT d.name AS department, count(*)::int AS visits
           FROM visits v JOIN departments d ON d.id = v.department_id
          WHERE v.site_id = $1 AND ${DAY} GROUP BY d.name ORDER BY visits DESC`, args),
      pool.query(
        `SELECT g.day::date::text AS date,
                (SELECT count(*)::int FROM visits v WHERE v.site_id = $1 AND (v.checked_in_at AT TIME ZONE $3)::date = g.day::date) AS visits,
                (SELECT round(avg(extract(epoch FROM q.called_at - q.issued_at) / 60))::int FROM queue_tickets q
                  WHERE q.site_id = $1 AND (q.issued_at AT TIME ZONE $3)::date = g.day::date) AS avg_wait
           FROM generate_series($2::date - 13, $2::date, interval '1 day') AS g(day) ORDER BY 1`, args),
    ]);

    const t = totals.rows[0];
    const k = tickets.rows[0];
    const hours = byHour.rows;
    const peak = hours.reduce((best, h) => (h.checkins > (best?.checkins ?? -1) ? h : best), null);
    await audit(pool, req, { action: 'VIEW_REPORT', entity: 'sites', entityId: siteId, details: { date } });
    res.json({
      date,
      site: site.rows[0]?.name,
      totals: {
        visits: t.visits, uniquePeople: t.people, serviceVisits: t.with_ticket, visitorVisits: t.visitors,
        reasonNotGiven: t.visits - t.with_ticket - t.visitors,
        stillInside: t.still_inside, autoClosed: t.auto_closed, avgInsideMin: t.avg_inside_min,
        ticketsIssued: k.issued, served: k.served, skipped: k.skipped, openTickets: k.open,
        avgWaitMin: k.avg_wait, p90WaitMin: k.p90_wait, waitsOver30: k.over_30,
      },
      peakHour: peak ? { hour: peak.hour, checkins: peak.checkins } : null,
      byHour: hours.map((h) => ({ hour: h.hour, checkins: h.checkins, avgWaitMin: h.avg_wait })),
      byService: byService.rows.map((s) => ({
        service: s.service, prefix: s.prefix, tickets: s.tickets, served: s.served, skipped: s.skipped,
        avgWaitMin: s.avg_wait, maxWaitMin: s.max_wait, avgServiceMin: s.avg_service,
      })),
      appointments: {
        booked: appts.rows[0].booked, served: appts.rows[0].served, noShow: appts.rows[0].no_show,
        checkedIn: appts.rows[0].checked_in, pending: appts.rows[0].pending,
      },
      byDepartment: byDept.rows,
      trend: trend.rows.map((r) => ({ date: r.date, visits: r.visits, avgWaitMin: r.avg_wait })),
    });
  }),
);
