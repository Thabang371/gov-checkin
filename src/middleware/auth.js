import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool } from '../db.js';
import { HttpError } from '../lib/errors.js';

export function signStaffToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, siteId: user.site_id }, config.jwtSecret, {
    expiresIn: config.tokenTtl,
    audience: 'staff',
  });
}

// Citizens get a separate, short-lived token signed with a different key,
// so a citizen token can never be mistaken for a staff login (or the other way round).
const citizenKey = crypto.createHmac('sha256', config.jwtSecret).update('citizen-token-key').digest();

export function signCitizenToken(personId) {
  return jwt.sign({ sub: personId }, citizenKey, { expiresIn: '30m', audience: 'citizen' });
}

/** Requires "Authorization: Bearer <citizen token>"; sets req.citizen = { personId }. */
export function requireCitizen(req, res, next) {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) return next(new HttpError(401, 'Please confirm your ID first'));
  try {
    const claims = jwt.verify(token, citizenKey, { audience: 'citizen' });
    req.citizen = { personId: Number(claims.sub) };
    next();
  } catch {
    next(new HttpError(401, 'Your session has ended. Please confirm your ID again.'));
  }
}

/** Reads "Authorization: Bearer <jwt>" and loads the staff user (must still be active). */
async function loadStaff(req) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  let claims;
  try {
    claims = jwt.verify(token, config.jwtSecret, { audience: 'staff' });
  } catch {
    throw new HttpError(401, 'Session expired or invalid, please log in again');
  }
  const { rows } = await pool.query(
    'SELECT id, full_name, email, role, site_id FROM staff_users WHERE id = $1 AND active',
    [claims.sub],
  );
  if (!rows[0]) throw new HttpError(401, 'Account is disabled');
  return rows[0];
}

/** Reads "X-Station-Key: <stationId>.<secret>" and loads the scanner station. */
async function loadStation(req) {
  const key = req.get('x-station-key');
  if (!key) return null;
  const [idPart, secret] = key.split('.');
  const id = Number(idPart);
  if (!Number.isInteger(id) || !secret) throw new HttpError(401, 'Malformed station key');
  const { rows } = await pool.query(
    'SELECT id, site_id, name, device_key_hash FROM scanner_stations WHERE id = $1 AND active',
    [id],
  );
  const station = rows[0];
  const given = Buffer.from(hashStationSecret(secret));
  if (!station || !crypto.timingSafeEqual(Buffer.from(station.device_key_hash), given)) {
    throw new HttpError(401, 'Unknown or revoked station');
  }
  await pool.query('UPDATE scanner_stations SET last_seen_at = now() WHERE id = $1', [id]);
  return { id: station.id, siteId: station.site_id, name: station.name };
}

export function hashStationSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/**
 * allow({ staff: [roles...], station: true })
 * Lets the request through if it comes from a staff user with one of the roles,
 * or (when station: true) from a registered scanner station.
 */
export function allow({ staff = [], station = false } = {}) {
  return async (req, res, next) => {
    try {
      if (station) {
        const s = await loadStation(req);
        if (s) {
          req.station = s;
          return next();
        }
      }
      const user = await loadStaff(req);
      if (!user) throw new HttpError(401, 'Login required');
      if (!staff.includes(user.role)) throw new HttpError(403, 'Your role cannot do this');
      req.staff = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Site staff may only act on their own site; national admins on any site. */
export function assertSiteAccess(req, siteId) {
  if (req.station) {
    if (req.station.siteId !== siteId) throw new HttpError(403, 'Station belongs to a different site');
    return;
  }
  if (req.staff.role === 'NATIONAL_ADMIN') return;
  if (req.staff.site_id !== siteId) throw new HttpError(403, 'You can only access your own site');
}

/** The site the caller is acting for: the station's, else staff's own, else the one requested. */
export function actingSiteId(req, requested) {
  if (req.station) return req.station.siteId;
  if (req.staff.role === 'NATIONAL_ADMIN') {
    if (!requested) throw new HttpError(400, 'siteId is required for national admins');
    return Number(requested);
  }
  return req.staff.site_id;
}

export const ALL_STAFF = ['RECEPTION', 'OFFICER', 'SITE_ADMIN', 'NATIONAL_ADMIN'];
export const FRONT_DESK = ['RECEPTION', 'SITE_ADMIN', 'NATIONAL_ADMIN'];
export const ADMINS = ['SITE_ADMIN', 'NATIONAL_ADMIN'];
