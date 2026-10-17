import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFile(path.join(root, relativePath), 'utf8');

test('market schema keeps asking prices separate from transaction evidence', async () => {
  const sql = await read('database/002_market_intelligence.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS reja\.market_properties/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS reja\.market_transactions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS reja\.market_listings/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS reja\.market_listing_observations/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS reja\.market_transaction_evidence/);
  assert.match(sql, /CREATE OR REPLACE VIEW reja\.market_verified_transactions/);
  assert.match(sql, /CREATE OR REPLACE VIEW reja\.market_area_monthly_metrics/);
  assert.match(sql, /CREATE OR REPLACE VIEW reja\.market_project_metrics/);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+reja\.market_(?:transactions|listings)/i);
});

test('published transaction view excludes non-current, unverified and contradicted records', async () => {
  const sql = await read('database/002_market_intelligence.sql');
  const viewStart = sql.indexOf('CREATE OR REPLACE VIEW reja.market_verified_transactions');
  assert.notEqual(viewStart, -1);
  const view = sql.slice(viewStart, sql.indexOf(';', viewStart) + 1);
  assert.match(view, /t\.is_current\s*=\s*true/);
  assert.match(view, /t\.verification_status\s*=\s*'verified'/);
  assert.match(view, /e\.evidence_status\s*=\s*'contradicts'/);
  assert.match(sql, /t\.currency/);
  assert.match(sql, /t\.rent_period/);
});

test('market APIs are read-only and use verified transactions for public metrics', async () => {
  const server = await read('src/server.mjs');
  for (const route of [
    '/api/v1/market/summary',
    '/api/v1/market/areas',
    '/api/v1/market/transactions',
    '/api/v1/market/trends',
    '/api/v1/market/listings',
    '/api/v1/market/projects/compare'
  ]) {
    assert.ok(server.includes("pathname === '" + route + "'"), 'missing route: ' + route);
  }
  assert.match(server, /if \(req\.method !== 'GET' && req\.method !== 'HEAD'\)/);
  assert.match(server, /FROM reja\.market_verified_transactions/);
  assert.match(server, /FROM reja\.market_listings/);
  assert.match(server, /url\.pathname === '\/market'/);
  assert.match(server, /\$\$\{dataParams\.length - 1\}/);
});

test('market dashboard labels data honestly and has an empty-data state', async () => {
  const html = await read('public/market.html');
  assert.match(html, /What sellers are asking/);
  assert.match(html, /What actually changed hands/);
  assert.match(html, /Only transactions marked verified are included here/);
  assert.match(html, /No verified transaction records have been imported yet/);
  assert.match(html, /No sample prices are displayed/);
  assert.match(html, /api\/v1\/market\/trends/);
  assert.match(html, /api\/v1\/market\/listings/);
  assert.match(html, /api\/v1\/market\/projects\/compare/);
});

test('market importer requires explicit source provenance and human verification override', async () => {
  const importer = await read('scripts/import-market-json.mjs');
  assert.match(importer, /allowVerified = args\.includes\('--allow-verified'\)/);
  assert.match(importer, /verificationStatus/);
  assert.match(importer, /human review of the source evidence/);
  assert.match(importer, /sourceRecordKey/);
  assert.match(importer, /sourceKey/);
  assert.match(importer, /BEGIN ISOLATION LEVEL SERIALIZABLE/);
  assert.match(importer, /pg_advisory_xact_lock/);
  assert.match(importer, /isSafeHttpsOrHttpUrl/);
  assert.match(importer, /Market import failed/);
});

test('market importer distinguishes rent periods and validates numeric/date input', async () => {
  const importer = await read('scripts/import-market-json.mjs');
  assert.match(importer, /RENT_PERIODS = \['not_applicable','daily','weekly','monthly','yearly'\]/);
  assert.match(importer, /price per square metre/);
  assert.match(importer, /function decimal\(/);
  assert.match(importer, /function dateOnly\(/);
  assert.match(importer, /function safeSourceUrl\(/);
});
