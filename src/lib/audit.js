/**
 * Append a row to the audit log. Pass the transaction client when inside one,
 * so the audit row commits or rolls back with the action it describes.
 */
export async function audit(db, req, { action, entity, entityId = null, details = null }) {
  await db.query(
    `INSERT INTO audit_log (actor_id, station_id, action, entity, entity_id, ip, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      req?.staff?.id ?? null,
      req?.station?.id ?? null,
      action,
      entity,
      entityId == null ? null : String(entityId),
      clientIp(req),
      details,
    ],
  );
}

function clientIp(req) {
  const ip = req?.ip;
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
