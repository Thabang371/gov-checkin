// Applies db/schema.sql. With --drop, wipes the public schema first (refused in production).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { runMigrations } from './migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const drop = process.argv.includes('--drop');

if (drop && config.isProduction) {
  console.error('Refusing to drop the database when NODE_ENV=production.');
  process.exit(1);
}

const sql = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
const client = await pool.connect();
try {
  if (drop) {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    console.log('Dropped and recreated schema "public".');
  }
  await client.query(sql);
  console.log('Schema applied.');
  await runMigrations(client, console.log);
} catch (err) {
  console.error('Schema failed:', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
