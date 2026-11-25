// Wipes the TEST database and rebuilds it: base schema + every migration.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';
import { runMigrations } from '../db/migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function resetDb() {
  const client = await pool.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await client.query(fs.readFileSync(path.join(here, '..', 'db', 'schema.sql'), 'utf8'));
    await runMigrations(client);
  } finally {
    client.release();
  }
}
