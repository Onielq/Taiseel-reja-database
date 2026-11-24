-- 005_exchange_listing_parcel_links.sql
-- Evidence-backed relationship between first-party Taiseel Exchange listings
-- and canonical cadastral parcels. A market_property reference, address or
-- coordinate is not enough to establish parcel identity.

CREATE TABLE IF NOT EXISTS reja.exchange_listing_parcel_links (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exchange_listing_id bigint NOT NULL
    REFERENCES reja.exchange_listings(id) ON DELETE RESTRICT,
  parcel_id bigint NOT NULL
    REFERENCES reja.parcels(id) ON DELETE RESTRICT,
  relationship_role text NOT NULL DEFAULT 'primary_site'
    CHECK (relationship_role IN ('primary_site','phase','adjacent','access','other')),
  claim_status text NOT NULL DEFAULT 'pending'
    CHECK (claim_status IN ('pending','verified','rejected','conflicted','revoked')),
  evidence_type text NOT NULL
    CHECK (evidence_type IN (
      'seller_declaration',
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
  submitted_by_user_id uuid NOT NULL
    REFERENCES reja.app_users(id) ON DELETE RESTRICT,
  reviewed_by_user_id uuid
    REFERENCES reja.app_users(id) ON DELETE RESTRICT,
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

CREATE UNIQUE INDEX IF NOT EXISTS exchange_listing_parcel_links_current_uq
  ON reja.exchange_listing_parcel_links
    (exchange_listing_id, parcel_id, relationship_role)
  WHERE is_current = true;

CREATE UNIQUE INDEX IF NOT EXISTS exchange_listing_parcel_links_one_primary_site_uq
  ON reja.exchange_listing_parcel_links (exchange_listing_id)
  WHERE is_current = true
    AND claim_status = 'verified'
    AND relationship_role = 'primary_site';

CREATE INDEX IF NOT EXISTS exchange_listing_parcel_links_listing_status_idx
  ON reja.exchange_listing_parcel_links
    (exchange_listing_id, claim_status, is_current);

CREATE INDEX IF NOT EXISTS exchange_listing_parcel_links_parcel_status_idx
  ON reja.exchange_listing_parcel_links
    (parcel_id, claim_status, is_current);

-- Verify the UPI snapshot against canonical parcel identity on every write.
-- If market_properties already contains a parcel_id, it may not contradict
-- this link. Its presence alone is not considered proof and is not used as
-- the public listing-to-parcel relationship.
CREATE OR REPLACE FUNCTION reja.validate_exchange_listing_parcel_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, reja
AS $function$
DECLARE
  canonical_upi text;
  property_parcel_id bigint;
BEGIN
  IF TG_OP = 'UPDATE'
     AND ROW(
       NEW.exchange_listing_id,
       NEW.parcel_id,
       NEW.relationship_role,
       NEW.evidence_type,
       NEW.upi_snapshot,
       NEW.evidence_reference,
       NEW.evidence_url,
       NEW.submitted_by_user_id
     ) IS DISTINCT FROM ROW(
       OLD.exchange_listing_id,
       OLD.parcel_id,
       OLD.relationship_role,
       OLD.evidence_type,
       OLD.upi_snapshot,
       OLD.evidence_reference,
       OLD.evidence_url,
       OLD.submitted_by_user_id
     ) THEN
    RAISE EXCEPTION 'Submitted listing-to-parcel evidence is immutable; submit a new claim instead';
  END IF;

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

  SELECT mp.parcel_id
    INTO property_parcel_id
    FROM reja.exchange_listings l
    JOIN reja.market_properties mp ON mp.id = l.market_property_id
   WHERE l.id = NEW.exchange_listing_id;

  IF property_parcel_id IS NOT NULL
     AND property_parcel_id <> NEW.parcel_id THEN
    RAISE EXCEPTION 'The listing property already references a different parcel; resolve the conflict before review';
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

DROP TRIGGER IF EXISTS exchange_listing_parcel_links_validate
  ON reja.exchange_listing_parcel_links;

CREATE TRIGGER exchange_listing_parcel_links_validate
BEFORE INSERT OR UPDATE ON reja.exchange_listing_parcel_links
FOR EACH ROW
EXECUTE FUNCTION reja.validate_exchange_listing_parcel_link();

ALTER TABLE reja.exchange_listing_parcel_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS exchange_listing_parcel_links_read_evidence
  ON reja.exchange_listing_parcel_links;

CREATE POLICY exchange_listing_parcel_links_read_evidence
ON reja.exchange_listing_parcel_links FOR SELECT
USING (
  submitted_by_user_id = reja.current_user_id()
  OR reviewed_by_user_id = reja.current_user_id()
  OR reja.has_platform_role(ARRAY['admin','moderator','data_steward','support'])
  OR EXISTS (
    SELECT 1
      FROM reja.exchange_listings l
     WHERE l.id = exchange_listing_id
       AND l.publication_status = 'published'
       AND (l.expires_at IS NULL OR l.expires_at > now())
       AND reja.has_verified_listing_authorization(
         l.listing_authorization_id,
         l.market_property_id,
         l.seller_user_id,
         l.seller_organization_id
       )
       AND is_current = true
       AND claim_status = 'verified'
       AND relationship_role = 'primary_site'
       AND reviewed_by_user_id IS NOT NULL
       AND reviewed_at IS NOT NULL
       AND reviewed_by_user_id <> submitted_by_user_id
  )
  OR EXISTS (
    SELECT 1
      FROM reja.exchange_listings l
     WHERE l.id = exchange_listing_id
       AND (
         l.created_by_user_id = reja.current_user_id()
         OR l.seller_user_id = reja.current_user_id()
         OR reja.has_organization_role(
           l.seller_organization_id,
           ARRAY['owner','admin','listing_manager','agent','analyst','reviewer']
         )
       )
  )
);

DROP POLICY IF EXISTS exchange_listing_parcel_links_submit_pending
  ON reja.exchange_listing_parcel_links;

CREATE POLICY exchange_listing_parcel_links_submit_pending
ON reja.exchange_listing_parcel_links FOR INSERT
WITH CHECK (
  submitted_by_user_id = reja.current_user_id()
  AND claim_status = 'pending'
  AND reviewed_by_user_id IS NULL
  AND reviewed_at IS NULL
  AND EXISTS (
    SELECT 1
      FROM reja.exchange_listings l
     WHERE l.id = exchange_listing_id
       AND (
         l.created_by_user_id = reja.current_user_id()
         OR l.seller_user_id = reja.current_user_id()
         OR reja.has_organization_role(
           l.seller_organization_id,
           ARRAY['owner','admin','listing_manager','agent']
         )
       )
  )
);

DROP POLICY IF EXISTS exchange_listing_parcel_links_review_moderator
  ON reja.exchange_listing_parcel_links;

CREATE POLICY exchange_listing_parcel_links_review_moderator
ON reja.exchange_listing_parcel_links FOR UPDATE
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

COMMENT ON TABLE reja.exchange_listing_parcel_links IS
  'Evidence-backed first-party Taiseel listing to cadastral parcel relationships. Public reads require an independently reviewed primary-site link, an unexpired published listing and valid seller authorization.';
COMMENT ON COLUMN reja.exchange_listing_parcel_links.upi_snapshot IS
  'UPI independently checked against canonical parcel identity at review time. A trigger rejects mismatches.';
COMMENT ON COLUMN reja.exchange_listing_parcel_links.evidence_reference IS
  'Private reviewer evidence reference; it is not a public title certificate.';
