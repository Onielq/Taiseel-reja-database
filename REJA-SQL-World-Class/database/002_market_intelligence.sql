-- 002_market_intelligence.sql
-- Adds a transaction-first market intelligence layer. No demo transactions are seeded.
-- Amounts remain separated by currency and rent period; only verified transactions feed public metrics.

CREATE TABLE IF NOT EXISTS reja.market_properties (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    external_id         text NOT NULL UNIQUE CHECK (length(btrim(external_id)) BETWEEN 1 AND 100),
    asset_id            bigint REFERENCES reja.assets(id) ON DELETE SET NULL,
    property_type       text NOT NULL CHECK (property_type IN ('apartment','house','land','commercial','industrial','mixed_use','other','unknown')),
    district_label      text NOT NULL CHECK (length(btrim(district_label)) > 0),
    sector_label        text,
    cell_label          text,
    address_label       text,
    project_name        text,
    building_name       text,
    unit_label          text,
    unit_series         text,
    bedrooms            smallint CHECK (bedrooms IS NULL OR bedrooms BETWEEN 0 AND 30),
    bathrooms           numeric(4,1) CHECK (bathrooms IS NULL OR bathrooms BETWEEN 0 AND 50),
    floor_label         text,
    internal_area_sqm   numeric(14,2) CHECK (internal_area_sqm IS NULL OR internal_area_sqm > 0),
    plot_area_sqm       numeric(14,2) CHECK (plot_area_sqm IS NULL OR plot_area_sqm > 0),
    latitude            numeric(9,6) CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
    longitude           numeric(9,6) CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
    record_status       text NOT NULL DEFAULT 'active' CHECK (record_status IN ('active','inactive','merged','under_review')),
    is_current          boolean NOT NULL DEFAULT true,
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CHECK ((latitude IS NULL) = (longitude IS NULL))
);
CREATE INDEX IF NOT EXISTS market_properties_area_idx
    ON reja.market_properties (lower(district_label), lower(coalesce(sector_label,'')), property_type)
    WHERE is_current = true;
CREATE INDEX IF NOT EXISTS market_properties_asset_idx
    ON reja.market_properties (asset_id) WHERE asset_id IS NOT NULL AND is_current = true;
CREATE INDEX IF NOT EXISTS market_properties_building_idx
    ON reja.market_properties (lower(coalesce(building_name,'')), lower(coalesce(project_name,'')))
    WHERE is_current = true;
CREATE INDEX IF NOT EXISTS market_properties_geo_idx
    ON reja.market_properties (latitude, longitude)
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND is_current = true;

