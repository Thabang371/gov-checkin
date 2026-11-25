// Fills the last N days with made-up but realistic visits, tickets and appointments for one site,
// so the daily report has something to show in a demo. Every record is fake.
//   npm run db:demo-history            (site 1, last 14 days)
//   node db/demo-history.js 2 7        (site 2, last 7 days)
// Refuses in production and refuses if the site already has visits on those days.
import { pathToFileURL } from 'node:url';
import { pool, withTransaction } from '../src/db.js';
import { config } from '../src/config.js';

const UTC_OFFSET_H = 2; // Africa/Gaborone is UTC+2 all year (no daylight saving)

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function addDemoHistory({ siteId = 1, days = 14, seed = 1125 } = {}) {
  if (config.isProduction) throw new Error('Refusing to add demo history when NODE_ENV=production');
  const rand = rng(seed + siteId);
  const normal = (mean, sd) => {
    const u = 1 - rand();
    const v = rand();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const pickWeighted = (items) => {
    let r = rand() * items.reduce((a, i) => a + i.w, 0);
    for (const i of items) if ((r -= i.w) <= 0) return i;
    return items.at(-1);
  };

  return withTransaction(async (db) => {
    const today = (await db.query('SELECT (now() AT TIME ZONE $1)::date::text AS d', [config.timezone])).rows[0].d;
    const existing = await db.query(
      `SELECT count(*)::int AS n FROM visits WHERE site_id = $1
         AND (checked_in_at AT TIME ZONE $2)::date BETWEEN $3::date - $4::int AND $3::date - 1`,
      [siteId, config.timezone, today, days],
    );
    if (existing.rows[0].n > 0) throw new Error(`Site ${siteId} already has visits in the last ${days} days; not adding demo history.`);

    const persons = (await db.query('SELECT id FROM persons ORDER BY id')).rows.map((r) => r.id);
    const svcRows = (await db.query('SELECT id, code, avg_minutes, prefix FROM service_types')).rows;
    const byCode = Object.fromEntries(svcRows.map((r) => [r.code, r]));
    const services = [
      { w: 35, s: byCode.OMANG_RENEW }, { w: 15, s: byCode.OMANG_NEW }, { w: 18, s: byCode.PASSPORT_NEW },
      { w: 14, s: byCode.PASSPORT_RENEW }, { w: 10, s: byCode.BIRTH_CERT }, { w: 8, s: byCode.ENQUIRY },
    ].filter((x) => x.s);
    const desks = (await db.query('SELECT id, service_type_id FROM desks WHERE site_id = $1 ORDER BY id', [siteId])).rows;
    const depts = (await db.query('SELECT id FROM departments WHERE site_id = $1 ORDER BY id', [siteId])).rows.map((r) => r.id);
    const officer = (await db.query(`SELECT id FROM staff_users WHERE site_id = $1 AND role = 'OFFICER' LIMIT 1`, [siteId])).rows[0]?.id ?? null;
    const station = (await db.query('SELECT id FROM scanner_stations WHERE site_id = $1 LIMIT 1', [siteId])).rows[0]?.id ?? null;
    const hosts = ['Mr Molefe', 'Ms Kgosana', 'Mrs Seretse', 'Mr Tau', null, null, null];
    if (!persons.length || !services.length) throw new Error('Seed the database first.');

    let visitsAdded = 0;
    let apptNo = 50000;
    const [ty, tm, td] = today.split('-').map(Number);

    for (let back = days; back >= 1; back--) {
      const dayUtc = new Date(Date.UTC(ty, tm - 1, td - back));
      const dow = dayUtc.getUTCDay(); // 0 Sunday
      if (dow === 0) continue;
      const y = dayUtc.getUTCFullYear(), m = dayUtc.getUTCMonth(), d = dayUtc.getUTCDate();
      const at = (minutesFromMidnight) => new Date(Date.UTC(y, m, d, 0, Math.round(minutesFromMidnight)) - UTC_OFFSET_H * 3600e3);

      let volume = Math.round(normal(dow === 1 ? 115 : 85, 12));
      if (dow === 6) volume = Math.round(volume * 0.3);
      const shuffled = [...persons].sort(() => rand() - 0.5).slice(0, Math.min(volume, persons.length));

      // Arrivals: a morning rush around 09:00 and a smaller one after lunch
      const arrivals = shuffled.map((personId) => {
        let t = rand() < 0.6 ? normal(9 * 60, 55) : normal(13.5 * 60, 70);
        t = Math.min(Math.max(t, 7.5 * 60), 16.25 * 60);
        return { personId, t };
      }).sort((a, b) => a.t - b.t);

      const counters = {};
      for (const a of arrivals) {
        const visitor = rand() < 0.15;
        const checkIn = at(a.t);
        if (visitor) {
          const stay = Math.max(10, normal(45, 20));
          const autoClosed = rand() < 0.03;
          const out = autoClosed ? at(16.5 * 60 + 30) : at(a.t + stay);
          await db.query(
            `INSERT INTO visits (person_id, site_id, station_id, method, purpose, checked_in_at, checked_out_at, auto_closed, department_id, host_name)
             VALUES ($1, $2, $3, 'QR', 'Visiting an office', $4, $5, $6, $7, $8)`,
            [a.personId, siteId, station, checkIn, out, autoClosed, depts[Math.floor(rand() * depts.length)] ?? null, hosts[Math.floor(rand() * hosts.length)]],
          );
          visitsAdded++;
          continue;
        }

        const svc = pickWeighted(services).s;
        const hourLoad = Math.exp(-((a.t - 9.5 * 60) ** 2) / (2 * 70 ** 2)) + 0.5 * Math.exp(-((a.t - 13.75 * 60) ** 2) / (2 * 60 ** 2));
        const hasAppt = rand() < 0.2;
        let wait = Math.max(1, normal(5 + 28 * hourLoad, 5));
        if (hasAppt) wait = Math.max(1, wait * 0.35);
        const skipped = rand() < 0.07;
        const serviceMin = Math.max(2, normal(svc.avg_minutes, svc.avg_minutes * 0.3));
        const calledT = a.t + wait;
        const doneT = skipped ? calledT + 3 : calledT + serviceMin;
        const autoClosed = rand() < 0.03;
        const outT = autoClosed ? 16.5 * 60 + 30 : doneT + 1 + rand() * 7;
        const desk = desks.find((x) => x.service_type_id === svc.id) || desks.find((x) => x.service_type_id == null) || desks[0];

        const v = await db.query(
          `INSERT INTO visits (person_id, site_id, station_id, method, checked_in_at, checked_out_at, auto_closed)
           VALUES ($1, $2, $3, 'QR', $4, $5, $6) RETURNING id`,
          [a.personId, siteId, station, checkIn, at(outT), autoClosed],
        );
        let apptId = null;
        if (hasAppt) {
          const slot = Math.round((a.t - 10) / 20) * 20;
          const ap = await db.query(
            `INSERT INTO appointments (booking_ref, person_id, site_id, service_type_id, scheduled_for, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [`APT-H${apptNo++}`, a.personId, siteId, svc.id, at(slot), skipped ? 'NO_SHOW' : 'SERVED', at(slot - 3 * 24 * 60)],
          );
          apptId = ap.rows[0].id;
        }
        counters[svc.id] = (counters[svc.id] || 0) + 1;
        await db.query(
          `INSERT INTO queue_tickets (site_id, service_type_id, visit_id, appointment_id, ticket_no, priority, status,
                                      desk_id, served_by, issued_at, called_at, done_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [siteId, svc.id, v.rows[0].id, apptId, `${svc.prefix}${String(counters[svc.id]).padStart(3, '0')}`, hasAppt,
            skipped ? 'SKIPPED' : 'DONE', desk?.id ?? null, officer, checkIn, at(calledT), at(doneT)],
        );
        visitsAdded++;
      }

      // A few booked appointments where nobody turned up at all
      for (let i = 0; i < Math.round(rand() * 6); i++) {
        await db.query(
          `INSERT INTO appointments (booking_ref, person_id, site_id, service_type_id, scheduled_for, status)
           VALUES ($1, $2, $3, $4, $5, 'NO_SHOW')`,
          [`APT-H${apptNo++}`, persons[Math.floor(rand() * persons.length)], siteId, pickWeighted(services).s.id, at(8 * 60 + Math.floor(rand() * 24) * 20)],
        );
      }
    }
    return { visits: visitsAdded, days };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const siteId = Number(process.argv[2] || 1);
    const days = Number(process.argv[3] || 14);
    const r = await addDemoHistory({ siteId, days });
    console.log(`Added ${r.visits} demo visits to site ${siteId} over the last ${r.days} days.`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
