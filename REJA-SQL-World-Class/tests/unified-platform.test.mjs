import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFile(path.join(root, p), 'utf8');

test('land foundation stores normalized geography, source provenance and PostGIS geometry', async () => {
  const sql = await read('database/003_unified_platform.sql');
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS postgis/i);
  for (const table of ['reja.geo_areas','reja.geo_area_source_records','reja.parcels','reja.parcel_source_records','reja.asset_parcels']) {
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS ' + table), 'missing ' + table);
  }
  assert.match(sql, /geometry\(MultiPolygon, 4326\)/i);
  assert.match(sql, /USING gist \(boundary\)/i);
  assert.match(sql, /commercial_use_allowed boolean/);
  assert.match(sql, /redistribution_allowed boolean/);
  assert.match(sql, /caching_allowed boolean/);
  assert.match(sql, /NULL means commercial reuse permission has not been established/i);
});

test('development intelligence has phase, building and unit records with verification status', async () => {
  const sql = await read('database/003_unified_platform.sql');
  for (const table of ['reja.development_phases','reja.development_buildings','reja.development_units']) {
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS ' + table), 'missing ' + table);
  }
  assert.match(sql, /verification_status text NOT NULL DEFAULT 'unverified'/);
  assert.match(sql, /availability_checked_at timestamptz/);
});

test('identity and organization tables support multiple memberships and defined roles', async () => {
  const sql = await read('database/003_unified_platform.sql');
  for (const table of ['reja.app_users','reja.organizations','reja.organization_memberships','reja.organization_invitations','reja.platform_user_roles']) {
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS ' + table), 'missing ' + table);
  }
  assert.match(sql, /UNIQUE \(identity_provider, provider_subject\)/);
  assert.match(sql, /membership_role text NOT NULL CHECK \(membership_role IN \('owner','admin','listing_manager','agent'/);
  assert.match(sql, /can_bootstrap_organization_owner/);
});

test('first-party exchange inventory is separate and cannot publish without verified seller authority', async () => {
  const sql = await read('database/003_unified_platform.sql');
  for (const table of ['reja.listing_authorizations','reja.exchange_listings','reja.exchange_listing_observations','reja.exchange_listing_events']) {
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS ' + table), 'missing ' + table);
  }
  assert.match(sql, /has_verified_listing_authorization/);
  assert.match(sql, /publication_status <> 'published' OR \(listing_authorization_id IS NOT NULL AND published_at IS NOT NULL\)/);
  assert.match(sql, /publication_status <> 'published'[\s\S]*has_verified_listing_authorization/);
  assert.match(sql, /External listing snapshots remain in reja\.market_listings/);
});

test('private identity and exchange tables enable row-level security and transaction-local identity', async () => {
  const sql = await read('database/003_unified_platform.sql');
  for (const table of ['app_users','organizations','organization_memberships','organization_invitations','platform_user_roles','listing_authorizations','exchange_listings','exchange_listing_observations','exchange_listing_events']) {
    assert.match(sql, new RegExp('ALTER TABLE reja\\.' + table + ' ENABLE ROW LEVEL SECURITY', 'i'), table + ' missing RLS');
  }
  assert.match(sql, /current_setting\('reja\.current_user_id', true\)/);
  assert.match(sql, /CREATE POLICY exchange_listings_create_draft/);
  assert.match(sql, /CREATE POLICY exchange_listings_manage_party/);
});

test('migration is schema-only and never seeds fake users, source claims, listings or market observations', async () => {
  const sql = await read('database/003_unified_platform.sql');
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+reja\.(?:app_users|organizations|organization_memberships|exchange_listings|market_transactions)/i);
  assert.match(sql, /not proof of title/i);
  assert.match(sql, /NULL means commercial reuse permission has not been established/i);
});

test('organization identity links to existing developer records without self-verification', async () => {
  const sql = await read('database/003_unified_platform.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS reja\.organization_developer_links/);
  assert.match(sql, /organizations_protect_verification_fields/);
  assert.match(sql, /Only a platform administrator may change organization verification state/);
  assert.match(sql, /sources_positive_permission_requires_permitted_license/);
});

test('runtime roles explicitly do not bypass row-level security', async () => {
  const readonlyRole = await read('database/runtime_readonly_role.sql');
  const exchangeRole = await read('database/runtime_exchange_role.sql');
  assert.match(readonlyRole, /ALTER ROLE reja_app LOGIN NOBYPASSRLS/);
  assert.match(exchangeRole, /ALTER ROLE reja_exchange_app LOGIN NOBYPASSRLS/);
  assert.match(exchangeRole, /GRANT INSERT, UPDATE ON reja\.exchange_listings/);
  assert.doesNotMatch(exchangeRole, /GRANT DELETE ON reja\./);
});
