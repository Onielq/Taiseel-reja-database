import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFile(path.join(root, p), 'utf8');

test('first-party exchange listing parcel links are separate from external-source links', async () => {
  const sql = await read('database/005_exchange_listing_parcel_links.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS reja\.exchange_listing_parcel_links/);
  assert.match(sql, /exchange_listing_id bigint NOT NULL[\s\S]*REFERENCES reja\.exchange_listings/);
  assert.match(sql, /parcel_id bigint NOT NULL[\s\S]*REFERENCES reja\.parcels/);
  assert.doesNotMatch(sql, /REFERENCES reja\.market_listings/);
});

test('first-party parcel links require exact canonical UPI and independent review', async () => {
  const sql = await read('database/005_exchange_listing_parcel_links.sql');
  assert.match(sql, /upi_snapshot text NOT NULL/);
  assert.match(sql, /canonical_upi <> upper\(btrim\(NEW\.upi_snapshot\)\)/);
  assert.match(sql, /The reviewed UPI does not match the selected canonical parcel/);
  assert.match(sql, /reviewed_by_user_id <> submitted_by_user_id/);
  assert.match(sql, /A final listing-to-parcel decision requires a separate reviewer/);
  assert.match(sql, /Submitted listing-to-parcel evidence is immutable/);
});

test('only one current verified primary-site parcel is allowed per first-party listing', async () => {
  const sql = await read('database/005_exchange_listing_parcel_links.sql');
  assert.match(sql, /exchange_listing_parcel_links_one_primary_site_uq/);
  assert.match(sql, /claim_status = 'verified'/);
  assert.match(sql, /relationship_role = 'primary_site'/);
  assert.match(sql, /WHERE is_current = true/);
});

test('public first-party parcel link reads require a published listing and valid seller authorization', async () => {
  const sql = await read('database/005_exchange_listing_parcel_links.sql');
  const policyStart = sql.indexOf('CREATE POLICY exchange_listing_parcel_links_read_evidence');
  assert.notEqual(policyStart, -1);
  const policy = sql.slice(policyStart, sql.indexOf(';', policyStart) + 1);
  assert.match(policy, /l\.publication_status = 'published'/);
  assert.match(policy, /l\.expires_at IS NULL OR l\.expires_at > now\(\)/);
  assert.match(policy, /reja\.has_verified_listing_authorization\(/);
  assert.match(policy, /claim_status = 'verified'/);
  assert.match(policy, /reviewed_by_user_id <> submitted_by_user_id/);
  assert.doesNotMatch(policy, /ST_DWithin|ST_Distance|nearest coordinate/i);
});

test('seller parties can submit pending links, but only platform reviewers can decide them', async () => {
  const sql = await read('database/005_exchange_listing_parcel_links.sql');
  const submitStart = sql.indexOf('CREATE POLICY exchange_listing_parcel_links_submit_pending');
  const reviewStart = sql.indexOf('CREATE POLICY exchange_listing_parcel_links_review_moderator');
  assert.notEqual(submitStart, -1);
  assert.notEqual(reviewStart, -1);
  const submit = sql.slice(submitStart, sql.indexOf(';', submitStart) + 1);
  const review = sql.slice(reviewStart, sql.indexOf(';', reviewStart) + 1);
  assert.match(submit, /submitted_by_user_id = reja\.current_user_id\(\)/);
  assert.match(submit, /claim_status = 'pending'/);
  assert.match(submit, /has_organization_role/);
  assert.match(review, /has_platform_role\(ARRAY\['admin','moderator','data_steward'\]\)/);
  assert.match(review, /reviewed_by_user_id = reja\.current_user_id\(\)/);
});

test('exchange runtime role can submit and review links without DELETE or RLS bypass', async () => {
  const role = await read('database/runtime_exchange_role.sql');
  assert.match(role, /ALTER ROLE reja_exchange_app LOGIN NOBYPASSRLS/);
  assert.match(role, /GRANT INSERT, UPDATE ON reja\.exchange_listing_parcel_links TO reja_exchange_app/);
  assert.doesNotMatch(role, /GRANT DELETE ON reja\.exchange_listing_parcel_links/);
});

test('first-party Taiseel listings receive a unique public reference that is not the database row ID', async () => {
  const sql = await read('database/005_exchange_listing_parcel_links.sql');
  assert.match(sql, /CREATE OR REPLACE FUNCTION reja\.assign_exchange_listing_reference/);
  assert.match(sql, /'TSL-' \|\| upper\(replace\(gen_random_uuid\(\)::text, '-', ''\)\)/);
  assert.match(sql, /UPDATE reja\.exchange_listings[\s\S]*WHERE nullif\(btrim\(listing_reference\), ''\) IS NULL/);
  assert.match(sql, /A Taiseel listing reference is immutable once assigned/);
  assert.match(sql, /exchange_listings_listing_reference_length_check/);
  assert.match(sql, /listing_reference text UNIQUE/);
});