CREATE TABLE IF NOT EXISTS reja.market_transactions (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id           bigint NOT NULL REFERENCES reja.sources(id) ON DELETE RESTRICT,
    ingestion_run_id    bigint REFERENCES reja.ingestion_runs(id) ON DELETE RESTRICT,
    source_record_key   text NOT NULL CHECK (length(btrim(source_record_key)) BETWEEN 1 AND 200),
    record_hash         char(64) NOT NULL CHECK (record_hash ~ '^[0-9a-f]{64}$'),
    property_id         bigint REFERENCES reja.market_properties(id) ON DELETE SET NULL,
    asset_id            bigint REFERENCES reja.assets(id) ON DELETE SET NULL,
    transaction_type    text NOT NULL CHECK (transaction_type IN ('sale','rent')),
    transaction_date    date NOT NULL,
    amount              numeric(20,2) NOT NULL CHECK (amount > 0),
    currency            char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    rent_period         text NOT NULL DEFAULT 'not_applicable'
                        CHECK (rent_period IN ('not_applicable','daily','weekly','monthly','yearly')),
    property_type       text NOT NULL CHECK (property_type IN ('apartment','house','land','commercial','industrial','mixed_use','other','unknown')),
    district_label      text NOT NULL CHECK (length(btrim(district_label)) > 0),
    sector_label        text,
    cell_label          text,
    property_area_sqm   numeric(14,2) CHECK (property_area_sqm IS NULL OR property_area_sqm > 0),
    bedrooms            smallint CHECK (bedrooms IS NULL OR bedrooms BETWEEN 0 AND 30),
    transaction_channel text NOT NULL DEFAULT 'unknown'
                        CHECK (transaction_channel IN ('primary','resale','off_plan','unknown')),
    payment_method      text NOT NULL DEFAULT 'unknown'
                        CHECK (payment_method IN ('cash','mortgage','installment','unknown')),
    verification_status text NOT NULL DEFAULT 'unverified'
                        CHECK (verification_status IN ('verified','partially_verified','unverified','disputed','rejected')),
    verified_at         timestamptz,
    is_current          boolean NOT NULL DEFAULT true,
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    price_per_sqm       numeric(20,2) GENERATED ALWAYS AS (
                            CASE WHEN property_area_sqm IS NOT NULL AND property_area_sqm > 0
                                 THEN round(amount / property_area_sqm, 2)
                                 ELSE NULL END
                        ) STORED,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CHECK ((transaction_type = 'sale' AND rent_period = 'not_applicable')
        OR (transaction_type = 'rent' AND rent_period <> 'not_applicable')),
    CHECK ((verification_status = 'verified' AND verified_at IS NOT NULL)
        OR verification_status <> 'verified')
);
CREATE UNIQUE INDEX IF NOT EXISTS market_transactions_current_source_key_uq
    ON reja.market_transactions (source_id, source_record_key) WHERE is_current = true;
CREATE UNIQUE INDEX IF NOT EXISTS market_transactions_record_hash_uq
    ON reja.market_transactions (record_hash);
CREATE INDEX IF NOT EXISTS market_transactions_date_area_idx
    ON reja.market_transactions (transaction_date DESC, lower(district_label), lower(coalesce(sector_label,'')))
    WHERE is_current = true AND verification_status = 'verified';
CREATE INDEX IF NOT EXISTS market_transactions_type_currency_idx
    ON reja.market_transactions (transaction_type, property_type, currency, transaction_date DESC)
    WHERE is_current = true AND verification_status = 'verified';
CREATE INDEX IF NOT EXISTS market_transactions_asset_idx
    ON reja.market_transactions (asset_id, transaction_date DESC)
    WHERE asset_id IS NOT NULL AND is_current = true AND verification_status = 'verified';
CREATE INDEX IF NOT EXISTS market_transactions_property_idx
    ON reja.market_transactions (property_id, transaction_date DESC)
    WHERE property_id IS NOT NULL AND is_current = true;
CREATE INDEX IF NOT EXISTS market_transactions_payload_gin_idx
    ON reja.market_transactions USING gin (payload jsonb_path_ops) WHERE is_current = true;

