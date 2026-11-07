-- 003_unified_platform.sql
-- Shared schema foundation for the four Taiseel product pillars.
-- Existing REJA assets, evidence, audit and market tables are preserved.

CREATE EXTENSION IF NOT EXISTS postgis;

-- A reachable source is not necessarily licensed for reuse. NULL permissions
-- deliberately mean unknown/not established.
ALTER TABLE reja.sources
  ADD COLUMN IF NOT EXISTS license_status text NOT NULL DEFAULT 'not_reviewed'
    CHECK (license_status IN ('not_reviewed','unknown','permission_required','permitted','restricted','prohibited')),
  ADD COLUMN IF NOT EXISTS commercial_use_allowed boolean,
  ADD COLUMN IF NOT EXISTS redistribution_allowed boolean,
  ADD COLUMN IF NOT EXISTS caching_allowed boolean,
  ADD COLUMN IF NOT EXISTS attribution_required boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS license_url text CHECK (license_url IS NULL OR license_url ~* '^https?://'),
  ADD COLUMN IF NOT EXISTS permission_reference text,
  ADD COLUMN IF NOT EXISTS license_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS license_reviewed_by text,
  ADD COLUMN IF NOT EXISTS license_review_notes text;
CREATE INDEX IF NOT EXISTS sources_license_status_idx
  ON reja.sources (license_status, commercial_use_allowed, redistribution_allowed);
ALTER TABLE reja.sources
  ADD CONSTRAINT sources_positive_permission_requires_permitted_license
  CHECK (
    (commercial_use_allowed IS NOT TRUE OR license_status = 'permitted')
    AND (redistribution_allowed IS NOT TRUE OR license_status = 'permitted')
    AND (caching_allowed IS NOT TRUE OR license_status = 'permitted')
  );

-- Provider identity only. Passwords and session tokens stay with the selected
-- identity provider; provider subject IDs are not exposed as public profile IDs.
CREATE TABLE IF NOT EXISTS reja.app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_provider text NOT NULL CHECK (length(btrim(identity_provider)) BETWEEN 1 AND 80),
  provider_subject text NOT NULL CHECK (length(btrim(provider_subject)) BETWEEN 1 AND 255),
  email text,
  display_name text,
  account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','suspended','closed')),
  email_verified_at timestamptz,
  last_seen_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (identity_provider, provider_subject)
);
CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_lower_uq
  ON reja.app_users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS reja.organizations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  legal_name text NOT NULL CHECK (length(btrim(legal_name)) > 0),
  display_name text,
  organization_type text NOT NULL CHECK (organization_type IN ('developer','agency','owner','institution','valuer','property_manager','other')),
  registration_number text,
  registration_jurisdiction text NOT NULL DEFAULT 'RW',
  verification_status text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','verified','rejected','suspended','unknown')),
  created_by_user_id uuid NOT NULL REFERENCES reja.app_users(id) ON DELETE RESTRICT,
  verified_by_user_id uuid REFERENCES reja.app_users(id) ON DELETE RESTRICT,
  verified_at timestamptz,
  verification_source_id bigint REFERENCES reja.sources(id) ON DELETE RESTRICT,
  public_website text CHECK (public_website IS NULL OR public_website ~* '^https?://'),
  public_contact_email text,
  public_phone text,
  is_current boolean NOT NULL DEFAULT true,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((verification_status = 'verified' AND verified_at IS NOT NULL) OR verification_status <> 'verified')
);
CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_lower_uq
  ON reja.organizations (lower(slug)) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS organizations_name_lower_idx
  ON reja.organizations (lower(legal_name)) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS organizations_registration_idx
  ON reja.organizations (registration_jurisdiction, registration_number)
  WHERE registration_number IS NOT NULL AND is_current = true;

CREATE TABLE IF NOT EXISTS reja.organization_memberships (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id bigint NOT NULL REFERENCES reja.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES reja.app_users(id) ON DELETE RESTRICT,
  membership_role text NOT NULL CHECK (membership_role IN ('owner','admin','listing_manager','agent','analyst','reviewer','valuer','read_only')),
  membership_status text NOT NULL DEFAULT 'pending' CHECK (membership_status IN ('pending','active','suspended','removed')),
  invited_by_user_id uuid REFERENCES reja.app_users(id) ON DELETE RESTRICT,
  activated_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id),
  CHECK ((membership_status = 'active' AND activated_at IS NOT NULL) OR membership_status <> 'active')
);
CREATE INDEX IF NOT EXISTS organization_memberships_user_idx
  ON reja.organization_memberships (user_id, membership_status, membership_role);
