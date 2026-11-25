// Seeds a fresh database with demo data. All people, numbers and offices are made up.
// Run: npm run db:reset   (drops everything, applies the schema, then seeds)
// Writes to seed-output/: staff logins, station keys, citizens.csv and a printable QR card sheet.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { pool, withTransaction } from '../src/db.js';
import { config } from '../src/config.js';
import { hashIdNumber, last4 } from '../src/lib/idhash.js';
import { encodeIdQr } from '../src/lib/idqr.js';
import { hashStationSecret } from '../src/middleware/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Small seeded random generator so every seed produces the same people
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

const SITES = [
  { name: 'Gaborone Registration Office (Pilot)', district: 'South-East', address: 'Mock address, Gaborone', max: 150 },
  { name: 'Francistown Registration Office', district: 'North-East', address: 'Mock address, Francistown', max: 100 },
  { name: 'Maun Registration Office', district: 'North-West', address: 'Mock address, Maun', max: 60 },
];

const SERVICES = [
  { code: 'OMANG_NEW', name: 'New Omang', prefix: 'A', avg: 20 },
  { code: 'OMANG_RENEW', name: 'Omang renewal / replacement', prefix: 'B', avg: 15 },
  { code: 'PASSPORT_NEW', name: 'New passport', prefix: 'C', avg: 25 },
  { code: 'PASSPORT_RENEW', name: 'Passport renewal', prefix: 'D', avg: 20 },
  { code: 'BIRTH_CERT', name: 'Birth certificate', prefix: 'E', avg: 10 },
  { code: 'ENQUIRY', name: 'General enquiry', prefix: 'F', avg: 5 },
];

const MALE = ['Kagiso', 'Tebogo', 'Thabo', 'Mpho', 'Kabelo', 'Onalenna', 'Lesego', 'Tshepo', 'Boitumelo', 'Kgosi', 'Neo', 'Oratile', 'Katlego', 'Mothusi', 'Gaone', 'Tumelo', 'Kefilwe', 'Baboloki', 'Otsile', 'Masego'];
const FEMALE = ['Naledi', 'Lorato', 'Masego', 'Keitumetse', 'Boitshepo', 'Tlotlo', 'Refilwe', 'Amogelang', 'Kelebogile', 'Dineo', 'Goitseone', 'Mmabatho', 'Onkemetse', 'Tshegofatso', 'Lesedi', 'Bonolo', 'Gofaone', 'Kgalalelo', 'Neo', 'Tebatso'];
const SURNAMES = ['Mokgosi', 'Molefe', 'Seretse', 'Kgosana', 'Motsumi', 'Ramotswa', 'Sebina', 'Modise', 'Phiri', 'Tau', 'Masire', 'Kebonang', 'Letsholo', 'Mogae', 'Sechele', 'Moremi', 'Dintwe', 'Ntshole', 'Gabaake', 'Rantao', 'Bogatsu', 'Mmolai', 'Segwabe', 'Kgari', 'Mosweu'];
const FOREIGN = [
  { nat: 'ZAF', names: ['Sipho Ndlovu', 'Lerato Khumalo', 'Johan van Wyk'] },
  { nat: 'ZWE', names: ['Tendai Moyo', 'Rudo Chikwanha'] },
  { nat: 'NAM', names: ['Ndapewa Shikongo', 'Hendrik Kotze'] },
  { nat: 'ZMB', names: ['Mwila Banda', 'Chanda Mulenga', 'Bwalya Phiri'] },
];

const pad = (n, w) => String(n).padStart(w, '0');
const isoDate = (d) => d.toISOString().slice(0, 10);

function makeCitizens(rand) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const digits = (n) => Array.from({ length: n }, () => Math.floor(rand() * 10)).join('');
  const now = new Date();
  const people = [];
  const usedNumbers = new Set();
  const unique = (make) => {
    let n;
    do n = make();
    while (usedNumbers.has(n));
    usedNumbers.add(n);
    return n;
  };

  for (let i = 0; i < 200; i++) {
    const female = rand() < 0.5;
    const age = 16 + Math.floor(rand() * 60);
    const dob = new Date(Date.UTC(now.getUTCFullYear() - age, Math.floor(rand() * 12), 1 + Math.floor(rand() * 28)));
    // ~2.5% expired documents, the rest valid for 1-9 more years
    const expired = i % 40 === 7;
    const exp = new Date(now);
    exp.setUTCFullYear(exp.getUTCFullYear() + (expired ? -1 : 1 + Math.floor(rand() * 9)));

    let idType, idNumber, fullName, nationality;
    if (i < 170) {
      idType = 'OMANG';
      // 9 digits; mock rule: 5th digit 1 = male, 2 = female
      idNumber = unique(() => `${digits(4)}${female ? 2 : 1}${digits(4)}`);
      fullName = `${pick(female ? FEMALE : MALE)} ${pick(SURNAMES)}`;
      nationality = 'BWA';
    } else if (i < 190) {
      idType = 'PASSPORT';
      idNumber = unique(() => `BN${digits(7)}`); // mock format
      fullName = `${pick(female ? FEMALE : MALE)} ${pick(SURNAMES)}`;
      nationality = 'BWA';
    } else {
      const f = FOREIGN[i % FOREIGN.length];
      idType = 'PASSPORT';
      idNumber = unique(() => `${f.nat.slice(0, 1)}X${digits(7)}`);
      fullName = f.names[i % f.names.length];
      nationality = f.nat;
    }
    people.push({ idType, idNumber, fullName, nationality, dateOfBirth: isoDate(dob), docExpiry: isoDate(exp) });
  }
  return people;
}

