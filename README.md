# Gov ID Check-in — Phase 1

Scan an Omang or passport at a government building entrance, log the visit, queue people for service,
and call them to desks. Runs on mock citizen data.

| Page | Who | What |
| --- | --- | --- |
| `/station` | Entrance laptop/tablet | Scan ID (webcam or USB scanner), get a ticket, check out |
| `/staff` | Officers, reception, admins | Live queue, **Call next** at your desk, who's inside, check people out |
| `/screen` | TV in the waiting area | Big "Now calling" number + desk, spoken announcement, waiting counts |

**Stack:** Node.js 20+ · Express · PostgreSQL · deploys to GCP Cloud Run (same as SelemoCrm).

## Run it locally

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL and the three secrets
createdb govcheckin         # or create it in pgAdmin / Cloud SQL
npm run db:reset            # creates tables + demo data (wipes the database!)
npm run dev                 # http://localhost:8080/healthz
```

`npm run db:reset` writes `seed-output/`:

| File | What |
| --- | --- |
| `credentials.txt` | Demo staff logins and the scanner station keys |
| `qr-cards.html` | 200 printable mock ID cards with QR codes. Open in a browser and print, or scan from the screen |
| `citizens.csv` | The same people as data (ID numbers, appointments) |

## Web check-in station (webcam or USB scanner)

1. Run the server, then open **http://localhost:8080/station/** on the entrance laptop or tablet.
2. Paste a station key from `seed-output/credentials.txt`. It's saved on that device, so you only do this once.
3. Hold up a QR card from `qr-cards.html`. A printed card or a phone screen both work.

What the station does:

- **Check in:** the visitor gets a welcome, then either a priority ticket (if they have an appointment) or a list of services to pick from, which gives them a ticket number.
- **Check out:** flip to "Check out" and scan again on the way out.
- **Repeat scans:** holding the same code up again doesn't create a duplicate.
- **USB scanners:** a plug-in QR scanner that types like a keyboard also works.
- **Privacy on screen:** only the first name and surname initial are shown, for example "Kagiso M.".

The camera needs **https or localhost**. Cloud Run gives you https automatically.

## Staff dashboard and waiting-area screen

**Staff:** open **http://localhost:8080/staff** and sign in with a login from `credentials.txt`.

- **Officers** pick their desk, then press **Call next**. After that they press **Start serving** and then **Done**, or **Call again**, or **Didn't come**.
  - Appointment holders are called first.
  - A desk only calls people for its own service, unless the desk is set to "any service".
  - Two desks can never call the same person.
- **Reception** sees the queue and everyone inside the building, and can check people out.
- **Admins** see both.

**Waiting-area screen:** open **http://localhost:8080/screen** on the TV and paste a station key.

- The number that was just called fills the screen, with a chime and a spoken "Ticket B 0 0 1, please go to Desk 1".
- It shows ticket numbers and desks only, never names.

**Live updates:** every page updates within a second of any scan, call or check-out. This uses Postgres
LISTEN/NOTIFY plus Server-Sent Events, so it keeps working across several Cloud Run instances.

## Tests

```bash
createdb govcheckin_test
TEST_DATABASE_URL=postgres://...@localhost/govcheckin_test npm test
```

32 end-to-end tests run against a real Postgres database. They cover login, roles, QR and MRZ check-in,
duplicate and concurrent scans, forged QR codes, appointments, tickets, checkout, close-day and the
locked audit log.

## Try it with curl

```bash
# Staff login
curl -s localhost:8080/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"reception.gaborone@govcheckin.test","password":"<from credentials.txt>"}'

# Scanner station check-in (QR text from citizens.csv, key from credentials.txt)
curl -s localhost:8080/api/checkins -H 'content-type: application/json' \
  -H 'x-station-key: 1.<secret>' \
  -d '{"method":"QR","qr":"BWID1....","serviceTypeId":6}'

