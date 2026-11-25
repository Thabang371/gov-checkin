// Applies db/migrations/*.sql that haven't run yet, in name order, each in its own transaction.
// Safe to run any number of times: npm run db:migrate
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'migrations');

export async function runMigrations(client, log = () => {}) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let applied = 0;
  for (const file of files) {
    if (done.has(file)) continue;
    await client.query('BEGIN');
    try {
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log(`Applied ${file}`);
      applied++;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`${file}: ${err.message}`);
    }
  }
  if (!applied) log('Database is up to date.');
  return applied;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { pool } = await import('../src/db.js');
  const client = await pool.connect();
  try {
    await runMigrations(client, console.log);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
