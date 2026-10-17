-- 003_official_land_benchmarks.sql
-- Store published government aggregates separately from individual property listings and deal records.
-- This table must NEVER be joined into market_verified_transactions as if the rows were individual deals.

CREATE TABLE IF NOT EXISTS reja.market_reference_benchmarks (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id           bigint NOT NULL REFERENCES reja.sources(id) ON DELETE RESTRICT,
    source_record_key   text NOT NULL CHECK (length(btrim(source_record_key)) BETWEEN 1 AND 200),
    benchmark_kind      text NOT NULL CHECK (benchmark_kind IN ('district_average_land_price','land_use_transaction_average')),
    geography_level     text NOT NULL CHECK (geography_level IN ('district','land_use')),
    district_label      text,
    land_use_label      text,
    metric_code         text NOT NULL CHECK (metric_code IN ('district_average_land_price_per_sqm','average_land_price_per_sqm_by_existing_use')),
    amount              numeric(20,2) NOT NULL CHECK (amount > 0),
    currency            char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    unit_code           text NOT NULL CHECK (unit_code IN ('RWF_PER_SQM')),
    observed_on         date NOT NULL,
    source_period_label text NOT NULL CHECK (length(btrim(source_period_label)) > 0),
    methodology_note    text NOT NULL CHECK (length(btrim(methodology_note)) > 0),
    is_current          boolean NOT NULL DEFAULT true,
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_id, source_record_key, observed_on),
    CHECK (
      (benchmark_kind = 'district_average_land_price' AND geography_level = 'district'
        AND district_label IS NOT NULL AND length(btrim(district_label)) > 0
        AND land_use_label IS NULL AND metric_code = 'district_average_land_price_per_sqm')
      OR
      (benchmark_kind = 'land_use_transaction_average' AND geography_level = 'land_use'
        AND land_use_label IS NOT NULL AND length(btrim(land_use_label)) > 0
        AND district_label IS NULL AND metric_code = 'average_land_price_per_sqm_by_existing_use')
    )
);

CREATE INDEX IF NOT EXISTS market_reference_benchmarks_current_kind_idx
    ON reja.market_reference_benchmarks (benchmark_kind, amount DESC, observed_on DESC)
    WHERE is_current = true;
CREATE INDEX IF NOT EXISTS market_reference_benchmarks_district_idx
    ON reja.market_reference_benchmarks (lower(district_label), observed_on DESC)
    WHERE is_current = true AND district_label IS NOT NULL;
CREATE INDEX IF NOT EXISTS market_reference_benchmarks_land_use_idx
    ON reja.market_reference_benchmarks (lower(land_use_label), observed_on DESC)
    WHERE is_current = true AND land_use_label IS NOT NULL;

COMMENT ON TABLE reja.market_reference_benchmarks IS
'Source-documented aggregated reference indicators. Never treat these rows as individual property transactions, verified comps, or formal valuations.';
COMMENT ON COLUMN reja.market_reference_benchmarks.observed_on IS
'Date Taiseel captured the displayed source snapshot, not the underlying transaction/reporting date.';
