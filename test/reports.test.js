import './setup-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { createApp } from '../src/app.js';
import { closeEvents } from '../src/events.js';
import { seed } from '../db/seed.js';
import { runMigrations } from '../db/migrate.js';
import { addDemoHistory } from '../db/demo-history.js';
import { resetDb } from './reset-db.js';

const PASSWORD = 'Test-Password-1';
let server, base, data, reception, siteAdmin, officer;

async function call(method, url, { token, station, body, raw } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (station) headers['x-station-key'] = station;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: res.status, text: await res.text(), headers: res.headers };
  return { status: res.status, body: await res.json().catch(() => null) };
}
const login = async (email) => (await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } })).body.token;
const checkin = (i, extra = {}) => call('POST', '/api/checkins', { station: data.stations[0].key, body: { method: 'QR', qr: data.citizens[i].qr, ...extra } });
const today = async () => (await pool.query(`SELECT (now() AT TIME ZONE 'Africa/Gaborone')::date::text AS d`)).rows[0].d;

before(async () => {
  await resetDb();
  data = await seed({ password: PASSWORD, writeFiles: false });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  reception = await login('reception.gaborone@govcheckin.test');
  siteAdmin = await login('siteadmin.gaborone@govcheckin.test');
  officer = await login('officer.gaborone@govcheckin.test');
});
after(async () => {
  server?.closeAllConnections?.();
  server?.close();
  await closeEvents();
  await pool.end();
});

test('migrations are recorded and running them again changes nothing', async () => {
  const client = await pool.connect();
  try {
    assert.equal(await runMigrations(client), 0);
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    assert.ok(rows.some((r) => r.name === '002_visitor_register.sql'));
  } finally {
    client.release();
  }
});

