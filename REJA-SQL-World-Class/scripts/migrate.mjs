import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const migrationsDir = path.join(root, 'database');
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required. Copy .env.example to .env and set the PostgreSQL connection string.');
  process.exit(1);
}

const client = new Client({ connectionString, application_name: 'reja-migrator', connectionTimeoutMillis: 5000 });
let migrationLockAcquired = false;
try {
  await client.connect();
  // Session advisory lock serializes competing deploys before touching the migration catalogue.
  await client.query("SELECT pg_advisory_lock(hashtext('reja:schema-migrations'))");
  migrationLockAcquired = true;
  await client.query('CREATE SCHEMA IF NOT EXISTS reja');
  await client.query(`
    CREATE TABLE IF NOT EXISTS reja.schema_migrations (
      version text PRIMARY KEY,
      checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const names = (await fs.readdir(migrationsDir)).filter((n) => /^\d+_[a-z0-9_]+\.sql$/.test(n)).sort();
  for (const name of names) {
    const sql = await fs.readFile(path.join(migrationsDir, name), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const existing = await client.query('SELECT checksum FROM reja.schema_migrations WHERE version = $1', [name]);
    if (existing.rowCount) {
      if (existing.rows[0].checksum.trim() !== checksum) {
        throw new Error(`Applied migration ${name} has changed. Migrations are immutable; create a new migration instead.`);
      }
      console.log(`skip ${name} (already applied)`);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO reja.schema_migrations(version, checksum) VALUES ($1, $2)', [name, checksum]);
      await client.query('COMMIT');
      console.log(`applied ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  console.log('Database migrations are up to date.');
} catch (error) {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (migrationLockAcquired) await client.query("SELECT pg_advisory_unlock(hashtext('reja:schema-migrations'))").catch(() => {});
  await client.end().catch(() => {});
}
