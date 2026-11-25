// Turns whatever the scanner read (QR, MRZ, NFC chip, or typed by staff) into one shape,
// then finds or creates the matching persons row.
import { HttpError } from '../lib/errors.js';
import { decodeIdQr } from '../lib/idqr.js';
import { hashIdNumber, last4, validateIdNumber, ID_TYPES } from '../lib/idhash.js';

const METHODS = ['QR', 'MRZ', 'NFC', 'MANUAL'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * body for QR:            { method: 'QR', qr: 'BWID1....' }
 * body for MRZ/NFC/MANUAL: { method, idType, idNumber, fullName, dateOfBirth?, docExpiry?, nationality? }
 * Returns a normalised document.
 */
export function readDocument(body) {
  const method = String(body?.method ?? '').toUpperCase();
  if (!METHODS.includes(method)) throw new HttpError(400, `method must be one of ${METHODS.join(', ')}`);

  let doc;
  if (method === 'QR') {
    const decoded = decodeIdQr(body.qr);
    if (!decoded.ok) throw new HttpError(422, decoded.error);
    const q = decoded.doc;
    doc = { idType: q.t, idNumber: q.n, fullName: q.fn, dateOfBirth: q.dob, docExpiry: q.exp, nationality: q.nat };
  } else {
    doc = {
      idType: String(body.idType ?? '').toUpperCase(),
      idNumber: body.idNumber,
      fullName: body.fullName,
      dateOfBirth: body.dateOfBirth,
      docExpiry: body.docExpiry,
      nationality: body.nationality,
    };
  }

  if (!ID_TYPES.includes(doc.idType)) throw new HttpError(400, `idType must be one of ${ID_TYPES.join(', ')}`);
  const idError = validateIdNumber(doc.idType, doc.idNumber);
  if (idError) throw new HttpError(400, idError);
  const fullName = String(doc.fullName ?? '').trim().replace(/\s+/g, ' ');
  if (fullName.length < 2 || fullName.length > 120) throw new HttpError(400, 'fullName is required');
  for (const field of ['dateOfBirth', 'docExpiry']) {
    if (doc[field] != null && !ISO_DATE.test(doc[field])) throw new HttpError(400, `${field} must be YYYY-MM-DD`);
  }
  const nationality = doc.nationality ? String(doc.nationality).toUpperCase() : null;
  if (nationality && !/^[A-Z]{3}$/.test(nationality)) throw new HttpError(400, 'nationality must be a 3-letter code');

  return {
    method,
    idType: doc.idType,
    idHash: hashIdNumber(doc.idType, doc.idNumber),
    idLast4: last4(doc.idNumber),
    fullName,
    dateOfBirth: doc.dateOfBirth ?? null,
    docExpiry: doc.docExpiry ?? null,
    nationality,
  };
}

/** Find the person by (idType, hash); create them if new, refresh name/expiry if known. */
export async function upsertPerson(db, doc) {
  const { rows } = await db.query(
    `INSERT INTO persons (id_type, id_hash, id_last4, full_name, nationality, date_of_birth, doc_expiry)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id_type, id_hash) DO UPDATE
       SET full_name     = EXCLUDED.full_name,
           nationality   = COALESCE(EXCLUDED.nationality, persons.nationality),
           date_of_birth = COALESCE(EXCLUDED.date_of_birth, persons.date_of_birth),
           doc_expiry    = COALESCE(EXCLUDED.doc_expiry, persons.doc_expiry),
           updated_at    = now()
     RETURNING id, id_type, id_last4, full_name, date_of_birth, doc_expiry, (xmax = 0) AS is_new`,
    [doc.idType, doc.idHash, doc.idLast4, doc.fullName, doc.nationality, doc.dateOfBirth, doc.docExpiry],
  );
  return rows[0];
}