-- Additional source records can corroborate or challenge a canonical transaction
-- without counting that same deal multiple times in the aggregate views.
CREATE TABLE IF NOT EXISTS reja.market_transaction_evidence (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_id      bigint NOT NULL REFERENCES reja.market_transactions(id) ON DELETE CASCADE,
    source_id           bigint NOT NULL REFERENCES reja.sources(id) ON DELETE RESTRICT,
    source_record_key   text NOT NULL CHECK (length(btrim(source_record_key)) BETWEEN 1 AND 200),
    evidence_role       text NOT NULL DEFAULT 'corroborating'
                        CHECK (evidence_role IN ('corroborating','correction','dispute','other')),
    evidence_status     text NOT NULL DEFAULT 'unreviewed'
                        CHECK (evidence_status IN ('supports','contradicts','unreviewed','resolved')),
    source_url          text CHECK (source_url IS NULL OR source_url ~* '^https?://'),
    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now(),
    is_current          boolean NOT NULL DEFAULT true,
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    CHECK (last_seen_at >= first_seen_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS market_transaction_evidence_source_key_uq
    ON reja.market_transaction_evidence (source_id, source_record_key) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS market_transaction_evidence_transaction_idx
    ON reja.market_transaction_evidence (transaction_id, evidence_status) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS market_transaction_evidence_source_idx
    ON reja.market_transaction_evidence (source_id, last_seen_at DESC) WHERE is_current = true;

-- Centralized eligibility rule: a transaction with unresolved contradictory source evidence
-- is temporarily excluded from public metrics even if an earlier review marked it verified.
CREATE OR REPLACE VIEW reja.market_verified_transactions AS
SELECT t.*
  FROM reja.market_transactions t
 WHERE t.is_current = true
   AND t.verification_status = 'verified'
   AND NOT EXISTS (
       SELECT 1
         FROM reja.market_transaction_evidence e
        WHERE e.transaction_id = t.id
          AND e.is_current = true
          AND e.evidence_status = 'contradicts'
   );

CREATE TABLE IF NOT EXISTS reja.market_listings (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id           bigint NOT NULL REFERENCES reja.sources(id) ON DELETE RESTRICT,
    source_record_key   text NOT NULL CHECK (length(btrim(source_record_key)) BETWEEN 1 AND 200),
    property_id         bigint REFERENCES reja.market_properties(id) ON DELETE SET NULL,
    asset_id            bigint REFERENCES reja.assets(id) ON DELETE SET NULL,
    listing_type        text NOT NULL CHECK (listing_type IN ('sale','rent')),
    asking_amount       numeric(20,2) NOT NULL CHECK (asking_amount > 0),
    currency            char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    rent_period         text NOT NULL DEFAULT 'not_applicable'
                        CHECK (rent_period IN ('not_applicable','daily','weekly','monthly','yearly')),
    property_type       text NOT NULL CHECK (property_type IN ('apartment','house','land','commercial','industrial','mixed_use','other','unknown')),
    district_label      text NOT NULL CHECK (length(btrim(district_label)) > 0),
    sector_label        text,
    property_area_sqm   numeric(14,2) CHECK (property_area_sqm IS NULL OR property_area_sqm > 0),
    listing_url         text CHECK (listing_url IS NULL OR listing_url ~* '^https?://'),
    listing_status      text NOT NULL DEFAULT 'active'
                        CHECK (listing_status IN ('active','withdrawn','expired','sold_or_leased','unknown')),
    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now(),
    is_current          boolean NOT NULL DEFAULT true,
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    asking_price_per_sqm numeric(20,2) GENERATED ALWAYS AS (
                            CASE WHEN property_area_sqm IS NOT NULL AND property_area_sqm > 0
                                 THEN round(asking_amount / property_area_sqm, 2)
                                 ELSE NULL END
                        ) STORED,
    CHECK ((listing_type = 'sale' AND rent_period = 'not_applicable')
        OR (listing_type = 'rent' AND rent_period <> 'not_applicable')),
    CHECK (last_seen_at >= first_seen_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS market_listings_current_source_key_uq
    ON reja.market_listings (source_id, source_record_key) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS market_listings_area_idx
    ON reja.market_listings (lower(district_label), lower(coalesce(sector_label,'')), listing_type, currency)
    WHERE is_current = true AND listing_status = 'active';
CREATE INDEX IF NOT EXISTS market_listings_asset_idx
    ON reja.market_listings (asset_id, listing_type) WHERE asset_id IS NOT NULL AND is_current = true;
CREATE INDEX IF NOT EXISTS market_listings_price_idx
    ON reja.market_listings (listing_type, currency, asking_amount)
    WHERE is_current = true AND listing_status = 'active';

CREATE TABLE IF NOT EXISTS reja.market_listing_observations (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    listing_id          bigint NOT NULL REFERENCES reja.market_listings(id) ON DELETE CASCADE,
    observed_at         timestamptz NOT NULL DEFAULT now(),
    asking_amount       numeric(20,2) NOT NULL CHECK (asking_amount > 0),
    currency            char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}
CREATE INDEX IF NOT EXISTS market_listing_observations_history_idx
    ON reja.market_listing_observations (listing_id, observed_at DESC);

-- Only explicitly verified transactions contribute to these public-facing aggregates.
-- Currency and rent period stay in the grouping keys, preventing unlike values from being mixed.
CREATE OR REPLACE VIEW reja.market_area_monthly_metrics AS
SELECT
    date_trunc('month', t.transaction_date)::date AS month_start,
    t.district_label,
    coalesce(nullif(t.sector_label, ''), 'Unknown') AS sector_label,
    t.property_type,
    t.transaction_type,
    t.currency,
    t.rent_period,
    t.transaction_channel,
    count(*)::integer AS transaction_count,
    count(DISTINCT t.property_id)::integer AS distinct_property_count,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY t.amount)::numeric(20,2) AS median_amount,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY t.price_per_sqm)::numeric(20,2) AS median_price_per_sqm,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY t.property_area_sqm)::numeric(14,2) AS median_area_sqm,
    min(t.transaction_date) AS earliest_transaction_date,
    max(t.transaction_date) AS latest_transaction_date
FROM reja.market_verified_transactions t
GROUP BY date_trunc('month', t.transaction_date)::date, t.district_label,
         coalesce(nullif(t.sector_label, ''), 'Unknown'), t.property_type,
         t.transaction_type, t.currency, t.rent_period, t.transaction_channel;

CREATE OR REPLACE VIEW reja.market_project_metrics AS
WITH linked_transactions AS (
    SELECT
        coalesce(t.asset_id, p.asset_id) AS project_asset_id,
        t.transaction_type, t.currency, t.rent_period, t.transaction_channel,
        t.amount, t.price_per_sqm, t.property_area_sqm, t.transaction_date, t.property_id
    FROM reja.market_verified_transactions t
    LEFT JOIN reja.market_properties p ON p.id = t.property_id
)
SELECT
    a.external_id AS project_id,
    a.name AS project_name,
    lt.transaction_type,
    lt.currency,
    lt.rent_period,
    lt.transaction_channel,
    count(*)::integer AS transaction_count,
    count(DISTINCT lt.property_id)::integer AS distinct_property_count,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY lt.amount)::numeric(20,2) AS median_amount,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY lt.price_per_sqm)::numeric(20,2) AS median_price_per_sqm,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY lt.property_area_sqm)::numeric(14,2) AS median_area_sqm,
    max(lt.transaction_date) AS latest_transaction_date
