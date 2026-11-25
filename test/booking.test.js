import './setup-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { pool } from '../src/db.js';
import { createApp } from '../src/app.js';
import { closeEvents } from '../src/events.js';
import { seed } from '../db/seed.js';
import { resetDb } from './reset-db.js';

const PASSWORD = 'Test-Password-1';
let server, base, data, options, reception;

async function call(method, url, { token, station, body, raw } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (station) headers['x-station-key'] = station;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function citizen(i) {
  const c = data.citizens[i];
  const r = await call('POST', '/api/public/verify', { body: { idType: c.idType, idNumber: c.idNumber, dateOfBirth: c.dateOfBirth } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}
const futureDay = () => options.days.find((d) => d !== options.days[0] && new Date(`${d}T12:00:00Z`).getUTCDay() !== 6);
const svc = (code) => options.services.find((s) => s.id === data.serviceIds[code]);

before(async () => {
  await resetDb();
  data = await seed({ password: PASSWORD, writeFiles: false });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  options = (await call('GET', '/api/public/options')).body;
  reception = (await call('POST', '/api/auth/login', { body: { email: 'reception.gaborone@govcheckin.test', password: PASSWORD } })).body.token;
});
after(async () => {
  server?.closeAllConnections?.();
  server?.close();
  await closeEvents();
  await pool.end();
});

test('booking options: offices, bookable services and the next two weeks', () => {
  assert.equal(options.sites.length, 3);
  assert.equal(options.services.length, 5); // general enquiry is walk-in only
  assert.ok(!options.services.some((s) => s.name === 'General enquiry'));
  assert.ok(options.days.length >= 11 && options.days.length <= 15);
  assert.ok(options.days.every((d) => new Date(`${d}T12:00:00Z`).getUTCDay() !== 0), 'no Sundays');
});

test("wrong details get the same answer whether the ID or the birthday is wrong", async () => {
  const c = data.citizens[60];
  const wrongDob = await call('POST', '/api/public/verify', { body: { idType: c.idType, idNumber: c.idNumber, dateOfBirth: '1900-01-01' } });
  const unknownId = await call('POST', '/api/public/verify', { body: { idType: 'OMANG', idNumber: '999919999', dateOfBirth: c.dateOfBirth } });
  assert.equal(wrongDob.status, 401);
  assert.equal(unknownId.status, 401);
  assert.equal(wrongDob.body.error, unknownId.body.error);
});

test('citizen and staff tokens cannot be swapped', async () => {
  const t = await citizen(60);
  assert.equal((await call('GET', '/api/auth/me', { token: t })).status, 401);
  assert.equal((await call('GET', `/api/sites/${data.siteIds[0]}/queue`, { token: t })).status, 401);
  assert.equal((await call('GET', '/api/public/bookings', { token: reception })).status, 401);
  assert.equal((await call('GET', '/api/public/bookings')).status, 401);
});

test('book a slot, see it, and the slot count goes down', async () => {
  const t = await citizen(60);
  const day = futureDay();
  const s = svc('PASSPORT_NEW');
  const before = (await call('GET', `/api/public/slots?siteId=${data.siteIds[0]}&serviceTypeId=${s.id}&date=${day}`, { token: t })).body.slots;
  assert.equal(before.find((x) => x.time === '09:00').available, 2);
  const b = await call('POST', '/api/public/bookings', { token: t, body: { siteId: data.siteIds[0], serviceTypeId: s.id, date: day, time: '09:00' } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.match(b.body.bookingRef, /^APT-[A-HJ-NP-Z2-9]{6}$/);
  const mine = (await call('GET', '/api/public/bookings', { token: t })).body;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].time, '09:00');
  const after = (await call('GET', `/api/public/slots?siteId=${data.siteIds[0]}&serviceTypeId=${s.id}&date=${day}`, { token: t })).body.slots;
  assert.equal(after.find((x) => x.time === '09:00').available, 1);
  const row = (await pool.query('SELECT source FROM appointments WHERE booking_ref = $1', [b.body.bookingRef])).rows[0];
  assert.equal(row.source, 'ONLINE');
});

test('a full slot refuses more bookings; one booking per service; at most two upcoming', async () => {
  const day = futureDay();
  const s = svc('PASSPORT_NEW');
  const t61 = await citizen(61);
  const ok = await call('POST', '/api/public/bookings', { token: t61, body: { siteId: data.siteIds[0], serviceTypeId: s.id, date: day, time: '09:00' } });
  assert.equal(ok.status, 201);
  const t62 = await citizen(62);
  const full = await call('POST', '/api/public/bookings', { token: t62, body: { siteId: data.siteIds[0], serviceTypeId: s.id, date: day, time: '09:00' } });
  assert.equal(full.status, 409);
  assert.match(full.body.error, /taken/);

  const again = await call('POST', '/api/public/bookings', { token: t61, body: { siteId: data.siteIds[0], serviceTypeId: s.id, date: day, time: '10:00' } });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already have a booking/);

  const second = await call('POST', '/api/public/bookings', { token: t61, body: { siteId: data.siteIds[0], serviceTypeId: svc('OMANG_RENEW').id, date: day, time: '10:00' } });
  assert.equal(second.status, 201);
  const third = await call('POST', '/api/public/bookings', { token: t61, body: { siteId: data.siteIds[0], serviceTypeId: svc('BIRTH_CERT').id, date: day, time: '10:00' } });
  assert.equal(third.status, 409);
  assert.match(third.body.error, /at most 2/);
});

test('times outside opening hours, Sundays and enquiries are refused', async () => {
  const t = await citizen(63);
  const day = futureDay();
  const bad = async (body) => (await call('POST', '/api/public/bookings', { token: t, body: { siteId: data.siteIds[0], serviceTypeId: svc('OMANG_NEW').id, date: day, time: '09:00', ...body } })).status;
  assert.equal(await bad({ time: '18:00' }), 400);
  assert.equal(await bad({ time: '09:10' }), 400); // not on the 20-minute grid
  assert.equal(await bad({ date: '2020-01-06' }), 400); // in the past
  assert.equal(await bad({ serviceTypeId: data.serviceIds.ENQUIRY }), 400);
});

test("you can cancel your own booking but not someone else's", async () => {
  const t60 = await citizen(60);
  const t63 = await citizen(63);
  const ref = (await call('GET', '/api/public/bookings', { token: t60 })).body[0].bookingRef;
  assert.equal((await call('DELETE', `/api/public/bookings/${ref}`, { token: t63 })).status, 404);
  const c = await call('DELETE', `/api/public/bookings/${ref}`, { token: t60 });
  assert.equal(c.status, 200);
  assert.equal((await call('DELETE', `/api/public/bookings/${ref}`, { token: t60 })).status, 409);
  // The slot is free again: someone else can take it now
  const t62 = await citizen(62);
  const taken = await call('POST', '/api/public/bookings', { token: t62, body: { siteId: data.siteIds[0], serviceTypeId: svc('PASSPORT_NEW').id, date: futureDay(), time: '09:00' } });
  assert.equal(taken.status, 201);
});

test('three people racing for a two-person slot: exactly two get it', async () => {
  const tokens = await Promise.all([64, 65, 66].map((i) => citizen(i)));
  const day = futureDay();
  const results = await Promise.all(tokens.map((t) => call('POST', '/api/public/bookings', {
    token: t, body: { siteId: data.siteIds[1], serviceTypeId: svc('OMANG_NEW').id, date: day, time: '11:00' },
  })));
  assert.equal(results.filter((r) => r.status === 201).length, 2);
  assert.equal(results.filter((r) => r.status === 409).length, 1);
});

test('the visitor register downloads as a formatted Excel file', async () => {
  // One visitor, one reason added by reception
  const st = data.stations[0].key;
  const a = await call('POST', '/api/checkins', { station: st, body: { method: 'QR', qr: data.citizens[150].qr } });
  const deps = (await call('GET', `/api/sites/${data.siteIds[0]}/departments`, { token: reception })).body;
  const p = await call('POST', `/api/visits/${a.body.visit.id}/purpose`, { token: reception, body: { departmentId: deps[0].id } });
  assert.equal(p.status, 200);
  const b = await call('POST', '/api/checkins', { station: st, body: { method: 'QR', qr: data.citizens[151].qr } });
  const tk = await call('POST', `/api/visits/${b.body.visit.id}/ticket`, { token: reception, body: { serviceTypeId: data.serviceIds.OMANG_NEW } });
  assert.equal(tk.status, 201);

  const reg = (await call('GET', `/api/sites/${data.siteIds[0]}/register`, { token: reception })).body;
  assert.equal(reg.rows.find((r) => r.visitId === a.body.visit.id).reasonAddedBy, 'Reception gaborone');
  assert.equal(reg.rows.find((r) => r.visitId === b.body.visit.id).reasonAddedBy, 'Reception gaborone');

  const x = await call('GET', `/api/sites/${data.siteIds[0]}/register?format=xlsx`, { token: reception, raw: true });
  assert.equal(x.status, 200);
  assert.match(x.headers.get('content-type'), /spreadsheetml/);
  assert.match(x.headers.get('content-disposition'), /\.xlsx"/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.buf);
  const ws = wb.getWorksheet('Visitor register');
  assert.match(ws.getCell('A1').value, /^Visitor register: Gaborone/);
  assert.equal(ws.getCell('D4').value, 'Name');
  assert.equal(ws.getRow(4).font.bold, true);
  assert.equal(ws.views[0].ySplit, 4); // header stays visible when scrolling
  assert.equal(ws.rowCount, 4 + 2);
  assert.equal(ws.getCell('D5').value, data.citizens[150].fullName);
  assert.match(String(ws.getCell('L5').value), /Reason added by Reception gaborone/);
  assert.equal(typeof ws.getCell('F5').value, 'string'); // last 4 kept as text (keeps leading zeros)
});
