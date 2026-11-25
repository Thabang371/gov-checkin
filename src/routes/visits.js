import { Router } from 'express';
import { withTransaction } from '../db.js';
import { config } from '../config.js';
import { asyncRoute, HttpError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { allow, assertSiteAccess, actingSiteId, FRONT_DESK } from '../middleware/auth.js';
import { readDocument, upsertPerson } from '../services/identity.js';
import { issueTicket } from '../services/queue.js';

export const visitsRouter = Router();

/**
 * POST /api/checkins
 * From a scanner station (X-Station-Key) or front-desk staff (manual entry).
 * Body: identity fields (see services/identity.js) + optional purpose, serviceTypeId, siteId (national admins only).
 */
visitsRouter.post(
  '/checkins',
  allow({ station: true, staff: FRONT_DESK }),
  asyncRoute(async (req, res) => {
    const doc = readDocument(req.body);
    if (req.station && doc.method === 'MANUAL') throw new HttpError(400, 'Stations must scan, not type, IDs');
    const siteId = actingSiteId(req, req.body.siteId);
    assertSiteAccess(req, siteId);
    const purpose = req.body.purpose ? String(req.body.purpose).slice(0, 200) : null;
    const serviceTypeId = req.body.serviceTypeId ? Number(req.body.serviceTypeId) : null;

    const result = await withTransaction(async (db) => {
      const site = await db.query('SELECT id, name, max_occupancy FROM sites WHERE id = $1', [siteId]);
      if (!site.rows[0]) throw new HttpError(404, 'Site not found');

      const person = await upsertPerson(db, doc);
      const warnings = [];
      if (doc.docExpiry) {
        const today = await db.query('SELECT (now() AT TIME ZONE $1)::date::text AS d', [config.timezone]);
        if (doc.docExpiry < today.rows[0].d) warnings.push('DOCUMENT_EXPIRED');
      }

      const inserted = await db.query(
        `INSERT INTO visits (person_id, site_id, station_id, method, purpose, checked_in_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (person_id, site_id) WHERE checked_out_at IS NULL DO NOTHING
         RETURNING id, checked_in_at`,
        [person.id, siteId, req.station?.id ?? null, doc.method, purpose, req.staff?.id ?? null],
      );

      // Already inside: a second scan returns the existing visit instead of a duplicate
      if (!inserted.rows[0]) {
        const open = await db.query(
          `SELECT v.id, v.checked_in_at,
                  (SELECT ticket_no FROM queue_tickets q WHERE q.visit_id = v.id ORDER BY q.id DESC LIMIT 1) AS ticket_no
             FROM visits v WHERE v.person_id = $1 AND v.site_id = $2 AND v.checked_out_at IS NULL`,
          [person.id, siteId],
        );
        const v = open.rows[0];
        await audit(db, req, { action: 'CHECK_IN_REPEAT', entity: 'visits', entityId: v.id });
        return {
          status: 200,
          body: {
            alreadyInside: true,
            visit: { id: Number(v.id), checkedInAt: v.checked_in_at },
            person: publicPerson(person),
            ticket: v.ticket_no ? { ticketNo: v.ticket_no } : null,
            warnings,
          },
        };
      }

      const visit = inserted.rows[0];
      const inside = await db.query(
        'SELECT count(*)::int AS n FROM visits WHERE site_id = $1 AND checked_out_at IS NULL',
        [siteId],
      );
      if (site.rows[0].max_occupancy && inside.rows[0].n > site.rows[0].max_occupancy) {
        warnings.push('OVER_CAPACITY');
      }

      // Appointment today at this site? It gets a priority ticket automatically.
      const appt = await db.query(
        `SELECT id, booking_ref, service_type_id, scheduled_for FROM appointments
          WHERE person_id = $1 AND site_id = $2 AND status = 'BOOKED'
            AND (scheduled_for AT TIME ZONE $3)::date = (now() AT TIME ZONE $3)::date
          ORDER BY scheduled_for LIMIT 1 FOR UPDATE`,
        [person.id, siteId, config.timezone],
      );

      let ticket = null;
      let appointment = null;
      if (appt.rows[0]) {
        const a = appt.rows[0];
        await db.query(`UPDATE appointments SET status = 'CHECKED_IN' WHERE id = $1`, [a.id]);
        ticket = await issueTicket(db, {
          siteId, serviceTypeId: a.service_type_id, visitId: visit.id, appointmentId: a.id, priority: true,
        });
        appointment = { bookingRef: a.booking_ref, scheduledFor: a.scheduled_for };
      } else if (serviceTypeId) {
        ticket = await issueTicket(db, { siteId, serviceTypeId, visitId: visit.id });
      }

      await audit(db, req, {
        action: 'CHECK_IN',
        entity: 'visits',
        entityId: visit.id,
        details: { method: doc.method, newPerson: person.is_new, ticket: ticket?.ticketNo ?? null, warnings },
      });

      return {
        status: 201,
        body: {
          alreadyInside: false,
          visit: { id: Number(visit.id), checkedInAt: visit.checked_in_at, site: site.rows[0].name },
          person: publicPerson(person),
          appointment,
          ticket,
          needsService: !ticket, // the station should ask "what are you here for?"
          warnings,
        },
      };
    });

    res.status(result.status).json(result.body);
  }),
);

/**
 * POST /api/checkouts
 * Station: scan the ID again on the way out. Staff: { visitId } or identity fields.
 */
visitsRouter.post(
  '/checkouts',
  allow({ station: true, staff: FRONT_DESK }),
  asyncRoute(async (req, res) => {
    const result = await withTransaction(async (db) => {
      let visitRow;
      if (req.staff && req.body.visitId) {
        const r = await db.query('SELECT id, site_id FROM visits WHERE id = $1 AND checked_out_at IS NULL FOR UPDATE', [
          Number(req.body.visitId),
        ]);
        visitRow = r.rows[0];
        if (!visitRow) throw new HttpError(404, 'No open visit with that id');
        assertSiteAccess(req, visitRow.site_id);
      } else {
        const doc = readDocument(req.body);
        const siteId = actingSiteId(req, req.body.siteId);
        assertSiteAccess(req, siteId);
        const r = await db.query(
          `SELECT v.id, v.site_id FROM visits v JOIN persons p ON p.id = v.person_id
            WHERE p.id_type = $1 AND p.id_hash = $2 AND v.site_id = $3 AND v.checked_out_at IS NULL
            FOR UPDATE OF v`,
          [doc.idType, doc.idHash, siteId],
        );
        visitRow = r.rows[0];
        if (!visitRow) throw new HttpError(404, 'This person is not checked in here');
      }

      const closed = await db.query(
        `UPDATE visits SET checked_out_at = now() WHERE id = $1
         RETURNING id, checked_in_at, checked_out_at,
                   round(extract(epoch FROM checked_out_at - checked_in_at) / 60)::int AS minutes`,
        [visitRow.id],
      );
      // Anyone leaving before being served drops out of the queue
      await db.query(
        `UPDATE queue_tickets SET status = 'SKIPPED', done_at = now()
          WHERE visit_id = $1 AND status IN ('WAITING','CALLED')`,
        [visitRow.id],
      );
      await audit(db, req, { action: 'CHECK_OUT', entity: 'visits', entityId: visitRow.id });
      const v = closed.rows[0];
      return { visitId: Number(v.id), checkedInAt: v.checked_in_at, checkedOutAt: v.checked_out_at, minutesInside: v.minutes };
    });
    res.json(result);
  }),
);

function publicPerson(p) {
  return { id: p.id, fullName: p.full_name, idType: p.id_type, idLast4: p.id_last4, isNew: p.is_new };
}