FROM linked_transactions lt
JOIN reja.assets a ON a.id = lt.project_asset_id
WHERE a.asset_type = 'project' AND a.is_current = true
GROUP BY a.external_id, a.name, lt.transaction_type, lt.currency, lt.rent_period, lt.transaction_channel;

COMMENT ON TABLE reja.market_properties IS
    'Normalized Rwanda property/building/unit identity. This record is not proof of legal title.';
COMMENT ON VIEW reja.market_verified_transactions IS
    'Canonical filter for current verified transactions after excluding unresolved contradictory evidence.';
COMMENT ON TABLE reja.market_transaction_evidence IS
    'Additional source evidence links corroborate canonical transactions without duplicating deal counts.';
COMMENT ON TABLE reja.market_transactions IS
    'Source-linked sale/rent observations. Only verified current records enter market aggregates.';
COMMENT ON TABLE reja.market_listings IS
    'Asking-price observations; these must never be presented as completed transactions.';
COMMENT ON VIEW reja.market_area_monthly_metrics IS
    'Monthly aggregates of verified current transactions, grouped by currency and rent period.';
),
    rent_period         text NOT NULL DEFAULT 'not_applicable'
                        CHECK (rent_period IN ('not_applicable','daily','weekly','monthly','yearly')),
    property_area_sqm   numeric(14,2) CHECK (property_area_sqm IS NULL OR property_area_sqm > 0),
    asking_price_per_sqm numeric(20,2) GENERATED ALWAYS AS (
                            CASE WHEN property_area_sqm IS NOT NULL AND property_area_sqm > 0
                                 THEN round(asking_amount / property_area_sqm, 2)
                                 ELSE NULL END
                        ) STORED,
    listing_status      text NOT NULL CHECK (listing_status IN ('active','withdrawn','expired','sold_or_leased','unknown')),
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    UNIQUE (listing_id, observed_at)
);
CREATE INDEX IF NOT EXISTS market_listing_observations_history_idx
    ON reja.market_listing_observations (listing_id, observed_at DESC);