/**
 * Seeds the database. Returns everything tests or demos need (station keys, citizens, staff logins).
 * Expects an empty database with the schema applied.
 */
export async function seed({ password = process.env.SEED_PASSWORD, outDir = path.join(here, '..', 'seed-output'), writeFiles = true } = {}) {
  if (config.isProduction) throw new Error('Refusing to seed demo data when NODE_ENV=production');
  const staffPassword = password || crypto.randomBytes(9).toString('base64url');
  const rand = rng(20261125);
  const citizens = makeCitizens(rand);

  const result = await withTransaction(async (db) => {
    const existing = await db.query('SELECT count(*)::int AS n FROM sites');
    if (existing.rows[0].n > 0) throw new Error('Database already has data. Run "npm run db:reset" to start clean.');

    const siteIds = [];
    for (const s of SITES) {
      const r = await db.query(
        'INSERT INTO sites (name, district, address, max_occupancy) VALUES ($1, $2, $3, $4) RETURNING id',
        [s.name, s.district, s.address, s.max],
      );
      siteIds.push(r.rows[0].id);
    }

    const serviceIds = {};
    for (const s of SERVICES) {
      const r = await db.query(
        'INSERT INTO service_types (code, name, prefix, avg_minutes) VALUES ($1, $2, $3, $4) RETURNING id',
        [s.code, s.name, s.prefix, s.avg],
      );
      serviceIds[s.code] = r.rows[0].id;
    }

    // 3 desks per site
    for (const siteId of siteIds) {
      await db.query('INSERT INTO desks (site_id, service_type_id, name) VALUES ($1, $2, $3)', [siteId, serviceIds.OMANG_RENEW, 'Desk 1 (Omang)']);
      await db.query('INSERT INTO desks (site_id, service_type_id, name) VALUES ($1, $2, $3)', [siteId, serviceIds.PASSPORT_NEW, 'Desk 2 (Passports)']);
      await db.query('INSERT INTO desks (site_id, service_type_id, name) VALUES ($1, NULL, $2)', [siteId, 'Desk 3 (Any service)']);
    }

    // One entrance station per site, each with its own random key
    const stations = [];
    for (const siteId of siteIds) {
      const secret = crypto.randomBytes(24).toString('base64url');
      const r = await db.query(
        'INSERT INTO scanner_stations (site_id, name, device_key_hash) VALUES ($1, $2, $3) RETURNING id',
        [siteId, 'Main entrance', hashStationSecret(secret)],
      );
      stations.push({ id: r.rows[0].id, siteId, name: 'Main entrance', key: `${r.rows[0].id}.${secret}` });
    }

    // Staff: one national admin + reception, officer and site admin per site
    const hash = await bcrypt.hash(staffPassword, 10);
    const staff = [{ email: 'admin@govcheckin.test', name: 'System Owner', role: 'NATIONAL_ADMIN', siteId: null }];
    const slugs = ['gaborone', 'francistown', 'maun'];
    siteIds.forEach((siteId, i) => {
      staff.push({ email: `reception.${slugs[i]}@govcheckin.test`, name: `Reception ${slugs[i]}`, role: 'RECEPTION', siteId });
      staff.push({ email: `officer.${slugs[i]}@govcheckin.test`, name: `Officer ${slugs[i]}`, role: 'OFFICER', siteId });
      staff.push({ email: `siteadmin.${slugs[i]}@govcheckin.test`, name: `Site admin ${slugs[i]}`, role: 'SITE_ADMIN', siteId });
    });
    for (const s of staff) {
      const r = await db.query(
        'INSERT INTO staff_users (site_id, full_name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [s.siteId, s.name, s.email, hash, s.role],
      );
      s.id = r.rows[0].id;
    }

    // Citizens already in the (mock) national registry
    for (const c of citizens) {
      const r = await db.query(
        `INSERT INTO persons (id_type, id_hash, id_last4, full_name, nationality, date_of_birth, doc_expiry)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [c.idType, hashIdNumber(c.idType, c.idNumber), last4(c.idNumber), c.fullName, c.nationality, c.dateOfBirth, c.docExpiry],
      );
      c.personId = r.rows[0].id;
      c.qr = encodeIdQr({ t: c.idType, n: c.idNumber, fn: c.fullName, dob: c.dateOfBirth, exp: c.docExpiry, nat: c.nationality });
    }

    // Appointments: citizens 0-24 today at the pilot site (08:00-16:00), 25-39 tomorrow
    const apptServices = ['OMANG_RENEW', 'PASSPORT_NEW', 'PASSPORT_RENEW', 'OMANG_NEW'];
    for (let i = 0; i < 40; i++) {
      const dayOffset = i < 25 ? 0 : 1;
      const minutes = 8 * 60 + ((i % 25) * 20);
      await db.query(
        `INSERT INTO appointments (booking_ref, person_id, site_id, service_type_id, scheduled_for)
         VALUES ($1, $2, $3, $4,
                 ((now() AT TIME ZONE $5)::date + $6::int + make_interval(mins => $7)) AT TIME ZONE $5)`,
        [`APT-${pad(1001 + i, 5)}`, citizens[i].personId, siteIds[0], serviceIds[apptServices[i % 4]], config.timezone, dayOffset, minutes],
      );
    }

    // Applications in different stages (status tracking only)
    const flow = ['SUBMITTED', 'VERIFIED', 'PRINTING', 'READY_FOR_COLLECTION', 'COLLECTED'];
    for (let i = 0; i < 30; i++) {
      const c = citizens[50 + i];
      const kind = c.idType === 'OMANG' ? (i % 2 ? 'OMANG_RENEW' : 'OMANG_NEW') : 'PASSPORT_RENEW';
      const stage = i % flow.length;
      const r = await db.query(
        `INSERT INTO applications (reference_no, person_id, kind, status, submitted_at)
         VALUES ($1, $2, $3, $4, now() - make_interval(days => $5)) RETURNING id`,
        [`APP-${pad(5001 + i, 6)}`, c.personId, kind, flow[stage], 3 * (stage + 1)],
      );
      for (let s = 0; s <= stage; s++) {
        await db.query(
          `INSERT INTO application_events (application_id, status, at)
           VALUES ($1, $2, now() - make_interval(days => $3))`,
          [r.rows[0].id, flow[s], 3 * (stage + 1 - s)],
        );
      }
    }

    return { siteIds, serviceIds, stations, staff };
  });

  const out = { ...result, staffPassword, citizens };
  if (writeFiles) await writeOutputs(out, outDir);
  return out;
}

async function writeOutputs({ staff, staffPassword, stations, citizens }, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  const creds = [
    'DEMO STAFF LOGINS (all share one password)',
    `Password: ${staffPassword}`,
    '',
    ...staff.map((s) => `${s.role.padEnd(15)} ${s.email}`),
    '',
    'SCANNER STATION KEYS (send as header X-Station-Key)',
    ...stations.map((s) => `Site ${s.siteId} ${s.name}: ${s.key}`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'credentials.txt'), creds);
  fs.writeFileSync(path.join(outDir, 'stations.json'), JSON.stringify(stations, null, 2));

  const csv = ['id_type,id_number,full_name,nationality,date_of_birth,doc_expiry,has_appointment_today,qr']
    .concat(
      citizens.map((c, i) =>
        [c.idType, c.idNumber, `"${c.fullName}"`, c.nationality, c.dateOfBirth, c.docExpiry, i < 25 ? 'yes' : 'no', c.qr].join(','),
      ),
    )
    .join('\n');
  fs.writeFileSync(path.join(outDir, 'citizens.csv'), csv);

  // Printable sheet of mock ID cards with QR codes
  const cards = [];
  for (const [i, c] of citizens.entries()) {
    const img = await QRCode.toDataURL(c.qr, { errorCorrectionLevel: 'M', margin: 1, width: 180 });
    cards.push(`<div class="card${c.docExpiry < isoDate(new Date()) ? ' expired' : ''}">
  <div class="top">MOCK ${c.idType === 'OMANG' ? 'OMANG' : 'PASSPORT'} · DEMO ONLY</div>
  <img src="${img}" alt="QR">
  <div class="name">${c.fullName}</div>
  <div class="meta">${c.idType} ${c.idNumber} · ${c.nationality}</div>
  <div class="meta">DOB ${c.dateOfBirth} · Exp ${c.docExpiry}${i < 25 ? ' · <b>Appt today</b>' : ''}</div>
</div>`);
  }
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Mock ID cards (demo only)</title>
<style>
body{font-family:system-ui,sans-serif;margin:16px;color:#111}
h1{font-size:18px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.card{border:1px solid #222;border-radius:10px;padding:10px;text-align:center;break-inside:avoid}
.card.expired{border-color:#b00020;background:#fff4f4}
.top{font-size:10px;letter-spacing:.08em;color:#555}.card img{width:150px;height:150px}
.name{font-weight:600;margin-top:4px}.meta{font-size:11px;color:#444}
@media print{body{margin:0}h1,p{display:none}}
</style></head><body>
<h1>Mock ID cards: ${citizens.length} demo citizens</h1>
<p>Fake people and numbers for testing the scanner. Red cards are expired. Cards marked "Appt today" have an appointment at the pilot site.</p>
<div class="grid">${cards.join('\n')}</div></body></html>`;
  fs.writeFileSync(path.join(outDir, 'qr-cards.html'), html);
}

// Run directly: node db/seed.js
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const out = await seed();
    console.log(`Seeded ${out.siteIds.length} sites, ${out.staff.length} staff, ${out.citizens.length} citizens.`);
    console.log('Logins, station keys and the QR card sheet are in seed-output/');
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
