-- Walk-in visitors who come to see an office or a person (not queueing for a service)

CREATE TABLE departments (
  id      SERIAL PRIMARY KEY,
  site_id INT NOT NULL REFERENCES sites(id),
  name    TEXT NOT NULL,
  active  BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (site_id, name)
);

ALTER TABLE visits
  ADD COLUMN department_id INT REFERENCES departments(id),
  ADD COLUMN host_name TEXT CHECK (host_name IS NULL OR length(host_name) <= 80);

-- Default offices for sites that already exist (demo data; admins can rename them later)
INSERT INTO departments (site_id, name)
SELECT s.id, d.name
  FROM sites s
 CROSS JOIN (VALUES ('Civil registration office'), ('Immigration office'), ('District Commissioner'),
                    ('Human resources'), ('Accounts')) AS d(name)
ON CONFLICT DO NOTHING;
