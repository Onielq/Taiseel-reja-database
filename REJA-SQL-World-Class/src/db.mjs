import pg from 'pg';

const { Pool } = pg;

export function createPool(connectionString = process.env.APP_DATABASE_URL || process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required. Copy .env.example to .env and set the PostgreSQL connection string.');
  }
  const max = Number.parseInt(process.env.PG_POOL_MAX || '8', 10);
  if (!Number.isInteger(max) || max < 1 || max > 100) throw new RangeError('PG_POOL_MAX must be an integer from 1 to 100.');
  return new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
    application_name: 'reja-intelligence',
    allowExitOnIdle: false
  });
}

export async function withTransaction(pool, fn, { isolation = 'READ COMMITTED' } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    throw error;
  } finally {
    client.release();
  }
}

export function isSafeHttpsOrHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}