-- Only explicitly verified transactions contribute to these public-facing aggregates.
-- Currency and rent period stay in the grouping keys, preventing unlike values from being mixed.
CREATE OR REPLACE VIEW reja.market_area_monthly_metrics AS
SELECT
    date_trunc('month', t.transaction_date)::date AS month_start,
    t.district_label,
    coalesce(nullif(t.sector_label, ''), 'Unknown') AS sector_label,
    t.property_type,
    t.transaction_type,
    t.currency,
    t.rent_period,
    t.transaction_channel,
    count(*)::integer AS transaction_count,
    count(DISTINCT t.property_id)::integer AS distinct_property_count,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY t.amount)::numeric(20,2) AS median_amount,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY t.price_per_sqm)::numeric(20,2) AS median_price_per_sqm,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY t.property_area_sqm)::numeric(14,2) AS median_area_sqm,
    min(t.transaction_date) AS earliest_transaction_date,
    max(t.transaction_date) AS latest_transaction_date
FROM reja.market_transactions t
WHERE t.is_current = true AND t.verification_status = 'verified'
GROUP BY date_trunc('month', t.transaction_date)::date, t.district_label,
         coalesce(nullif(t.sector_label, ''), 'Unknown'), t.property_type,
         t.transaction_type, t.currency, t.rent_period, t.transaction_channel;

CREATE OR REPLACE VIEW reja.market_project_metrics AS
WITH linked_transactions AS (
    SELECT
        coalesce(t.asset_id, p.asset_id) AS project_asset_id,
        t.transaction_type, t.currency, t.rent_period, t.transaction_channel,
        t.amount, t.price_per_sqm, t.property_area_sqm, t.transaction_date, t.property_id
    FROM reja.market_transactions t
    LEFT JOIN reja.market_properties p ON p.id = t.property_id
    WHERE t.is_current = true AND t.verification_status = 'verified'
)
SELECT
    a.external_id AS project_id,
    a.name AS project_name,
    lt.transaction_type,
    lt.currency,
    lt.rent_period,
    lt.transaction_channel,
    count(*)::integer AS transaction_count,
    count(DISTINCT lt.property_id)::integer AS distinct_property_count,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY lt.amount)::numeric(20,2) AS median_amount,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY lt.price_per_sqm)::numeric(20,2) AS median_price_per_sqm,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY lt.property_area_sqm)::numeric(14,2) AS median_area_sqm,
    max(lt.transaction_date) AS latest_transaction_date
FROM linked_transactions lt
JOIN reja.assets a ON a.id = lt.project_asset_id
WHERE a.asset_type = 'project' AND a.is_current = true
GROUP BY a.external_id, a.name, lt.transaction_type, lt.currency, lt.rent_period, lt.transaction_channel;

COMMENT ON TABLE reja.market_properties IS
    'Normalized Rwanda property/building/unit identity. This record is not proof of legal title.';
COMMENT ON TABLE reja.market_transactions IS
    'Source-linked sale/rent observations. Only verified current records enter market aggregates.';
COMMENT ON TABLE reja.market_listings IS
    'Asking-price observations; these must never be presented as completed transactions.';
COMMENT ON VIEW reja.market_area_monthly_metrics IS
    'Monthly aggregates of verified current transactions, grouped by currency and rent period.';