CREATE INDEX IF NOT EXISTS organization_memberships_org_idx
  ON reja.organization_memberships (organization_id, membership_status, membership_role);

CREATE TABLE IF NOT EXISTS reja.organization_invitations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id bigint NOT NULL REFERENCES reja.organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  membership_role text NOT NULL CHECK (membership_role IN ('admin','listing_manager','agent','analyst','reviewer','valuer','read_only')),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by_user_id uuid NOT NULL REFERENCES reja.app_users(id) ON DELETE RESTRICT,
  invitation_status text NOT NULL DEFAULT 'pending' CHECK (invitation_status IN ('pending','accepted','expired','revoked')),
  expires_at timestamptz NOT NULL,
  accepted_by_user_id uuid REFERENCES reja.app_users(id) ON DELETE RESTRICT,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((invitation_status = 'accepted' AND accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL)
    OR invitation_status <> 'accepted')
);
CREATE INDEX IF NOT EXISTS organization_invitations_pending_idx
  ON reja.organization_invitations (organization_id, expires_at) WHERE invitation_status = 'pending';

CREATE TABLE IF NOT EXISTS reja.platform_user_roles (
  user_id uuid NOT NULL REFERENCES reja.app_users(id) ON DELETE CASCADE,
  platform_role text NOT NULL CHECK (platform_role IN ('admin','moderator','data_steward','support')),
  granted_by_user_id uuid REFERENCES reja.app_users(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (user_id, platform_role)
);

CREATE TABLE IF NOT EXISTS reja.organization_developer_links (
  organization_id bigint NOT NULL REFERENCES reja.organizations(id) ON DELETE CASCADE,
  developer_external_id text NOT NULL REFERENCES reja.developers(external_id) ON DELETE RESTRICT,
  relationship_status text NOT NULL DEFAULT 'pending'
    CHECK (relationship_status IN ('pending','verified','rejected','historical','disputed')),
  relationship_role text NOT NULL DEFAULT 'developer'
    CHECK (relationship_role IN ('developer','consortium_member','historical','other')),
  source_id bigint REFERENCES reja.sources(id) ON DELETE RESTRICT,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, developer_external_id)
);
CREATE INDEX IF NOT EXISTS organization_developer_links_developer_idx
  ON reja.organization_developer_links (developer_external_id, relationship_status);

-- The trusted backend sets this transaction-locally after verifying a signed
-- session. An unset context returns NULL, and private policies deny access.
CREATE OR REPLACE FUNCTION reja.current_user_id()
RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('reja.current_user_id', true), '')::uuid
$$;

