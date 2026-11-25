import './setup-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';
import { createApp } from '../src/app.js';
import { closeEvents } from '../src/events.js';
import { seed } from '../db/seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PASSWORD = 'Test-Password-1';
let server, base, data, officer, reception, desks;

async function call(method, url, { token, station, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (station) headers['x-station-key'] = station;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function login(email) {
  const r = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  return r.body.token;
}
const checkin = (i, extra = {}) =>
  call('POST', '/api/checkins', { station: data.stations[0].key, body: { method: 'QR', qr: data.citizens[i].qr, ...extra } });

/** Opens the SSE stream and resolves with the first `change` event (or rejects after ms). */
function nextChange(url, headers, ms = 3000) {
  const ctrl = new AbortController();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ctrl.abort(); reject(new Error('no event')); }, ms);
    fetch(base + url, { headers, signal: ctrl.signal })
      .then(async (res) => {
        if (res.status !== 200) { clearTimeout(timer); return reject(new Error(`status ${res.status}`)); }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let readyResolve;
        const ready = new Promise((r) => { readyResolve = r; });
        nextChange.ready = ready;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (block.startsWith('event: ready')) readyResolve();
            if (block.startsWith('event: change')) {
              clearTimeout(timer);
              ctrl.abort();
              return resolve(JSON.parse(block.split('data: ')[1]));
            }
          }
        }
      })
      .catch((e) => { if (e.name !== 'AbortError') reject(e); });
  });
}

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query(fs.readFileSync(path.join(here, '..', 'db', 'schema.sql'), 'utf8'));
  data = await seed({ password: PASSWORD, writeFiles: false });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  officer = await login('officer.gaborone@govcheckin.test');
  reception = await login('reception.gaborone@govcheckin.test');
  desks = (await call('GET', `/api/sites/${data.siteIds[0]}/desks`, { token: officer })).body;
});

after(async () => {
  server?.closeAllConnections?.();
  server?.close();
  await closeEvents();
  await pool.end();
});

test('desks are listed for the officer\'s site', () => {
  assert.equal(desks.length, 3);
  assert.equal(desks[0].service, 'Omang renewal / replacement');
  assert.equal(desks[2].serviceTypeId, null); // "any service" desk
});

test('appointment tickets are called before earlier walk-ins of the same service', async () => {
  const svc = data.serviceIds.OMANG_RENEW;
  const omangDesk = desks.find((d) => d.serviceTypeId === svc);
  const walkIn = await checkin(100, { serviceTypeId: svc }); // arrives first, no appointment
  const appt = await checkin(4);                              // citizen 4: OMANG_RENEW appointment today
  assert.equal(appt.body.ticket.service, 'Omang renewal / replacement');
  assert.ok(walkIn.body.ticket.ticketNo < appt.body.ticket.ticketNo); // walk-in has the lower number...
  const r = await call('POST', `/api/desks/${omangDesk.id}/call-next`, { token: officer });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ticket.ticketNo, appt.body.ticket.ticketNo);    // ...but the appointment goes first
  assert.equal(r.body.ticket.priority, true);
  await call('PATCH', `/api/tickets/${r.body.ticket.id}`, { token: officer, body: { status: 'DONE' } });
  const next = await call('POST', `/api/desks/${omangDesk.id}/call-next`, { token: officer });
  assert.equal(next.body.ticket.ticketNo, walkIn.body.ticket.ticketNo);
  await call('PATCH', `/api/tickets/${next.body.ticket.id}`, { token: officer, body: { status: 'DONE' } });
});

test('a desk only calls its own service; the any-service desk takes anyone', async () => {
  const passportDesk = desks.find((d) => d.service === 'New passport');
  await checkin(101, { serviceTypeId: data.serviceIds.ENQUIRY });
  // Drain any passport tickets, then the passport desk must not take the enquiry
  for (;;) {
    const r = await call('POST', `/api/desks/${passportDesk.id}/call-next`, { token: officer });
    if (!r.body.ticket) { assert.equal(r.body.message, 'Nobody is waiting for this desk'); break; }
    await call('PATCH', `/api/tickets/${r.body.ticket.id}`, { token: officer, body: { status: 'DONE' } });
  }
  const anyDesk = desks[2];
  let got = null;
  for (let i = 0; i < 10 && !got; i++) {
    const r = await call('POST', `/api/desks/${anyDesk.id}/call-next`, { token: officer });
    if (r.body.ticket?.ticketNo.startsWith('F')) got = r.body.ticket;
    else if (r.body.ticket) await call('PATCH', `/api/tickets/${r.body.ticket.id}`, { token: officer, body: { status: 'DONE' } });
    else break;
  }
  assert.ok(got, 'any-service desk should reach the enquiry ticket');
  await call('PATCH', `/api/tickets/${got.id}`, { token: officer, body: { status: 'SKIPPED' } });
});

