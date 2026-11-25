# Gov ID Check-in — Phase 1

API for scanning an Omang or passport at a government building entrance, logging the visit, and
putting appointment holders straight into the queue. Runs on mock citizen data.

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

## Tests

```bash
createdb govcheckin_test
TEST_DATABASE_URL=postgres://...@localhost/govcheckin_test npm test
```

19 end-to-end tests run against a real Postgres database. They cover login, roles, QR and MRZ check-in,
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

## Next (Phase 2)

- A web check-in page that scans QR codes with a webcam.
- An Android station app that reads the MRZ with the camera and the passport chip over NFC.
- A live occupancy dashboard over WebSockets.
