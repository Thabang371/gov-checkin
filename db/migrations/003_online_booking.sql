-- Online booking for citizens, and recording when reception fills in a visitor's reason

-- How many people can book the same 20-minute slot for a service at one site
ALTER TABLE service_types ADD COLUMN slot_capacity INT NOT NULL DEFAULT 2 CHECK (slot_capacity BETWEEN 0 AND 50);

ALTER TABLE appointments
  ADD COLUMN source TEXT NOT NULL DEFAULT 'STAFF' CHECK (source IN ('STAFF', 'ONLINE')),
  ADD COLUMN cancelled_at TIMESTAMPTZ;

CREATE INDEX appointments_slot ON appointments (site_id, service_type_id, scheduled_for)
  WHERE status IN ('BOOKED', 'CHECKED_IN', 'SERVED');

-- Who set the reason for a visit when the visitor didn't (NULL = the visitor chose it at the station)
ALTER TABLE visits ADD COLUMN reason_added_by INT REFERENCES staff_users(id);