-- SECURITY DEFINER helpers use a fixed search_path. Membership and platform
-- role tables are RLS-enabled but not FORCE-RLS so these helpers do not recurse.
CREATE OR REPLACE FUNCTION reja.has_organization_role(target_org bigint, allowed_roles text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, reja AS $$
  SELECT EXISTS (
    SELECT 1 FROM reja.organization_memberships m
    WHERE m.organization_id = target_org AND m.user_id = reja.current_user_id()
      AND m.membership_status = 'active' AND m.membership_role = ANY(allowed_roles)
  )
$$;

CREATE OR REPLACE FUNCTION reja.has_platform_role(allowed_roles text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, reja AS $$
  SELECT EXISTS (
    SELECT 1 FROM reja.platform_user_roles r
    WHERE r.user_id = reja.current_user_id() AND r.revoked_at IS NULL
      AND r.platform_role = ANY(allowed_roles)
  )
$$;

CREATE OR REPLACE FUNCTION reja.can_bootstrap_organization_owner(target_org bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, reja AS $$
  SELECT EXISTS (
    SELECT 1 FROM reja.organizations o
    WHERE o.id = target_org AND o.created_by_user_id = reja.current_user_id()
      AND NOT EXISTS (SELECT 1 FROM reja.organization_memberships m WHERE m.organization_id = o.id)
  )
$$;

-- Normalized administrative hierarchy; original provider IDs, shapes and
-- attribute payloads are kept in source-record tables.
CREATE TABLE IF NOT EXISTS reja.geo_areas (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id bigint REFERENCES reja.geo_areas(id) ON DELETE RESTRICT,
  area_level text NOT NULL CHECK (area_level IN ('district','sector','cell','village')),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  normalized_name text NOT NULL CHECK (length(btrim(normalized_name)) > 0),
  record_status text NOT NULL DEFAULT 'current' CHECK (record_status IN ('current','superseded','disputed','retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((area_level = 'district' AND parent_id IS NULL) OR (area_level <> 'district' AND parent_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS geo_areas_current_identity_uq
  ON reja.geo_areas (area_level, COALESCE(parent_id, 0), normalized_name)
  WHERE record_status = 'current';
CREATE INDEX IF NOT EXISTS geo_areas_parent_idx ON reja.geo_areas (parent_id, area_level, normalized_name);

CREATE TABLE IF NOT EXISTS reja.geo_area_source_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  area_id bigint NOT NULL REFERENCES reja.geo_areas(id) ON DELETE RESTRICT,
  source_id bigint NOT NULL REFERENCES reja.sources(id) ON DELETE RESTRICT,
  external_id text NOT NULL CHECK (length(btrim(external_id)) BETWEEN 1 AND 200),
  source_parent_id text,
  source_name text,
  source_updated_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  boundary geometry(MultiPolygon, 4326),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  is_current boolean NOT NULL DEFAULT true,
  UNIQUE (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS geo_area_source_records_area_idx ON reja.geo_area_source_records (area_id, is_current);
CREATE INDEX IF NOT EXISTS geo_area_source_records_boundary_gix ON reja.geo_area_source_records USING gist (boundary);

-- One canonical parcel can retain several provider records and geometries.
-- Neither geometry nor UPI proves ownership, restrictions or legal title.
CREATE TABLE IF NOT EXISTS reja.parcels (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  upi text,
  parcel_number text,
  village_id bigint REFERENCES reja.geo_areas(id) ON DELETE RESTRICT,
  area_sqm numeric(16,2) CHECK (area_sqm IS NULL OR area_sqm > 0),
  wetland_area_sqm numeric(16,2) CHECK (wetland_area_sqm IS NULL OR wetland_area_sqm >= 0),
  boundary geometry(MultiPolygon, 4326),
  record_status text NOT NULL DEFAULT 'unverified'
    CHECK (record_status IN ('unverified','source_documented','verified','disputed','retired')),
  last_source_update timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS parcels_upi_lower_uq ON reja.parcels (lower(upi)) WHERE upi IS NOT NULL;
CREATE INDEX IF NOT EXISTS parcels_village_idx ON reja.parcels (village_id, record_status);
CREATE INDEX IF NOT EXISTS parcels_boundary_gix ON reja.parcels USING gist (boundary);

CREATE TABLE IF NOT EXISTS reja.parcel_source_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parcel_id bigint REFERENCES reja.parcels(id) ON DELETE RESTRICT,
  source_id bigint NOT NULL REFERENCES reja.sources(id) ON DELETE RESTRICT,
  external_id text NOT NULL CHECK (length(btrim(external_id)) BETWEEN 1 AND 200),
  source_upi text,
  source_parcel_number text,
  source_area_sqm numeric(16,2) CHECK (source_area_sqm IS NULL OR source_area_sqm > 0),
  wetland_area_sqm numeric(16,2) CHECK (wetland_area_sqm IS NULL OR wetland_area_sqm >= 0),
  source_updated_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  boundary geometry(MultiPolygon, 4326),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  is_current boolean NOT NULL DEFAULT true,
  UNIQUE (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS parcel_source_records_parcel_idx ON reja.parcel_source_records (parcel_id, is_current);
CREATE INDEX IF NOT EXISTS parcel_source_records_upi_idx ON reja.parcel_source_records (lower(source_upi)) WHERE source_upi IS NOT NULL;
CREATE INDEX IF NOT EXISTS parcel_source_records_boundary_gix ON reja.parcel_source_records USING gist (boundary);

CREATE TABLE IF NOT EXISTS reja.asset_parcels (
  asset_id bigint NOT NULL REFERENCES reja.assets(id) ON DELETE CASCADE,
  parcel_id bigint NOT NULL REFERENCES reja.parcels(id) ON DELETE RESTRICT,
  relationship_role text NOT NULL DEFAULT 'site' CHECK (relationship_role IN ('site','phase','adjacent','access','other')),
  source_id bigint REFERENCES reja.sources(id) ON DELETE RESTRICT,
  claim_status text NOT NULL DEFAULT 'unverified' CHECK (claim_status IN ('verified','unverified','unknown','conflicted','inferred','disputed')),
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, parcel_id, relationship_role)
);
CREATE INDEX IF NOT EXISTS asset_parcels_parcel_idx ON reja.asset_parcels (parcel_id, is_current);

-- Structured project supply: phase -> building -> unit. An announcement does
-- not create verified construction status or live unit availability.
CREATE TABLE IF NOT EXISTS reja.development_phases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id bigint NOT NULL REFERENCES reja.assets(id) ON DELETE CASCADE,
  external_id text,
  phase_name text NOT NULL CHECK (length(btrim(phase_name)) > 0),
  phase_status text NOT NULL DEFAULT 'unknown'
    CHECK (phase_status IN ('proposed','planned','launched','under_construction','completed','paused','cancelled','disputed','unknown')),
  start_date date,
  target_completion_date date,
  actual_completion_date date,
  source_id bigint REFERENCES reja.sources(id) ON DELETE RESTRICT,
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('verified','unverified','unknown','conflicted','disputed')),
  last_verified_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (target_completion_date IS NULL OR start_date IS NULL OR target_completion_date >= start_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS development_phases_external_id_uq
  ON reja.development_phases (asset_id, external_id)
  WHERE external_id IS NOT NULL AND is_current = true;
CREATE INDEX IF NOT EXISTS development_phases_asset_idx
  ON reja.development_phases (asset_id, phase_status, is_current);

CREATE TABLE IF NOT EXISTS reja.development_buildings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id bigint NOT NULL REFERENCES reja.assets(id) ON DELETE CASCADE,
  phase_id bigint REFERENCES reja.development_phases(id) ON DELETE RESTRICT,
  external_id text,
  building_name text NOT NULL CHECK (length(btrim(building_name)) > 0),
  building_type text NOT NULL DEFAULT 'unknown'
    CHECK (building_type IN ('residential','commercial','industrial','mixed_use','hospitality','other','unknown')),
  building_status text NOT NULL DEFAULT 'unknown'
    CHECK (building_status IN ('planned','under_construction','completed','paused','cancelled','unknown')),
  source_id bigint REFERENCES reja.sources(id) ON DELETE RESTRICT,
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('verified','unverified','unknown','conflicted','disputed')),
  last_verified_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS development_buildings_external_id_uq
  ON reja.development_buildings (asset_id, external_id)
  WHERE external_id IS NOT NULL AND is_current = true;
CREATE INDEX IF NOT EXISTS development_buildings_phase_idx ON reja.development_buildings (phase_id, is_current);

CREATE TABLE IF NOT EXISTS reja.development_units (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  building_id bigint NOT NULL REFERENCES reja.development_buildings(id) ON DELETE CASCADE,
  external_id text,
  unit_label text NOT NULL CHECK (length(btrim(unit_label)) > 0),
  property_type text NOT NULL DEFAULT 'apartment'
    CHECK (property_type IN ('apartment','house','land','commercial','industrial','other','unknown')),
  bedrooms smallint CHECK (bedrooms IS NULL OR bedrooms BETWEEN 0 AND 30),
  bathrooms numeric(4,1) CHECK (bathrooms IS NULL OR bathrooms BETWEEN 0 AND 50),
  internal_area_sqm numeric(14,2) CHECK (internal_area_sqm IS NULL OR internal_area_sqm > 0),
  plot_area_sqm numeric(14,2) CHECK (plot_area_sqm IS NULL OR plot_area_sqm > 0),
  unit_status text NOT NULL DEFAULT 'unknown'
    CHECK (unit_status IN ('planned','available','reserved','sold','leased','withdrawn','unknown')),
  source_id bigint REFERENCES reja.sources(id) ON DELETE RESTRICT,
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('verified','unverified','unknown','conflicted','disputed')),
  availability_checked_at timestamptz,
  last_verified_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS development_units_external_id_uq
  ON reja.development_units (building_id, external_id)
  WHERE external_id IS NOT NULL AND is_current = true;
CREATE INDEX IF NOT EXISTS development_units_status_idx
  ON reja.development_units (unit_status, verification_status, is_current);

ALTER TABLE reja.market_properties
  ADD COLUMN IF NOT EXISTS parcel_id bigint REFERENCES reja.parcels(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS development_unit_id bigint REFERENCES reja.development_units(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS market_properties_parcel_idx
  ON reja.market_properties (parcel_id) WHERE parcel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS market_properties_unit_idx
  ON reja.market_properties (development_unit_id) WHERE development_unit_id IS NOT NULL;

-- First-party Taiseel inventory is separate from external/imported market_listings.
CREATE TABLE IF NOT EXISTS reja.listing_authorizations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_property_id bigint NOT NULL REFERENCES reja.market_properties(id) ON DELETE RESTRICT,
  seller_user_id uuid REFERENCES reja.app_users(id) ON DELETE RESTRICT,
  seller_organization_id bigint REFERENCES reja.organizations(id) ON DELETE RESTRICT,
  authorization_type text NOT NULL
    CHECK (authorization_type IN ('owner','agency_mandate','developer_authority','power_of_attorney','other')),
  authorization_status text NOT NULL DEFAULT 'pending'
    CHECK (authorization_status IN ('pending','verified','rejected','expired','revoked','disputed')),
  source_id bigint REFERENCES reja.sources(id) ON DELETE RESTRICT,
  evidence_reference text,
  evidence_url text CHECK (evidence_url IS NULL OR evidence_url ~* '^https?://'),
  valid_from date,
  valid_until date,
  submitted_by_user_id uuid NOT NULL REFERENCES reja.app_users(id) ON DELETE RESTRICT,
  reviewed_by_user_id uuid REFERENCES reja.app_users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((seller_user_id IS NOT NULL AND seller_organization_id IS NULL) OR (seller_user_id IS NULL AND seller_organization_id IS NOT NULL)),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
  CHECK ((authorization_status = 'verified' AND reviewed_at IS NOT NULL AND reviewed_by_user_id IS NOT NULL)
    OR authorization_status <> 'verified')
);
CREATE INDEX IF NOT EXISTS listing_authorizations_property_idx
  ON reja.listing_authorizations (market_property_id, authorization_status);
CREATE INDEX IF NOT EXISTS listing_authorizations_user_idx
  ON reja.listing_authorizations (seller_user_id, authorization_status) WHERE seller_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS listing_authorizations_org_idx
  ON reja.listing_authorizations (seller_organization_id, authorization_status) WHERE seller_organization_id IS NOT NULL;

CREATE OR REPLACE FUNCTION reja.has_verified_listing_authorization(
  target_authorization_id bigint, target_market_property_id bigint,
  target_seller_user_id uuid, target_seller_org_id bigint
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, reja AS $$
  SELECT EXISTS (
    SELECT 1 FROM reja.listing_authorizations a
    WHERE a.id = target_authorization_id
      AND a.market_property_id = target_market_property_id
      AND a.authorization_status = 'verified'
      AND (a.valid_from IS NULL OR a.valid_from <= current_date)
      AND (a.valid_until IS NULL OR a.valid_until >= current_date)
      AND (
        (target_seller_user_id IS NOT NULL AND a.seller_user_id = target_seller_user_id)
        OR (target_seller_org_id IS NOT NULL AND a.seller_organization_id = target_seller_org_id)
      )
  )
$$;

CREATE TABLE IF NOT EXISTS reja.exchange_listings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_property_id bigint NOT NULL REFERENCES reja.market_properties(id) ON DELETE RESTRICT,
  created_by_user_id uuid NOT NULL REFERENCES reja.app_users(id) ON DELETE RESTRICT,
  seller_user_id uuid REFERENCES reja.app_users(id) ON DELETE RESTRICT,
  seller_organization_id bigint REFERENCES reja.organizations(id) ON DELETE RESTRICT,
  listing_authorization_id bigint REFERENCES reja.listing_authorizations(id) ON DELETE RESTRICT,
  listing_type text NOT NULL CHECK (listing_type IN ('sale','rent')),
  asking_amount numeric(20,2) NOT NULL CHECK (asking_amount > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  rent_period text NOT NULL DEFAULT 'not_applicable'
    CHECK (rent_period IN ('not_applicable','daily','weekly','monthly','yearly')),
  publication_status text NOT NULL DEFAULT 'draft'
    CHECK (publication_status IN ('draft','pending_review','published','paused','withdrawn','expired','sold_or_leased','rejected')),
  source_reference text,
  listing_reference text UNIQUE,
  published_at timestamptz,
  expires_at timestamptz,
  withdrawn_at timestamptz,
  completed_at timestamptz,
  moderation_notes text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((seller_user_id IS NOT NULL AND seller_organization_id IS NULL) OR (seller_user_id IS NULL AND seller_organization_id IS NOT NULL)),
  CHECK ((listing_type = 'sale' AND rent_period = 'not_applicable')
    OR (listing_type = 'rent' AND rent_period <> 'not_applicable')),
  CHECK (publication_status <> 'published' OR (listing_authorization_id IS NOT NULL AND published_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS exchange_listings_public_search_idx
  ON reja.exchange_listings (publication_status, listing_type, currency, asking_amount)
  WHERE publication_status = 'published';
CREATE INDEX IF NOT EXISTS exchange_listings_property_idx
  ON reja.exchange_listings (market_property_id, created_at DESC);
CREATE INDEX IF NOT EXISTS exchange_listings_user_idx
  ON reja.exchange_listings (seller_user_id, publication_status, updated_at DESC) WHERE seller_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS exchange_listings_org_idx
  ON reja.exchange_listings (seller_organization_id, publication_status, updated_at DESC) WHERE seller_organization_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reja.exchange_listing_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id bigint NOT NULL REFERENCES reja.exchange_listings(id) ON DELETE RESTRICT,
  observed_by_user_id uuid REFERENCES reja.app_users(id) ON DELETE RESTRICT,
  observed_at timestamptz NOT NULL DEFAULT now(),
  asking_amount numeric(20,2) NOT NULL CHECK (asking_amount > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  publication_status text NOT NULL
    CHECK (publication_status IN ('draft','pending_review','published','paused','withdrawn','expired','sold_or_leased','rejected')),
  observation_reason text,
  UNIQUE (listing_id, observed_at)
);
CREATE INDEX IF NOT EXISTS exchange_listing_observations_history_idx
  ON reja.exchange_listing_observations (listing_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS reja.exchange_listing_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id bigint NOT NULL REFERENCES reja.exchange_listings(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES reja.app_users(id) ON DELETE RESTRICT,
  event_type text NOT NULL
    CHECK (event_type IN ('created','submitted','approved','rejected','published','paused','revised','withdrawn','expired','sold','leased','reopened')),
  event_note text,
  event_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(event_data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exchange_listing_events_history_idx
  ON reja.exchange_listing_events (listing_id, created_at DESC);

-- Extend data-quality issue entity types while retaining existing rows.
ALTER TABLE reja.data_quality_issues
  DROP CONSTRAINT IF EXISTS data_quality_issues_entity_type_check;
ALTER TABLE reja.data_quality_issues
  ADD CONSTRAINT data_quality_issues_entity_type_check CHECK (entity_type IN (
    'asset','developer','source','owner_group','dataset','organization','geo_area','parcel',
    'development_phase','development_building','development_unit','market_property','transaction','listing','organization_developer_link'
  ));

CREATE OR REPLACE FUNCTION reja.protect_app_user_security_fields()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, reja AS $
BEGIN
  IF (NEW.account_status, NEW.email_verified_at)
       IS DISTINCT FROM (OLD.account_status, OLD.email_verified_at)
     AND NOT reja.has_platform_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only a platform administrator may change account security state';
  END IF;
  RETURN NEW;
END
$;
CREATE TRIGGER app_users_protect_security_fields
BEFORE UPDATE OF account_status, email_verified_at ON reja.app_users
FOR EACH ROW EXECUTE FUNCTION reja.protect_app_user_security_fields();

CREATE OR REPLACE FUNCTION reja.protect_organization_verification_fields()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, reja AS $
BEGIN
  IF (NEW.verification_status, NEW.verified_by_user_id, NEW.verified_at, NEW.verification_source_id)
       IS DISTINCT FROM (OLD.verification_status, OLD.verified_by_user_id, OLD.verified_at, OLD.verification_source_id)
     AND NOT reja.has_platform_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only a platform administrator may change organization verification state';
  END IF;
  RETURN NEW;
END
$;
CREATE TRIGGER organizations_protect_verification_fields
BEFORE UPDATE OF verification_status, verified_by_user_id, verified_at, verification_source_id ON reja.organizations
FOR EACH ROW EXECUTE FUNCTION reja.protect_organization_verification_fields();

-- Account and organization policies.
ALTER TABLE reja.app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE reja.app_users FORCE ROW LEVEL SECURITY;
CREATE POLICY app_users_select_self ON reja.app_users FOR SELECT
  USING (id = reja.current_user_id());
CREATE POLICY app_users_insert_self ON reja.app_users FOR INSERT
  WITH CHECK (id = reja.current_user_id());
CREATE POLICY app_users_update_self ON reja.app_users FOR UPDATE
  USING (id = reja.current_user_id()) WITH CHECK (id = reja.current_user_id());

ALTER TABLE reja.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reja.organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_read_verified_or_member ON reja.organizations FOR SELECT
  USING (
    verification_status = 'verified'
    OR created_by_user_id = reja.current_user_id()
    OR reja.has_organization_role(id, ARRAY['owner','admin','listing_manager','agent','analyst','reviewer','valuer','read_only'])
    OR reja.has_platform_role(ARRAY['admin','moderator','data_steward','support'])
  );
CREATE POLICY organizations_create_self ON reja.organizations FOR INSERT
  WITH CHECK (created_by_user_id = reja.current_user_id() AND verification_status = 'pending');
CREATE POLICY organizations_manage_admin ON reja.organizations FOR UPDATE
  USING (reja.has_organization_role(id, ARRAY['owner','admin']) OR reja.has_platform_role(ARRAY['admin']))
  WITH CHECK (reja.has_organization_role(id, ARRAY['owner','admin']) OR reja.has_platform_role(ARRAY['admin']));

-- Membership helpers need to read this table without recursive FORCE-RLS.
ALTER TABLE reja.organization_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_read_self_or_admin ON reja.organization_memberships FOR SELECT
  USING (
    user_id = reja.current_user_id()
    OR reja.has_organization_role(organization_id, ARRAY['owner','admin'])
    OR reja.has_platform_role(ARRAY['admin'])
  );
CREATE POLICY memberships_insert_owner_or_admin ON reja.organization_memberships FOR INSERT
  WITH CHECK (
    (
      user_id = reja.current_user_id() AND membership_role = 'owner'
      AND membership_status = 'active'
      AND reja.can_bootstrap_organization_owner(organization_id)
    )
    OR reja.has_organization_role(organization_id, ARRAY['owner','admin'])
    OR reja.has_platform_role(ARRAY['admin'])
  );
CREATE POLICY memberships_update_admin ON reja.organization_memberships FOR UPDATE
  USING (reja.has_organization_role(organization_id, ARRAY['owner','admin']) OR reja.has_platform_role(ARRAY['admin']))
  WITH CHECK (reja.has_organization_role(organization_id, ARRAY['owner','admin']) OR reja.has_platform_role(ARRAY['admin']));

ALTER TABLE reja.organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reja.organization_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY invitations_read_admin ON reja.organization_invitations FOR SELECT
  USING (reja.has_organization_role(organization_id, ARRAY['owner','admin']) OR reja.has_platform_role(ARRAY['admin']));
CREATE POLICY invitations_create_admin ON reja.organization_invitations FOR INSERT
  WITH CHECK (invited_by_user_id = reja.current_user_id() AND reja.has_organization_role(organization_id, ARRAY['owner','admin']));
CREATE POLICY invitations_update_admin ON reja.organization_invitations FOR UPDATE
  USING (reja.has_organization_role(organization_id, ARRAY['owner','admin']) OR reja.has_platform_role(ARRAY['admin']))
  WITH CHECK (reja.has_organization_role(organization_id, ARRAY['owner','admin']) OR reja.has_platform_role(ARRAY['admin']));

ALTER TABLE reja.platform_user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_roles_read_self_or_admin ON reja.platform_user_roles FOR SELECT
  USING (user_id = reja.current_user_id() OR reja.has_platform_role(ARRAY['admin']));
CREATE POLICY platform_roles_manage_admin ON reja.platform_user_roles FOR ALL
  USING (reja.has_platform_role(ARRAY['admin'])) WITH CHECK (reja.has_platform_role(ARRAY['admin']));

-- Sellers can submit authorization evidence but cannot verify their own claim.
ALTER TABLE reja.listing_authorizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY authorizations_read_party_or_moderator ON reja.listing_authorizations FOR SELECT
  USING (
    seller_user_id = reja.current_user_id()
    OR reja.has_organization_role(seller_organization_id, ARRAY['owner','admin','listing_manager','agent'])
    OR reja.has_platform_role(ARRAY['admin','moderator'])
  );
CREATE POLICY authorizations_submit_party ON reja.listing_authorizations FOR INSERT
  WITH CHECK (
    submitted_by_user_id = reja.current_user_id()
    AND (
      seller_user_id = reja.current_user_id()
      OR reja.has_organization_role(seller_organization_id, ARRAY['owner','admin','listing_manager','agent'])
    )
    AND authorization_status = 'pending'
  );
CREATE POLICY authorizations_review_moderator ON reja.listing_authorizations FOR UPDATE
  USING (reja.has_platform_role(ARRAY['admin','moderator']))
  WITH CHECK (reja.has_platform_role(ARRAY['admin','moderator']));

-- Public reads are limited to published listings. Sellers and their authorized
-- organization members can manage drafts and review their own inventory.
ALTER TABLE reja.exchange_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE reja.exchange_listings FORCE ROW LEVEL SECURITY;
CREATE POLICY exchange_listings_read_public_or_party ON reja.exchange_listings FOR SELECT
  USING (
    publication_status = 'published'
    OR created_by_user_id = reja.current_user_id()
    OR seller_user_id = reja.current_user_id()
    OR reja.has_organization_role(seller_organization_id, ARRAY['owner','admin','listing_manager','agent','analyst','reviewer'])
    OR reja.has_platform_role(ARRAY['admin','moderator'])
  );
CREATE POLICY exchange_listings_create_draft ON reja.exchange_listings FOR INSERT
  WITH CHECK (
    created_by_user_id = reja.current_user_id()
    AND publication_status IN ('draft','pending_review')
    AND (
      seller_user_id = reja.current_user_id()
      OR reja.has_organization_role(seller_organization_id, ARRAY['owner','admin','listing_manager','agent'])
    )
  );
CREATE POLICY exchange_listings_manage_party ON reja.exchange_listings FOR UPDATE
  USING (
    created_by_user_id = reja.current_user_id()
    OR seller_user_id = reja.current_user_id()
    OR reja.has_organization_role(seller_organization_id, ARRAY['owner','admin','listing_manager','agent'])
    OR reja.has_platform_role(ARRAY['admin','moderator'])
  )
  WITH CHECK (
    (
      created_by_user_id = reja.current_user_id()
      OR seller_user_id = reja.current_user_id()
      OR reja.has_organization_role(seller_organization_id, ARRAY['owner','admin','listing_manager','agent'])
      OR reja.has_platform_role(ARRAY['admin','moderator'])
    )
    AND (
      publication_status <> 'published'
      OR reja.has_verified_listing_authorization(listing_authorization_id, market_property_id, seller_user_id, seller_organization_id)
    )
  );

ALTER TABLE reja.exchange_listing_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reja.exchange_listing_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY exchange_observations_read_party ON reja.exchange_listing_observations FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM reja.exchange_listings l
    WHERE l.id = listing_id AND (
      l.publication_status = 'published'
      OR l.created_by_user_id = reja.current_user_id()
      OR l.seller_user_id = reja.current_user_id()
      OR reja.has_organization_role(l.seller_organization_id, ARRAY['owner','admin','listing_manager','agent'])
    )
  ));
CREATE POLICY exchange_observations_insert_party ON reja.exchange_listing_observations FOR INSERT
  WITH CHECK (
    observed_by_user_id = reja.current_user_id()
    AND EXISTS (
      SELECT 1 FROM reja.exchange_listings l
      WHERE l.id = listing_id AND (
        l.created_by_user_id = reja.current_user_id()
        OR l.seller_user_id = reja.current_user_id()
        OR reja.has_organization_role(l.seller_organization_id, ARRAY['owner','admin','listing_manager','agent'])
      )
    )
  );

ALTER TABLE reja.exchange_listing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE reja.exchange_listing_events FORCE ROW LEVEL SECURITY;
CREATE POLICY exchange_events_read_party ON reja.exchange_listing_events FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM reja.exchange_listings l
    WHERE l.id = listing_id AND (
      l.publication_status = 'published'
      OR l.created_by_user_id = reja.current_user_id()
      OR l.seller_user_id = reja.current_user_id()
      OR reja.has_organization_role(l.seller_organization_id, ARRAY['owner','admin','listing_manager','agent'])
      OR reja.has_platform_role(ARRAY['admin','moderator'])
    )
  ));
CREATE POLICY exchange_events_insert_party ON reja.exchange_listing_events FOR INSERT
  WITH CHECK (
    actor_user_id = reja.current_user_id()
    AND EXISTS (
      SELECT 1 FROM reja.exchange_listings l
      WHERE l.id = listing_id AND (
        l.created_by_user_id = reja.current_user_id()
        OR l.seller_user_id = reja.current_user_id()
        OR reja.has_organization_role(l.seller_organization_id, ARRAY['owner','admin','listing_manager','agent'])
        OR reja.has_platform_role(ARRAY['admin','moderator'])
      )
    )
    AND (event_type NOT IN ('approved','rejected') OR reja.has_platform_role(ARRAY['admin','moderator']))
  );

COMMENT ON TABLE reja.geo_areas IS
  'Canonical Rwanda administrative hierarchy. Source-specific IDs and geometry are retained in geo_area_source_records.';
COMMENT ON TABLE reja.parcels IS
  'Canonical parcel identity and geometry. It is not proof of title, ownership, restrictions or encumbrances.';
COMMENT ON TABLE reja.parcel_source_records IS
  'Source-specific parcel records preserving provider IDs, source attributes and original geometries.';
COMMENT ON TABLE reja.exchange_listings IS
  'First-party authorized Taiseel listings. External listing snapshots remain in reja.market_listings.';
COMMENT ON COLUMN reja.sources.commercial_use_allowed IS
  'NULL means commercial reuse permission has not been established; it must not be interpreted as allowed.';
COMMENT ON COLUMN reja.sources.redistribution_allowed IS
  'NULL means redistribution permission has not been established; it must not be interpreted as allowed.';
COMMENT ON FUNCTION reja.current_user_id() IS
  'Reads the trusted reja.current_user_id transaction-local setting after server-side identity verification.';
