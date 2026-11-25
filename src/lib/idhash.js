import crypto from 'node:crypto';
import { config } from '../config.js';

export const ID_TYPES = ['OMANG', 'PASSPORT', 'RESIDENCE_PERMIT'];

/** Uppercase and strip spaces/dashes so "BN 012-345" and "bn012345" hash the same. */
export function normaliseIdNumber(idNumber) {
  return String(idNumber ?? '').toUpperCase().replace(/[\s-]/g, '');
}

export function validateIdNumber(idType, idNumber) {
  const n = normaliseIdNumber(idNumber);
  if (!ID_TYPES.includes(idType)) return 'Unknown ID type';
  if (idType === 'OMANG' && !/^\d{9}$/.test(n)) return 'Omang number must be 9 digits';
  if (idType !== 'OMANG' && !/^[A-Z0-9]{6,12}$/.test(n)) return 'Document number must be 6-12 letters or digits';
  return null;
}

/** Keyed hash: the same number always gives the same hash, but it can't be reversed without the secret. */
export function hashIdNumber(idType, idNumber) {
  return crypto
    .createHmac('sha256', config.idHashSecret)
    .update(`${idType}:${normaliseIdNumber(idNumber)}`)
    .digest('hex');
}

export function last4(idNumber) {
  return normaliseIdNumber(idNumber).slice(-4);
}
