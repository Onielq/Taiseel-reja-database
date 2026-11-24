import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFile(path.join(root, relativePath), 'utf8');

test('listing-to-parcel links preserve source identity and a canonical UPI snapshot', async () => {
  const sql = await read('database/004_verified_listing_parcel_links.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS reja\.market_listing_parcel_links/);
  assert.match(sql, /listing_id bigint NOT NULL REFERENCES reja\.market_listings\(id\)/);
  assert.match(sql, /parcel_id bigint NOT NULL REFERENCES reja\.parcels\(id\)/);
  assert.match(sql, /upi_snapshot text NOT NULL/);
  assert.match(sql, /evidence_reference text NOT NULL/);
  assert.match(sql, /source_listing_upi/);
  assert.match(sql, /official_cadastral_record/);
});

test('final parcel-link decisions require a separate reviewer and an exact UPI match', async () => {
  const sql = await read('database/004_verified_listing_parcel_links.sql');
  assert.match(sql, /reviewed_by_user_id <> submitted_by_user_id/);
  assert.match(sql, /reviewed_at IS NOT NULL/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION reja\.validate_market_listing_parcel_link_upi/);
  assert.match(sql, /upper\(btrim\(p\.upi\)\)/);
  assert.match(sql, /canonical_upi <> upper\(btrim\(NEW\.upi_snapshot\)\)/);
  assert.match(sql, /The reviewed UPI does not match the selected canonical parcel/);
  assert.doesNotMatch(sql, /ST_DWithin|ST_Distance|nearest coordinate/i);
});

test('public parcel-link reads expose only current verified claims from permitted sources', async () => {
  const sql = await read('database/004_verified_listing_parcel_links.sql');
  const policyStart = sql.indexOf('CREATE POLICY market_listing_parcel_links_read_evidence');
  assert.notEqual(policyStart, -1);
  const policy = sql.slice(policyStart, sql.indexOf(';', policyStart) + 1);
  assert.match(policy, /claim_status = 'verified'/);
  assert.match(policy, /is_current = true/);
  assert.match(policy, /reviewed_by_user_id <> submitted_by_user_id/);
  assert.match(policy, /s\.license_status = 'permitted'/);
  assert.match(policy, /s\.commercial_use_allowed IS TRUE/);
  assert.match(policy, /s\.redistribution_allowed IS TRUE/);
  assert.match(policy, /s\.caching_allowed IS TRUE/);
  assert.doesNotMatch(policy, /claim_status = 'pending'/);
});

test('listing-link writes are split between submitters and platform reviewers', async () => {
  const sql = await read('database/004_verified_listing_parcel_links.sql');
  const role = await read('database/runtime_exchange_role.sql');
  assert.match(sql, /claim_status = 'pending'/);
  assert.match(sql, /submitted_by_user_id = reja\.current_user_id\(\)/);
  assert.match(sql, /reja\.has_platform_role\(ARRAY\['admin','moderator','data_steward'\]\)/);
  assert.match(role, /GRANT INSERT, UPDATE ON reja\.market_listing_parcel_links TO reja_exchange_app/);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+reja\.market_listing_parcel_links/i);
});
