import pg from 'pg';
import { config } from './config.js';

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of JS Dates (avoids timezone shifts)
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

/** Run fn(client) inside a transaction; rolls back on any error. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