# Who is inside?
curl -s localhost:8080/api/sites/1/occupancy -H 'authorization: Bearer <token>'
```

## API (Phase 1)

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| POST | /api/auth/login | Anyone | Staff login, returns a token (rate limited, audited) |
| GET | /api/auth/me | Staff | Current user |
| POST | /api/checkins | Station, front desk | Scan in. Returns the visit, the person, and a ticket if they have an appointment or chose a service |
| POST | /api/checkouts | Station, front desk | Scan out, or `{ visitId }` from staff |
| GET | /api/sites | Staff | Sites you can see + how many people are inside |
| GET | /api/sites/:id/occupancy | Front desk | Everyone inside now |
| GET | /api/sites/:id/visits?from=&to= | Admins | Visit history (audited) |
| POST | /api/sites/:id/close-day | Admins | Check out everyone left, mark missed appointments as NO_SHOW |
| GET | /api/persons/lookup?type=&number= | Front desk | Find a person by ID (audited, found or not) |
| GET | /api/audit | National admin | Read the audit log |
| GET | /api/stations/me | Station | Check the station key, get its site |
| GET | /api/service-types | Station, staff | Services a visitor can pick |
| POST | /api/visits/:id/ticket | Station, front desk | Walk-in picks a service and gets a ticket (one per visit) |
| GET | /api/sites/:id/desks | Staff | Desks and what each is serving now |
| GET | /api/sites/:id/queue | Staff | Today's open tickets + stats (inside, waiting, served, avg wait) |
| POST | /api/desks/:id/call-next | Officers, admins | Call the next ticket for this desk (appointments first) |
| PATCH | /api/tickets/:id | Officers, admins | `SERVING`, `DONE` or `SKIPPED` |
| POST | /api/tickets/:id/recall | Officers, admins | Call the same number again on the screen |
| GET | /api/display | Station key | Waiting-area screen feed (numbers and desks only) |
| GET | /api/sites/:id/events | Staff, station | Live change events (Server-Sent Events) |

**Check-in body**

- Scan of a QR code: `{ "method": "QR", "qr": "BWID1.…" }`
- Read from a passport photo page or chip: `{ "method": "MRZ" | "NFC", "idType", "idNumber", "fullName", "dateOfBirth", "docExpiry", "nationality" }`
- Optional fields: `purpose` and `serviceTypeId`. National admins also send `siteId`.
- Staff typing an ID in by hand use `method: "MANUAL"`. Stations can't, so every station entry comes from a real scan.

**Who authenticates how**

- Scanner stations send `X-Station-Key: <stationId>.<secret>`. Each tablet has its own key, which can be revoked.
- Staff send `Authorization: Bearer <token>`.

## Privacy and security built in

- **ID numbers:** stored as an HMAC-SHA256 hash plus the last 4 digits, never in full.
- **Mock QR codes:** signed, so a QR someone makes at home is rejected. When the real Omang QR format is known, add a parser in `src/lib/idqr.js`.
- **Site scoping:** site staff only see their own site, and a station can only check people into its own site.
- **Audit log:** every login, check-in, lookup and history view is logged. The database itself blocks UPDATE, DELETE and TRUNCATE on the audit log.
- **One open visit per person per site:** a database index enforces this, so a double scan never creates a duplicate.

## Deploy to Cloud Run

```bash
gcloud run deploy gov-checkin --source . --region us-central1 \
  --add-cloudsql-instances <PROJECT:REGION:INSTANCE> \
  --set-secrets JWT_SECRET=gov-jwt:latest,ID_HASH_SECRET=gov-idhash:latest,QR_SIGNING_SECRET=gov-qr:latest,DATABASE_URL=gov-db-url:latest
```

Use a separate Cloud SQL database from SelemoCrm. In production (`NODE_ENV=production`), seeding and `db:reset` are refused.

## Layout

```
db/schema.sql         tables, indexes, audit-log lock
db/seed.js            demo sites, staff, stations, 200 citizens, appointments, applications
src/app.js            Express app + error handling
src/middleware/auth.js  staff tokens, station keys, role + site checks
src/routes/           auth, visits (check-in/out), sites, persons, audit
src/services/         identity (scan -> person), queue (tickets)
src/lib/              ID hashing, QR signing, audit helper
test/api.test.js      end-to-end tests
```

## Next

- Online appointment booking and application tracking for citizens.
- A daily report for site admins: visits, wait times, no-shows.
- An Android station app that reads the passport MRZ with the camera and the chip over NFC.