test('a walk-in visitor scans, picks an office, and is logged without a ticket', async () => {
  const deps = await call('GET', `/api/sites/${data.siteIds[0]}/departments`, { station: data.stations[0].key });
  assert.equal(deps.status, 200);
  assert.equal(deps.body.length, 5);
  const r = await checkin(140);
  assert.equal(r.body.needsService, true);
  const hr = deps.body.find((d) => d.name === 'Human resources');
  const p = await call('POST', `/api/visits/${r.body.visit.id}/purpose`, { station: data.stations[0].key, body: { departmentId: hr.id, hostName: '  Ms   Kgosana ' } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.hostName, 'Ms Kgosana');
  const { rows } = await pool.query('SELECT department_id, host_name FROM visits WHERE id = $1', [r.body.visit.id]);
  assert.equal(rows[0].department_id, hr.id);
  const tickets = await pool.query('SELECT count(*)::int AS n FROM queue_tickets WHERE visit_id = $1', [r.body.visit.id]);
  assert.equal(tickets.rows[0].n, 0);
});

test('an office from another site is refused, and a queued visit cannot become a visitor', async () => {
  const otherSiteDept = (await pool.query('SELECT id FROM departments WHERE site_id = $1 LIMIT 1', [data.siteIds[1]])).rows[0].id;
  const r = await checkin(141);
  const bad = await call('POST', `/api/visits/${r.body.visit.id}/purpose`, { station: data.stations[0].key, body: { departmentId: otherSiteDept } });
  assert.equal(bad.status, 400);
  const queued = await checkin(142, { serviceTypeId: data.serviceIds.ENQUIRY });
  const dep = (await call('GET', `/api/sites/${data.siteIds[0]}/departments`, { token: reception })).body[0];
  const busy = await call('POST', `/api/visits/${queued.body.visit.id}/purpose`, { token: reception, body: { departmentId: dep.id } });
  assert.equal(busy.status, 409);
});

test('the visitor register lists everyone today with their reason; reception is limited to today', async () => {
  const reg = await call('GET', `/api/sites/${data.siteIds[0]}/register`, { token: reception });
  assert.equal(reg.status, 200);
  assert.equal(reg.body.count, 3);
  const visitor = reg.body.rows.find((x) => x.kind === 'visitor');
  assert.equal(visitor.reason, 'Visiting: Human resources (Ms Kgosana)');
  assert.ok(reg.body.rows.some((x) => x.reason === 'General enquiry' && x.ticketNo === 'F001'));
  assert.ok(reg.body.rows.some((x) => x.reason === 'Not given'));
  const old = await call('GET', `/api/sites/${data.siteIds[0]}/register?date=2026-01-05`, { token: reception });
  assert.equal(old.status, 403);
  assert.equal((await call('GET', `/api/sites/${data.siteIds[0]}/register?date=2026-01-05`, { token: siteAdmin })).status, 200);
  assert.equal((await call('GET', `/api/sites/${data.siteIds[0]}/register`, { token: officer })).status, 403);
  assert.equal((await call('GET', `/api/sites/${data.siteIds[1]}/register`, { token: reception })).status, 403);
});

test('the register downloads as CSV, safe to open in Excel, and the export is audited', async () => {
  // A name that would run as a formula in Excel if not neutralised
  await call('POST', '/api/checkins', {
    station: data.stations[0].key,
    body: { method: 'MRZ', idType: 'PASSPORT', idNumber: 'ZX1234567', fullName: '=HYPERLINK("x") Evil', nationality: 'ZAF' },
  });
  const r = await call('GET', `/api/sites/${data.siteIds[0]}/register?format=csv`, { token: reception, raw: true });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /visitor-register-site\d+-\d{4}-\d{2}-\d{2}\.csv/);
  const lines = r.text.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines[0].split(',')[3], 'Name');
  assert.equal(lines.length, 5); // header + 4 people
  assert.ok(lines.some((l) => l.includes(`"'=HYPERLINK(""x"") Evil"`)), 'formula must be neutralised');
  const a = await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'EXPORT_REGISTER'`);
  assert.equal(a.rows[0].n, 1);
});

test('daily report numbers match what happened today', async () => {
  // Serve the F001 enquiry so the report has a finished ticket
  const anyDesk = (await call('GET', `/api/sites/${data.siteIds[0]}/desks`, { token: officer })).body.find((d) => d.serviceTypeId === null);
  const c = await call('POST', `/api/desks/${anyDesk.id}/call-next`, { token: officer });
  await call('PATCH', `/api/tickets/${c.body.ticket.id}`, { token: officer, body: { status: 'DONE' } });

  const r = await call('GET', `/api/sites/${data.siteIds[0]}/report`, { token: siteAdmin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = r.body.totals;
  assert.equal(t.visits, 4);
  assert.equal(t.visitorVisits, 1);
  assert.equal(t.serviceVisits, 1);
  assert.equal(t.reasonNotGiven, 2); // scanned in but never picked a service or office
  assert.equal(t.ticketsIssued, 1);
  assert.equal(t.served, 1);
  assert.equal(t.stillInside, 4);
  assert.equal(r.body.byService[0].service, 'General enquiry');
  assert.equal(r.body.byDepartment[0].department, 'Human resources');
  assert.equal(r.body.trend.length, 14);
  assert.equal(r.body.trend.at(-1).date, await today());
  assert.equal(r.body.trend.at(-1).visits, 4);
  assert.equal(r.body.appointments.booked, 25); // seed books 25 for today
  const sumHours = r.body.byHour.reduce((a, h) => a + h.checkins, 0);
  assert.equal(sumHours, 4);
});

test('only admins can see the report', async () => {
  assert.equal((await call('GET', `/api/sites/${data.siteIds[0]}/report`, { token: reception })).status, 403);
  assert.equal((await call('GET', `/api/sites/${data.siteIds[0]}/report`, { token: officer })).status, 403);
  assert.equal((await call('GET', `/api/sites/${data.siteIds[0]}/report?date=nope`, { token: siteAdmin })).status, 400);
});

test('demo history fills past days, gives a sensible report, and refuses to run twice', async () => {
  const h = await addDemoHistory({ siteId: data.siteIds[0], days: 7 });
  assert.ok(h.visits > 300, `expected a few hundred visits, got ${h.visits}`);
  await assert.rejects(addDemoHistory({ siteId: data.siteIds[0], days: 7 }), /already has visits/);
  const days = (await call('GET', `/api/sites/${data.siteIds[0]}/report`, { token: siteAdmin })).body.trend;
  const busy = days.filter((d) => d.visits > 0 && d.date !== days.at(-1).date);
  assert.ok(busy.length >= 5);
  const sample = busy[0];
  const r = (await call('GET', `/api/sites/${data.siteIds[0]}/report?date=${sample.date}`, { token: siteAdmin })).body;
  assert.equal(r.totals.visits, sample.visits);
  assert.equal(r.totals.stillInside, 0);
  assert.ok(r.totals.avgWaitMin > 5 && r.totals.avgWaitMin < 40);
  assert.ok(r.peakHour.hour >= 8 && r.peakHour.hour <= 14);
});
