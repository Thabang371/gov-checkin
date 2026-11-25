// Mock ID QR format, used until the real chip-and-QR Omang is available.
// Payload: BWID1.<base64url JSON>.<base64url HMAC-SHA256 signature>
// The signature means a QR someone makes at home is rejected. When the real Omang QR
// format is published, add a second parser here and keep the rest of the system unchanged.
import crypto from 'node:crypto';
import { config } from '../config.js';

const PREFIX = 'BWID1';

function sign(body) {
  return crypto.createHmac('sha256', config.qrSigningSecret).update(body).digest('base64url');
}

/** doc: { t: id type, n: id number, fn: full name, dob, exp, nat } */
export function encodeIdQr(doc) {
  const body = Buffer.from(JSON.stringify(doc)).toString('base64url');
  return `${PREFIX}.${body}.${sign(`${PREFIX}.${body}`)}`;
}

/** Returns { ok: true, doc } or { ok: false, error } */
export function decodeIdQr(text) {
  const parts = String(text ?? '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, error: 'Not a recognised ID QR code' };
  const [prefix, body, sig] = parts;
  const expected = Buffer.from(sign(`${prefix}.${body}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, error: 'QR signature is invalid' };
  }
  try {
    const doc = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!doc.t || !doc.n || !doc.fn) return { ok: false, error: 'QR is missing ID fields' };
    return { ok: true, doc };
  } catch {
    return { ok: false, error: 'QR content is unreadable' };
  }
}
