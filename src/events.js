// Live updates for dashboards and waiting-area screens.
// Writers call notifySite() inside their transaction; Postgres delivers the NOTIFY only on COMMIT,
// so screens never see a change that was rolled back. Every server instance LISTENs, so this keeps
// working when Cloud Run runs several copies of the API.
import pg from 'pg';
import { config } from './config.js';

const CHANNEL = 'site_events';
const subscribers = new Map(); // siteId -> Set<send(event)>
let listener = null;
let connecting = null;

/** Queue a change event for a site. Pass the transaction client so it fires on commit. */
export async function notifySite(db, siteId, type, extra = {}) {
  await db.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify({ siteId: Number(siteId), type, ...extra })]);
}

async function ensureListener() {
  if (listener) return;
  if (connecting) return connecting;
  connecting = (async () => {
    const client = new pg.Client({ connectionString: config.databaseUrl });
    client.on('notification', (msg) => {
      let evt;
      try { evt = JSON.parse(msg.payload); } catch { return; }
      for (const send of subscribers.get(evt.siteId) || []) send(evt);
    });
    client.on('error', () => {
      // Connection dropped: forget it; the next subscriber (or the retry below) reconnects.
      listener = null;
      setTimeout(() => { if (subscribers.size) ensureListener().catch(() => {}); }, 2000);
    });
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    listener = client;
  })();
  try { await connecting; } finally { connecting = null; }
}

/** Subscribe to a site's events. Returns an unsubscribe function. */
export async function subscribe(siteId, send) {
  await ensureListener();
  if (!subscribers.has(siteId)) subscribers.set(siteId, new Set());
  subscribers.get(siteId).add(send);
  return () => {
    const set = subscribers.get(siteId);
    set?.delete(send);
    if (set && !set.size) subscribers.delete(siteId);
  };
}

export async function closeEvents() {
  const c = listener;
  listener = null;
  if (c) await c.end().catch(() => {});
}
