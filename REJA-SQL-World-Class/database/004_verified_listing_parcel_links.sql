-- 004_verified_listing_parcel_links.sql
-- Explicit evidence-backed relationship between an external listing and a
-- canonical cadastral parcel. Never infer this relationship from coordinates.
--
-- Public readers see only current, independently reviewed links for listings
-- whose source explicitly permits commercial display, redistribution and cache.

CREATE TABLE IF NOT EXISTS reja.market_listing_parcel_links (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id bigint NOT NULL REFERENCES reja.market_listings(id) ON DELETE RESTRICT,
  parcel_id bigint NOT NULL REFERENCES reja.parcels(id) ON DELETE RESTRICT,
  relationship_role text NOT NULL DEFAULT 'primary_site'
    CHECK (relationship_role IN ('primary_site','phase','adjacent','access','other')),
  claim_status text NOT NULL DEFAULT 'pending'
    CHECK (claim_status IN ('pending','verified','rejected','conflicted','revoked')),
  evidence_type text NOT NULL
    CHECK (evidence_type IN (
      'source_listing_upi',
      'official_cadastral_record',
      'survey_document',
      'title_document',
      'project_record',
      'other'
    )),
  upi_snapshot text NOT NULL
    CHECK (length(btrim(upi_snapshot)) BETWEEN 1 AND 120),
  evidence_reference text NOT NULL
    CHECK (length(btrim(evidence_reference)) BETWEEN 1 AND 500),
  evidence_url text CHECK (evidence_url IS NULL OR evidence_url ~* '^https?://'),
  submitted_by_user_id uuid NOT NULL REFERENCES reja.app_users(id) ON DELETE RESTRICT,
  reviewed_by_user_id uuid REFERENCES reja.app_users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_note text,
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    claim_status = 'pending'
    OR (
      reviewed_by_user_id IS NOT NULL
      AND reviewed_at IS NOT NULL
      AND reviewed_by_user_id <> submitted_by_user_id
    )
  ),
  CHECK (
    claim_status <> 'pending'
    OR (reviewed_by_user_id IS NULL AND reviewed_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS market_listing_parcel_links_current_uq
  ON reja.market_listing_parcel_links (listing_id, parcel_id, relationship_role)
  WHERE is_current = true;

CREATE UNIQUE INDEX IF NOT EXISTS market_listing_parcel_links_one_primary_site_uq
  ON reja.market_listing_parcel_links (listing_id)
  WHERE is_current = true
    AND claim_status = 'verified'
    AND relationship_role = 'primary_site';

CREATE INDEX IF NOT EXISTS market_listing_parcel_links_listing_status_idx
  ON reja.market_listing_parcel_links (listing_id, claim_status, is_current);

CREATE INDEX IF NOT EXISTS market_listing_parcel_links_parcel_status_idx
  ON reja.market_listing_parcel_links (parcel_id, claim_status, is_current);

-- The UPI snapshot is evidence reviewed against the canonical parcel identity.
-- A pending claim cannot be submitted against a different parcel's UPI.
CREATE OR REPLACE FUNCTION reja.validate_market_listing_parcel_link_upi()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, reja
AS $function$
DECLARE
  canonical_upi text;
BEGIN
  SELECT upper(btrim(p.upi))
    INTO canonical_upi
    FROM reja.parcels p
   WHERE p.id = NEW.parcel_id
     AND p.upi IS NOT NULL;

  IF canonical_upi IS NULL THEN
    RAISE EXCEPTION 'The linked parcel must have a canonical UPI';
  END IF;

  IF canonical_upi <> upper(btrim(NEW.upi_snapshot)) THEN
    RAISE EXCEPTION 'The reviewed UPI does not match the selected canonical parcel';
  END IF;

  IF NEW.claim_status <> 'pending'
     AND (
       NEW.reviewed_by_user_id IS NULL
       OR NEW.reviewed_at IS NULL
       OR NEW.reviewed_by_user_id = NEW.submitted_by_user_id
     ) THEN
    RAISE EXCEPTION 'A final listing-to-parcel decision requires a separate reviewer';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS market_listing_parcel_links_validate_upi
  ON reja.market_listing_parcel_links;

CREATE TRIGGER market_listing_parcel_links_validate_upi
BEFORE INSERT OR UPDATE OF parcel_id, upi_snapshot, claim_status,
  submitted_by_user_id, reviewed_by_user_id, reviewed_at
ON reja.market_listing_parcel_links
FOR EACH ROW
EXECUTE FUNCTION reja.validate_market_listing_parcel_link_upi();

-- Pending, rejected, conflicted and revoked claims are never public.
-- User-scoped review access stays inside the authenticated REJA roles.
ALTER TABLE reja.market_listing_parcel_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS market_listing_parcel_links_read_evidence
  ON reja.market_listing_parcel_links;

CREATE POLICY market_listing_parcel_links_read_evidence
ON reja.market_listing_parcel_links FOR SELECT
USING (
  submitted_by_user_id = reja.current_user_id()
  OR reviewed_by_user_id = reja.current_user_id()
  OR reja.has_platform_role(ARRAY['admin','moderator','data_steward'])
  OR (
    is_current = true
    AND claim_status = 'verified'
    AND reviewed_by_user_id IS NOT NULL
    AND reviewed_at IS NOT NULL
    AND reviewed_by_user_id <> submitted_by_user_id
    AND EXISTS (
      SELECT 1
        FROM reja.market_listings l
        JOIN reja.sources s ON s.id = l.source_id
       WHERE l.id = listing_id
         AND l.is_current = true
         AND s.is_current = true
         AND s.license_status = 'permitted'
         AND s.commercial_use_allowed IS TRUE
         AND s.redistribution_allowed IS TRUE
         AND s.caching_allowed IS TRUE
    )
  )
);

DROP POLICY IF EXISTS market_listing_parcel_links_submit_pending
  ON reja.market_listing_parcel_links;

CREATE POLICY market_listing_parcel_links_submit_pending
ON reja.market_listing_parcel_links FOR INSERT
WITH CHECK (
  submitted_by_user_id = reja.current_user_id()
  AND claim_status = 'pending'
  AND reviewed_by_user_id IS NULL
  AND reviewed_at IS NULL
);

DROP POLICY IF EXISTS market_listing_parcel_links_review_moderator
  ON reja.market_listing_parcel_links;

CREATE POLICY market_listing_parcel_links_review_moderator
ON reja.market_listing_parcel_links FOR UPDATE
USING (
  reja.has_platform_role(ARRAY['admin','moderator','data_steward'])
)
WITH CHECK (
  reja.has_platform_role(ARRAY['admin','moderator','data_steward'])
  AND (
    claim_status = 'pending'
    OR (
      reviewed_by_user_id = reja.current_user_id()
      AND reviewed_at IS NOT NULL
      AND reviewed_by_user_id <> submitted_by_user_id
    )
  )
);

COMMENT ON TABLE reja.market_listing_parcel_links IS
  'Evidence-backed external listing to cadastral parcel relationships. Only current, independently reviewed, source-permitted links are public.';
COMMENT ON COLUMN reja.market_listing_parcel_links.upi_snapshot IS
  'UPI independently checked against the canonical parcel at review time. A trigger rejects mismatches.';
COMMENT ON COLUMN reja.market_listing_parcel_links.evidence_reference IS
  'Human-readable evidence reference retained for reviewer audit; it is not a public title certificate.';