test('a busy desk must finish its ticket before calling the next', async () => {
  const desk = desks[0];
  await checkin(102, { serviceTypeId: data.serviceIds.OMANG_RENEW });
  await checkin(103, { serviceTypeId: data.serviceIds.OMANG_RENEW });
  const first = await call('POST', `/api/desks/${desk.id}/call-next`, { token: officer });
  assert.ok(first.body.ticket);
  const blocked = await call('POST', `/api/desks/${desk.id}/call-next`, { token: officer });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Finish/);

  // Status rules: CALLED -> SERVING -> DONE; no jumping back
  const t = first.body.ticket.id;
  assert.equal((await call('PATCH', `/api/tickets/${t}`, { token: officer, body: { status: 'SERVING' } })).status, 200);
  assert.equal((await call('PATCH', `/api/tickets/${t}`, { token: officer, body: { status: 'SKIPPED' } })).status, 409);
  assert.equal((await call('PATCH', `/api/tickets/${t}`, { token: officer, body: { status: 'DONE' } })).status, 200);
  assert.equal((await call('PATCH', `/api/tickets/${t}`, { token: officer, body: { status: 'DONE' } })).status, 409);
});

test('two desks calling at the same moment never get the same person', async () => {
  const anyDesk2 = desks[2];
  const desk1 = desks[0];
  // Free both desks
  for (const d of [desk1, anyDesk2]) {
    const q = await call('GET', `/api/sites/${data.siteIds[0]}/queue`, { token: officer });
    for (const t of q.body.tickets.filter((x) => x.deskId === d.id)) {
      await call('PATCH', `/api/tickets/${t.id}`, { token: officer, body: { status: t.status === 'CALLED' ? 'SKIPPED' : 'DONE' } });
    }
  }
  const [a, b] = await Promise.all([
    call('POST', `/api/desks/${desk1.id}/call-next`, { token: officer }),
    call('POST', `/api/desks/${anyDesk2.id}/call-next`, { token: officer }),
  ]);
  if (a.body.ticket && b.body.ticket) assert.notEqual(a.body.ticket.id, b.body.ticket.id);
});

test('reception can see the queue but cannot call tickets', async () => {
  const q = await call('GET', `/api/sites/${data.siteIds[0]}/queue`, { token: reception });
  assert.equal(q.status, 200);
  assert.ok(typeof q.body.stats.servedToday === 'number');
  assert.ok(q.body.stats.servedToday >= 2);
  const r = await call('POST', `/api/desks/${desks[0].id}/call-next`, { token: reception });
  assert.equal(r.status, 403);
});

test('serving an appointment marks it SERVED', async () => {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM appointments WHERE status = 'SERVED'`);
  assert.ok(rows[0].n >= 1);
});

test('the waiting-area display shows numbers and desks, never names', async () => {
  const r = await call('GET', '/api/display', { station: data.stations[0].key });
  assert.equal(r.status, 200);
  assert.ok(r.body.called.length > 0);
  const text = JSON.stringify(r.body);
  for (const c of data.citizens.slice(0, 110)) assert.ok(!text.includes(c.fullName), `leaked ${c.fullName}`);
  assert.equal((await call('GET', '/api/display', { token: officer })).status, 403); // staff use /queue, not the public feed
});

test('live events: a check-in reaches the dashboard stream', async () => {
  const p = nextChange(`/api/sites/${data.siteIds[0]}/events`, { authorization: `Bearer ${reception}` });
  await new Promise((r) => setTimeout(r, 300));
  await checkin(130);
  const evt = await p;
  assert.equal(evt.type, 'checkin');
  assert.equal(evt.siteId, data.siteIds[0]);
});

test('live events: a call reaches the station screen stream with the number and desk', async () => {
  await checkin(131, { serviceTypeId: data.serviceIds.ENQUIRY });
  // free the any-service desk
  const q = await call('GET', `/api/sites/${data.siteIds[0]}/queue`, { token: officer });
  for (const t of q.body.tickets.filter((x) => x.deskId === desks[2].id)) {
    await call('PATCH', `/api/tickets/${t.id}`, { token: officer, body: { status: t.status === 'CALLED' ? 'SKIPPED' : 'DONE' } });
  }
  const p = nextChange(`/api/sites/${data.siteIds[0]}/events`, { 'x-station-key': data.stations[0].key });
  await new Promise((r) => setTimeout(r, 300));
  const r = await call('POST', `/api/desks/${desks[2].id}/call-next`, { token: officer });
  const evt = await p;
  assert.equal(evt.type, 'called');
  assert.equal(evt.ticketNo, r.body.ticket.ticketNo);
  assert.equal(evt.desk, desks[2].name);
  assert.equal(evt.siteId, undefined); // stations get a trimmed event
});

test('a station cannot listen to another site', async () => {
  const res = await fetch(`${base}/api/sites/${data.siteIds[1]}/events`, { headers: { 'x-station-key': data.stations[0].key } });
  assert.equal(res.status, 403);
});
