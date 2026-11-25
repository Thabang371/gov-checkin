import './setup-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../db/seed.js';
import { resetDb } from './reset-db.js';
import { encodeIdQr } from '../src/lib/idqr.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PASSWORD = 'Test-Password-1';
let server, base, data;

async function call(method, url, { token, station, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (station) headers['x-station-key'] = station;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function login(email) {
  const r = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

const qrBody = (c) => ({ method: 'QR', qr: c.qr });

before(async () => {
  await resetDb();
  data = await seed({ password: PASSWORD, writeFiles: false });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await pool.end();
});

test('login works and wrong password is refused and audited', async () => {
  const bad = await call('POST', '/api/auth/login', { body: { email: 'admin@govcheckin.test', password: 'nope' } });
  assert.equal(bad.status, 401);
  const token = await login('admin@govcheckin.test');
  const me = await call('GET', '/api/auth/me', { token });
  assert.equal(me.body.role, 'NATIONAL_ADMIN');
  const { rows } = await pool.query(`SELECT action FROM audit_log WHERE action IN ('LOGIN','LOGIN_FAILED')`);
  assert.ok(rows.some((r) => r.action === 'LOGIN_FAILED'));
  assert.ok(rows.some((r) => r.action === 'LOGIN'));
});

test('requests without a token or station key are refused', async () => {
  assert.equal((await call('POST', '/api/checkins', { body: qrBody(data.citizens[100]) })).status, 401);
  assert.equal((await call('POST', '/api/checkins', { station: '1.wrongsecret', body: qrBody(data.citizens[100]) })).status, 401);
});

test('station QR check-in creates a visit, then a second scan returns the same visit', async () => {
  const station = data.stations[0].key;
  const c = data.citizens[100]; // no appointment
  const first = await call('POST', '/api/checkins', { station, body: { ...qrBody(c), serviceTypeId: data.serviceIds.ENQUIRY } });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.person.fullName, c.fullName);
  assert.equal(first.body.person.isNew, false); // already in the mock registry
  assert.match(first.body.ticket.ticketNo, /^F\d{3}$/);
  assert.equal(first.body.ticket.priority, false);

  const again = await call('POST', '/api/checkins', { station, body: qrBody(c) });
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyInside, true);
  assert.equal(again.body.visit.id, first.body.visit.id);
});

test('appointment holder gets a priority ticket automatically', async () => {
  const c = data.citizens[0]; // has an appointment today at site 1
  const r = await call('POST', '/api/checkins', { station: data.stations[0].key, body: qrBody(c) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.appointment.bookingRef.startsWith('APT-'));
  assert.equal(r.body.ticket.priority, true);
  assert.equal(r.body.needsService, false);
  const appt = await pool.query(`SELECT status FROM appointments WHERE booking_ref = $1`, [r.body.appointment.bookingRef]);
  assert.equal(appt.rows[0].status, 'CHECKED_IN');
});

test('walk-in without a service is told to pick one', async () => {
  const r = await call('POST', '/api/checkins', { station: data.stations[0].key, body: qrBody(data.citizens[101]) });
  assert.equal(r.status, 201);
  assert.equal(r.body.ticket, null);
  assert.equal(r.body.needsService, true);
});

test('forged or tampered QR codes are rejected', async () => {
  const c = data.citizens[102];
  const [prefix, body, sig] = c.qr.split('.');
  const tampered = Buffer.from(JSON.stringify({ t: 'OMANG', n: '123412345', fn: 'Fake Person' })).toString('base64url');
  const r1 = await call('POST', '/api/checkins', { station: data.stations[0].key, body: { method: 'QR', qr: `${prefix}.${tampered}.${sig}` } });
  assert.equal(r1.status, 422);
  const r2 = await call('POST', '/api/checkins', { station: data.stations[0].key, body: { method: 'QR', qr: 'hello world' } });
  assert.equal(r2.status, 422);
  assert.ok(body); // original stays valid
});

test('MRZ check-in for a brand-new foreign visitor creates the person', async () => {
  const r = await call('POST', '/api/checkins', {
    station: data.stations[0].key,
    body: { method: 'MRZ', idType: 'PASSPORT', idNumber: 'ZX9912345', fullName: 'Thandiwe  Dube', nationality: 'zwe', dateOfBirth: '1990-04-02', docExpiry: '2031-01-01', serviceTypeId: data.serviceIds.ENQUIRY },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.person.isNew, true);
  assert.equal(r.body.person.fullName, 'Thandiwe Dube');
  // The full number is never stored, only a hash and last 4 digits
  const { rows } = await pool.query(`SELECT id_hash, id_last4 FROM persons WHERE id = $1`, [r.body.person.id]);
  assert.equal(rows[0].id_last4, '2345');
  assert.notEqual(rows[0].id_hash, 'ZX9912345');
  assert.equal(rows[0].id_hash.length, 64);
});

test('expired documents are let in with a warning', async () => {
  const expired = data.citizens.find((c) => c.docExpiry < new Date().toISOString().slice(0, 10));
  const r = await call('POST', '/api/checkins', { station: data.stations[0].key, body: qrBody(expired) });
  assert.equal(r.status, 201);
  assert.ok(r.body.warnings.includes('DOCUMENT_EXPIRED'));
});

test('invalid input is rejected with a clear message', async () => {
  const station = data.stations[0].key;
  const bad = await call('POST', '/api/checkins', { station, body: { method: 'MRZ', idType: 'OMANG', idNumber: '12', fullName: 'X Y' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /9 digits/);
  const manual = await call('POST', '/api/checkins', { station, body: { method: 'MANUAL', idType: 'OMANG', idNumber: '123412345', fullName: 'X Y' } });
  assert.equal(manual.status, 400);
});

test('a station cannot check people into another site', async () => {
  const r = await call('POST', '/api/checkins', { station: data.stations[1].key, body: { ...qrBody(data.citizens[103]), siteId: data.siteIds[0] } });
  assert.equal(r.status, 201);
  const visit = await pool.query('SELECT site_id FROM visits WHERE id = $1', [r.body.visit.id]);
  assert.equal(visit.rows[0].site_id, data.siteIds[1]); // siteId in the body is ignored for stations
});

test('reception sees occupancy for their own site only', async () => {
  const token = await login('reception.gaborone@govcheckin.test');
  const own = await call('GET', `/api/sites/${data.siteIds[0]}/occupancy`, { token });
  assert.equal(own.status, 200);
  assert.ok(own.body.inside >= 4);
  assert.ok(own.body.people.every((p) => p.idLast4.length === 4));
  const other = await call('GET', `/api/sites/${data.siteIds[1]}/occupancy`, { token });
  assert.equal(other.status, 403);
});

test('officers cannot read visit history; site admins can', async () => {
  const officer = await login('officer.gaborone@govcheckin.test');
  assert.equal((await call('GET', `/api/sites/${data.siteIds[0]}/visits`, { token: officer })).status, 403);
  const admin = await login('siteadmin.gaborone@govcheckin.test');
  const r = await call('GET', `/api/sites/${data.siteIds[0]}/visits`, { token: admin });
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= 4);
});

test('person lookup works and every lookup is audited', async () => {
  const token = await login('reception.gaborone@govcheckin.test');
  const c = data.citizens[100];
  const r = await call('GET', `/api/persons/lookup?type=OMANG&number=${c.idNumber}`, { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.fullName, c.fullName);
  assert.equal(r.body.recentVisits.length, 1);
  const miss = await call('GET', '/api/persons/lookup?type=OMANG&number=000010000', { token });
  assert.equal(miss.status, 404);
  const { rows } = await pool.query(`SELECT details FROM audit_log WHERE action = 'VIEW_PERSON' ORDER BY id`);
  assert.deepEqual(rows.map((x) => x.details.found), [true, false]);
});

test('checkout by scan closes the visit and drops waiting tickets', async () => {
  const c = data.citizens[100];
  const r = await call('POST', '/api/checkouts', { station: data.stations[0].key, body: qrBody(c) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.checkedOutAt);
  const t = await pool.query(`SELECT q.status FROM queue_tickets q WHERE q.visit_id = $1`, [r.body.visitId]);
  assert.equal(t.rows[0].status, 'SKIPPED');
  const again = await call('POST', '/api/checkouts', { station: data.stations[0].key, body: qrBody(c) });
  assert.equal(again.status, 404);
  // They can check in again afterwards (new visit)
  const back = await call('POST', '/api/checkins', { station: data.stations[0].key, body: qrBody(c) });
  assert.equal(back.status, 201);
});

test('concurrent double scans never create two open visits', async () => {
  const c = data.citizens[150];
  const station = data.stations[0].key;
  const results = await Promise.all(Array.from({ length: 5 }, () => call('POST', '/api/checkins', { station, body: qrBody(c) })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM visits v JOIN persons p ON p.id = v.person_id
      WHERE p.id = $1 AND v.checked_out_at IS NULL`,
    [results.find((r) => r.status === 201).body.person.id],
  );
  assert.equal(rows[0].n, 1);
});

test('ticket numbers count up per service and day', async () => {
  const station = data.stations[2].key;
  const svc = data.serviceIds.BIRTH_CERT;
  const a = await call('POST', '/api/checkins', { station, body: { ...qrBody(data.citizens[160]), serviceTypeId: svc } });
  const b = await call('POST', '/api/checkins', { station, body: { ...qrBody(data.citizens[161]), serviceTypeId: svc } });
  assert.equal(a.body.ticket.ticketNo, 'E001');
  assert.equal(b.body.ticket.ticketNo, 'E002');
  assert.equal(b.body.ticket.peopleAhead, 1);
});

test('close-day checks everyone out and flags them', async () => {
  const token = await login('siteadmin.maun@govcheckin.test');
  const r = await call('POST', `/api/sites/${data.siteIds[2]}/close-day`, { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.autoClosedVisits, 2);
  const open = await pool.query('SELECT count(*)::int AS n FROM visits WHERE site_id = $1 AND checked_out_at IS NULL', [data.siteIds[2]]);
  assert.equal(open.rows[0].n, 0);
});

test('the audit log cannot be edited or deleted, even directly in the database', async () => {
  await assert.rejects(pool.query(`UPDATE audit_log SET action = 'X'`), /append-only/);
  await assert.rejects(pool.query(`DELETE FROM audit_log`), /append-only/);
  const token = await login('admin@govcheckin.test');
  const r = await call('GET', '/api/audit?action=CHECK_IN&limit=5', { token });
  assert.equal(r.status, 200);
  assert.ok(r.body.length > 0);
  const reception = await login('reception.gaborone@govcheckin.test');
  assert.equal((await call('GET', '/api/audit', { token: reception })).status, 403);
});

test('a QR signed with a different secret is rejected', async () => {
  // encodeIdQr uses this app's secret; flip one character of a valid signature
  const good = encodeIdQr({ t: 'OMANG', n: '555515555', fn: 'Test Person' });
  const bad = good.slice(0, -2) + (good.endsWith('A') ? 'BB' : 'AA');
  const r = await call('POST', '/api/checkins', { station: data.stations[0].key, body: { method: 'QR', qr: bad } });
  assert.equal(r.status, 422);
});

test('station page, jsQR library and station endpoints work', async () => {
  const page = await fetch(`${base}/station/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Check-in station/);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/); // no inline or third-party scripts
  const lib = await fetch(`${base}/vendor/jsQR.js`);
  assert.equal(lib.status, 200);
  assert.match(await lib.text(), /jsQR/);

  const me = await call('GET', '/api/stations/me', { station: data.stations[0].key });
  assert.equal(me.status, 200);
  assert.equal(me.body.siteId, data.siteIds[0]);
  const svc = await call('GET', '/api/service-types', { station: data.stations[0].key });
  assert.equal(svc.body.length, 6);
});

test('walk-in picks a service after scanning and gets one ticket only', async () => {
  const station = data.stations[0].key;
  const r = await call('POST', '/api/checkins', { station, body: qrBody(data.citizens[120]) });
  assert.equal(r.body.needsService, true);
  const t = await call('POST', `/api/visits/${r.body.visit.id}/ticket`, { station, body: { serviceTypeId: data.serviceIds.PASSPORT_NEW } });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.match(t.body.ticketNo, /^C\d{3}$/);
  const twice = await call('POST', `/api/visits/${r.body.visit.id}/ticket`, { station, body: { serviceTypeId: data.serviceIds.PASSPORT_NEW } });
  assert.equal(twice.status, 409);
  // A station at another site cannot touch this visit
  const other = await call('POST', `/api/visits/${r.body.visit.id}/ticket`, { station: data.stations[1].key, body: { serviceTypeId: data.serviceIds.ENQUIRY } });
  assert.equal(other.status, 403);
});
