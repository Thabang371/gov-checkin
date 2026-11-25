-- Gov ID Check-in System — Phase 1 schema (PostgreSQL 14+)
-- Apply with: npm run db:schema   (add --drop via npm run db:reset to start clean)

CREATE TYPE id_type       AS ENUM ('OMANG','PASSPORT','RESIDENCE_PERMIT');
CREATE TYPE scan_method   AS ENUM ('QR','MRZ','NFC','MANUAL');
CREATE TYPE staff_role    AS ENUM ('RECEPTION','OFFICER','SITE_ADMIN','NATIONAL_ADMIN');
CREATE TYPE appt_status   AS ENUM ('BOOKED','CHECKED_IN','SERVED','NO_SHOW','CANCELLED');
CREATE TYPE ticket_status AS ENUM ('WAITING','CALLED','SERVING','DONE','SKIPPED');

-- ---------- Places ----------
CREATE TABLE sites (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  district      TEXT NOT NULL,
  address       TEXT,
  max_occupancy INT CHECK (max_occupancy IS NULL OR max_occupancy > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE service_types (
  id          SERIAL PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,             -- e.g. OMANG_RENEW
  name        TEXT NOT NULL,
  prefix      CHAR(1) UNIQUE NOT NULL,          -- ticket letter, e.g. B -> B042
  avg_minutes INT NOT NULL DEFAULT 15 CHECK (avg_minutes > 0)
);

CREATE TABLE desks (
  id              SERIAL PRIMARY KEY,
  site_id         INT NOT NULL REFERENCES sites(id),
  service_type_id INT REFERENCES service_types(id),
  name            TEXT NOT NULL,
  UNIQUE (site_id, name)
);

CREATE TABLE scanner_stations (
  id              SERIAL PRIMARY KEY,
  site_id         INT NOT NULL REFERENCES sites(id),
  name            TEXT NOT NULL,                -- e.g. Main entrance
  device_key_hash TEXT NOT NULL,                -- sha256 of the station's random secret
  active          BOOLEAN NOT NULL DEFAULT true,
  last_seen_at    TIMESTAMPTZ
);

-- ---------- People ----------
CREATE TABLE staff_users (
  id            SERIAL PRIMARY KEY,
  site_id       INT REFERENCES sites(id),       -- NULL only for national admins
  full_name     TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          staff_role NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (role = 'NATIONAL_ADMIN' OR site_id IS NOT NULL)
);

CREATE TABLE persons (
  id            SERIAL PRIMARY KEY,
  id_type       id_type NOT NULL,
  id_hash       TEXT NOT NULL,                  -- HMAC-SHA256(normalised id number, ID_HASH_SECRET)
  id_last4      CHAR(4) NOT NULL,
  full_name     TEXT NOT NULL,
  nationality   CHAR(3),                        -- ISO 3166 alpha-3, e.g. BWA
  date_of_birth DATE,
  doc_expiry    DATE,
  phone         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id_type, id_hash)
);

-- ---------- Visits ----------
CREATE TABLE visits (
  id             BIGSERIAL PRIMARY KEY,
  person_id      INT NOT NULL REFERENCES persons(id),
  site_id        INT NOT NULL REFERENCES sites(id),
  station_id     INT REFERENCES scanner_stations(id),
  method         scan_method NOT NULL,
  purpose        TEXT,
  checked_in_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_out_at TIMESTAMPTZ,
  checked_in_by  INT REFERENCES staff_users(id),
  auto_closed    BOOLEAN NOT NULL DEFAULT false,
  CHECK (checked_out_at IS NULL OR checked_out_at >= checked_in_at)
);
-- A person can only have one open visit per site (stops double scans creating duplicates)
CREATE UNIQUE INDEX visits_one_open ON visits (person_id, site_id) WHERE checked_out_at IS NULL;
CREATE INDEX visits_inside ON visits (site_id) WHERE checked_out_at IS NULL;
CREATE INDEX visits_site_time ON visits (site_id, checked_in_at);

CREATE TABLE appointments (
  id              SERIAL PRIMARY KEY,
  booking_ref     TEXT UNIQUE NOT NULL,
  person_id       INT NOT NULL REFERENCES persons(id),
  site_id         INT NOT NULL REFERENCES sites(id),
  service_type_id INT NOT NULL REFERENCES service_types(id),
  scheduled_for   TIMESTAMPTZ NOT NULL,
  status          appt_status NOT NULL DEFAULT 'BOOKED',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX appointments_person_day ON appointments (person_id, site_id, scheduled_for);

CREATE TABLE ticket_counters (
  site_id         INT  NOT NULL REFERENCES sites(id),
  service_type_id INT  NOT NULL REFERENCES service_types(id),
  day             DATE NOT NULL,
  last_no         INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, service_type_id, day)
);

CREATE TABLE queue_tickets (
  id              BIGSERIAL PRIMARY KEY,
  site_id         INT NOT NULL REFERENCES sites(id),
  service_type_id INT NOT NULL REFERENCES service_types(id),
  visit_id        BIGINT NOT NULL REFERENCES visits(id),
  appointment_id  INT REFERENCES appointments(id),
  ticket_no       TEXT NOT NULL,                -- e.g. B042, resets daily
  priority        BOOLEAN NOT NULL DEFAULT false,  -- true = has an appointment
  status          ticket_status NOT NULL DEFAULT 'WAITING',
  desk_id         INT REFERENCES desks(id),
  served_by       INT REFERENCES staff_users(id),
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  called_at       TIMESTAMPTZ,
  done_at         TIMESTAMPTZ
);
CREATE INDEX queue_waiting ON queue_tickets (site_id, service_type_id, priority DESC, issued_at)
  WHERE status = 'WAITING';

-- ---------- Services ----------
CREATE TABLE applications (
  id           SERIAL PRIMARY KEY,
  reference_no TEXT UNIQUE NOT NULL,
  person_id    INT NOT NULL REFERENCES persons(id),
  kind         TEXT NOT NULL,                   -- OMANG_NEW, OMANG_RENEW, PASSPORT_NEW...
  status       TEXT NOT NULL DEFAULT 'SUBMITTED',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE application_events (
  id             BIGSERIAL PRIMARY KEY,
  application_id INT NOT NULL REFERENCES applications(id),
  status         TEXT NOT NULL,
  note           TEXT,
  by_user        INT REFERENCES staff_users(id),
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Control ----------
CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   INT REFERENCES staff_users(id),
  station_id INT REFERENCES scanner_stations(id),
  action     TEXT NOT NULL,                     -- LOGIN, CHECK_IN, VIEW_PERSON, ...
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  ip         INET,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  details    JSONB
);
CREATE INDEX audit_at ON audit_log (at);

-- The audit log is append-only: nobody (including the app) can edit or delete rows.
CREATE FUNCTION audit_log_block_changes() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_changes();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_changes();
