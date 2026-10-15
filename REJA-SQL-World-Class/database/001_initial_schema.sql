-- REJA PostgreSQL schema. Immutable migration: create a new migration for future changes.
CREATE SCHEMA IF NOT EXISTS reja;

CREATE TABLE IF NOT EXISTS reja.ingestion_runs (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_name         text NOT NULL,
    source_sha256       char(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
    status              text NOT NULL CHECK (status IN ('started','completed','failed')),
    counts              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
    started_at          timestamptz NOT NULL DEFAULT now(),
    finished_at         timestamptz,
    error_message       text,
    CHECK ((status = 'started' AND finished_at IS NULL) OR (status <> 'started' AND finished_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ingestion_runs_started_at_idx ON reja.ingestion_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS reja.developers (
    external_id         text PRIMARY KEY CHECK (length(btrim(external_id)) BETWEEN 1 AND 80),
    display_order       integer NOT NULL DEFAULT 0 CHECK (display_order >= 0),
    name                text NOT NULL CHECK (length(btrim(name)) > 0),
    base                text,
    focus               text,
    is_current          boolean NOT NULL DEFAULT true,
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    row_version         integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS developers_name_lower_idx ON reja.developers (lower(name)) WHERE is_current = true;

CREATE TABLE IF NOT EXISTS reja.sources (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_key          text NOT NULL UNIQUE CHECK (length(btrim(source_key)) > 0),
    source_url          text UNIQUE CHECK (source_url IS NULL OR source_url ~* '^https?://'),
    display_order       integer NOT NULL DEFAULT 0 CHECK (display_order >= 0),
    title               text,
    publisher           text,
    purpose             text,
    source_type         text NOT NULL DEFAULT 'unclassified'
                        CHECK (source_type IN ('government','developer','publisher','listing','social','registry','user_supplied','unclassified')),
    is_current          boolean NOT NULL DEFAULT true,
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sources_publisher_lower_idx ON reja.sources (lower(publisher)) WHERE publisher IS NOT NULL AND is_current = true;

CREATE TABLE IF NOT EXISTS reja.assets (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    external_id         text NOT NULL UNIQUE CHECK (length(btrim(external_id)) BETWEEN 1 AND 80),
    asset_type          text NOT NULL CHECK (asset_type IN ('project','segment')),
    display_order       integer NOT NULL CHECK (display_order >= 0),
    name                text NOT NULL CHECK (length(btrim(name)) > 0),
    category            text,
    asset_class         text,
    district_label      text,
    sector_label        text,
    status              text,
    route               text,
    owner_name          text,
    owner_key           text,
    unit_count          bigint CHECK (unit_count IS NULL OR unit_count >= 0),
    land_area_ha        numeric(14,4) CHECK (land_area_ha IS NULL OR land_area_ha > 0),
    start_label         text,
    start_year          smallint CHECK (start_year IS NULL OR start_year BETWEEN 1800 AND 2200),
    completion_label    text,
    completion_year     smallint CHECK (completion_year IS NULL OR completion_year BETWEEN 1800 AND 2200),
    confidence_score    smallint CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 100),
    risk_score          smallint CHECK (risk_score IS NULL OR risk_score BETWEEN 0 AND 100),
    risk_level          text CHECK (risk_level IS NULL OR risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL','UNKNOWN')),
    is_current          boolean NOT NULL DEFAULT true,
    payload             jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    search_vector       tsvector GENERATED ALWAYS AS (
        to_tsvector('simple',
            coalesce(name, '') || ' ' || coalesce(category, '') || ' ' ||
            coalesce(asset_class, '') || ' ' || coalesce(district_label, '') || ' ' ||
            coalesce(sector_label, '') || ' ' || coalesce(status, '') || ' ' ||
            coalesce(owner_name, '')
        )
    ) STORED,
    row_version         integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assets_type_order_idx ON reja.assets (asset_type, display_order) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS assets_district_sector_idx ON reja.assets (lower(coalesce(district_label,'')), lower(coalesce(sector_label,''))) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS assets_status_idx ON reja.assets (lower(coalesce(status,''))) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS assets_risk_idx ON reja.assets (risk_level, risk_score DESC) WHERE asset_type = 'project' AND is_current = true;
CREATE INDEX IF NOT EXISTS assets_confidence_idx ON reja.assets (confidence_score DESC NULLS LAST) WHERE asset_type = 'project' AND is_current = true;
CREATE INDEX IF NOT EXISTS assets_units_idx ON reja.assets (unit_count DESC NULLS LAST) WHERE asset_type = 'project' AND is_current = true;
CREATE INDEX IF NOT EXISTS assets_search_gin_idx ON reja.assets USING gin (search_vector) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS assets_payload_gin_idx ON reja.assets USING gin (payload jsonb_path_ops) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS assets_name_lower_idx ON reja.assets (lower(name)) WHERE is_current = true;

CREATE TABLE IF NOT EXISTS reja.asset_developers (
    asset_id            bigint NOT NULL REFERENCES reja.assets(id) ON DELETE CASCADE,
    developer_id        text NOT NULL REFERENCES reja.developers(external_id) ON DELETE RESTRICT,
    relationship_role   text NOT NULL DEFAULT 'associated'
                        CHECK (relationship_role IN ('primary','associated','consortium','historical','unknown')),
    relationship_source text NOT NULL DEFAULT 'legacy_import'
                        CHECK (relationship_source IN ('asset_record','developer_portfolio','manual','legacy_import')),
    is_current          boolean NOT NULL DEFAULT true,
    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (asset_id, developer_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS asset_developers_one_primary_idx
    ON reja.asset_developers(asset_id) WHERE relationship_role = 'primary' AND is_current = true;
CREATE INDEX IF NOT EXISTS asset_developers_developer_idx ON reja.asset_developers(developer_id, asset_id) WHERE is_current = true;

CREATE TABLE IF NOT EXISTS reja.asset_source_links (
    asset_id            bigint NOT NULL REFERENCES reja.assets(id) ON DELETE CASCADE,
    source_id           bigint NOT NULL REFERENCES reja.sources(id) ON DELETE RESTRICT,
    source_role         text NOT NULL CHECK (source_role IN ('primary','field_claim','timeline','conflict','other')),
    field_key           text NOT NULL DEFAULT '',
    is_current          boolean NOT NULL DEFAULT true,
    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (asset_id, source_id, source_role, field_key)
);
CREATE INDEX IF NOT EXISTS asset_source_links_source_idx ON reja.asset_source_links(source_id, asset_id) WHERE is_current = true;

CREATE TABLE IF NOT EXISTS reja.asset_field_claims (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asset_id            bigint NOT NULL REFERENCES reja.assets(id) ON DELETE CASCADE,
    field_key           text NOT NULL CHECK (length(btrim(field_key)) > 0),
    value_json           jsonb,
    claim_status         text NOT NULL CHECK (claim_status IN ('verified','unverified','unknown','conflicted','inferred','disputed')),
    source_id           bigint REFERENCES reja.sources(id) ON DELETE RESTRICT,
    source_label        text,
    import_key          char(64) NOT NULL UNIQUE CHECK (import_key ~ '^[0-9a-f]{64}$'),
    is_current          boolean NOT NULL DEFAULT true,
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS field_claims_asset_field_idx ON reja.asset_field_claims(asset_id, field_key, claim_status) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS field_claims_history_idx ON reja.asset_field_claims(asset_id, field_key, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS field_claims_source_idx ON reja.asset_field_claims(source_id) WHERE source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reja.asset_timeline_events (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asset_id            bigint NOT NULL REFERENCES reja.assets(id) ON DELETE CASCADE,
    display_order       integer NOT NULL CHECK (display_order >= 0),
    date_label          text,
    event_year          smallint CHECK (event_year IS NULL OR event_year BETWEEN 1800 AND 2200),
    event_text          text NOT NULL CHECK (length(btrim(event_text)) > 0),
    confidence_label    text,
    source_id           bigint REFERENCES reja.sources(id) ON DELETE RESTRICT,
    import_key          char(64) NOT NULL UNIQUE CHECK (import_key ~ '^[0-9a-f]{64}$'),
    is_current          boolean NOT NULL DEFAULT true,
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    created_at          timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS timeline_asset_year_idx ON reja.asset_timeline_events(asset_id, event_year NULLS LAST, display_order) WHERE is_current = true;

CREATE TABLE IF NOT EXISTS reja.asset_assessment_factors (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asset_id            bigint NOT NULL REFERENCES reja.assets(id) ON DELETE CASCADE,
    factor_kind         text NOT NULL CHECK (factor_kind IN ('risk','confidence')),
    display_order       integer NOT NULL CHECK (display_order >= 0),
    factor_label        text NOT NULL CHECK (length(btrim(factor_label)) > 0),
    numeric_value       numeric(12,4),
    status_value        text,
    import_key          char(64) NOT NULL UNIQUE CHECK (import_key ~ '^[0-9a-f]{64}$'),
    is_current          boolean NOT NULL DEFAULT true,
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX IF NOT EXISTS assessment_factors_asset_kind_idx ON reja.asset_assessment_factors(asset_id, factor_kind, display_order) WHERE is_current = true;

CREATE TABLE IF NOT EXISTS reja.asset_conflicts (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asset_id            bigint NOT NULL REFERENCES reja.assets(id) ON DELETE CASCADE,
    conflict_text       text NOT NULL CHECK (length(btrim(conflict_text)) > 0),
    resolution_status   text NOT NULL DEFAULT 'open' CHECK (resolution_status IN ('open','resolved','dismissed')),
    resolution_note     text,
    import_key          char(64) NOT NULL UNIQUE CHECK (import_key ~ '^[0-9a-f]{64}$'),
    is_current          boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    resolved_at         timestamptz
);
CREATE INDEX IF NOT EXISTS asset_conflicts_open_idx ON reja.asset_conflicts(asset_id, resolution_status) WHERE resolution_status = 'open' AND is_current = true;

CREATE TABLE IF NOT EXISTS reja.owner_groups (
    group_name          text PRIMARY KEY CHECK (length(btrim(group_name)) > 0),
    display_order       integer NOT NULL DEFAULT 0 CHECK (display_order >= 0),
    is_current          boolean NOT NULL DEFAULT true,
    payload             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(payload) = 'array'),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reja.owner_group_assets (
    group_name          text NOT NULL REFERENCES reja.owner_groups(group_name) ON DELETE CASCADE,
    asset_id            bigint NOT NULL REFERENCES reja.assets(id) ON DELETE CASCADE,
    is_current          boolean NOT NULL DEFAULT true,
    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_name, asset_id)
);
CREATE INDEX IF NOT EXISTS owner_group_assets_asset_idx ON reja.owner_group_assets(asset_id, group_name) WHERE is_current = true;

CREATE TABLE IF NOT EXISTS reja.data_quality_issues (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ingestion_run_id    bigint NOT NULL REFERENCES reja.ingestion_runs(id) ON DELETE CASCADE,
    severity            text NOT NULL CHECK (severity IN ('info','warning','error')),
    issue_code          text NOT NULL,
    entity_type         text NOT NULL CHECK (entity_type IN ('asset','developer','source','owner_group','dataset')),
    entity_id           text,
    message             text NOT NULL,
    issue_fingerprint   char(64) NOT NULL CHECK (issue_fingerprint ~ '^[0-9a-f]{64}$'),
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (ingestion_run_id, issue_fingerprint)
);
CREATE INDEX IF NOT EXISTS dq_issues_run_idx ON reja.data_quality_issues(ingestion_run_id, severity, issue_code);

-- Audit log is append-only by convention; the application exposes no public write endpoint.
CREATE TABLE IF NOT EXISTS reja.audit_log (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_key           text NOT NULL DEFAULT 'system',
    event_name          text NOT NULL,
    entity_type         text NOT NULL,
    entity_key          text,
    before_data         jsonb,
    after_data          jsonb,
    correlation_id      text,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_entity_idx ON reja.audit_log(entity_type, entity_key, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_created_at_idx ON reja.audit_log(created_at DESC);

CREATE OR REPLACE FUNCTION reja.reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'reja.audit_log is append-only; % is prohibited', TG_OP;
END;
$$;
DROP TRIGGER IF EXISTS audit_log_immutable ON reja.audit_log;
CREATE TRIGGER audit_log_immutable
BEFORE UPDATE OR DELETE ON reja.audit_log
FOR EACH ROW EXECUTE FUNCTION reja.reject_audit_mutation();

-- Derived portfolio metrics are computed at query time, not stored as copied counters.
CREATE OR REPLACE VIEW reja.developer_portfolio_metrics AS
WITH portfolio AS (
    SELECT
        d.external_id AS developer_id,
        a.id AS asset_id,
        a.unit_count,
        CASE
          WHEN lower(coalesce(a.status,'')) ~ '(^|[^a-z])(completed|complete|occupied|delivered)([^a-z]|$)' THEN 'completed'
          WHEN lower(coalesce(a.status,'')) ~ '(^|[^a-z])(stalled|incomplete|suspended)([^a-z]|$)' THEN 'stalled'
          WHEN lower(coalesce(a.status,'')) ~ '(^|[^a-z])(under[- ]construction|under[- ]development|active)([^a-z]|$)' THEN 'active'
          WHEN lower(coalesce(a.status,'')) ~ '(^|[^a-z])(pipeline|planned)([^a-z]|$)' THEN 'pipeline'
          ELSE 'unknown'
        END AS status_class
    FROM reja.developers d
    LEFT JOIN reja.asset_developers ad ON ad.developer_id = d.external_id AND ad.is_current = true
    LEFT JOIN reja.assets a ON a.id = ad.asset_id AND a.asset_type = 'project' AND a.is_current = true
    WHERE d.is_current = true
)
SELECT
    developer_id,
    count(asset_id)::integer AS tracked_project_count,
    count(asset_id) FILTER (WHERE unit_count IS NOT NULL)::integer AS projects_with_known_units,
    sum(unit_count) FILTER (WHERE asset_id IS NOT NULL)::bigint AS known_units_across_tracked_projects,
    count(asset_id) FILTER (WHERE status_class = 'completed')::integer AS reported_completed_count,
    count(asset_id) FILTER (WHERE status_class = 'stalled')::integer AS reported_stalled_count,
    count(asset_id) FILTER (WHERE status_class = 'active')::integer AS reported_active_count,
    count(asset_id) FILTER (WHERE status_class = 'pipeline')::integer AS reported_pipeline_count,
    CASE
      WHEN count(asset_id) FILTER (WHERE status_class <> 'unknown') = 0 THEN NULL
      ELSE round(
        100.0 * count(asset_id) FILTER (WHERE status_class = 'completed')::numeric /
        nullif(count(asset_id) FILTER (WHERE status_class <> 'unknown'), 0), 1)
    END AS observed_completion_rate_pct,
    CASE
      WHEN count(asset_id) FILTER (WHERE status_class <> 'unknown') = 0 THEN NULL
      ELSE round(
        100.0 * count(asset_id) FILTER (WHERE status_class = 'stalled')::numeric /
        nullif(count(asset_id) FILTER (WHERE status_class <> 'unknown'), 0), 1)
    END AS observed_stalled_rate_pct
FROM portfolio
GROUP BY developer_id;

CREATE OR REPLACE VIEW reja.data_quality_summary AS
SELECT
    count(*) FILTER (WHERE a.asset_type = 'project')::integer AS project_count,
    count(*) FILTER (WHERE a.asset_type = 'segment')::integer AS segment_count,
    count(*) FILTER (WHERE a.asset_type = 'project' AND a.unit_count IS NOT NULL)::integer AS projects_with_known_units,
    count(*) FILTER (WHERE a.asset_type = 'project' AND a.unit_count IS NULL)::integer AS projects_with_unknown_units,
    count(*) FILTER (WHERE a.asset_type = 'project' AND a.confidence_score IS NOT NULL)::integer AS projects_with_confidence_score,
    count(*) FILTER (WHERE a.asset_type = 'project' AND NOT EXISTS (SELECT 1 FROM reja.asset_source_links sl WHERE sl.asset_id = a.id AND sl.is_current = true))::integer AS projects_without_linked_sources,
    count(*) FILTER (WHERE a.asset_type = 'project' AND a.risk_level IN ('HIGH','CRITICAL'))::integer AS projects_high_or_critical_risk,
    count(*) FILTER (WHERE a.asset_type = 'project' AND a.status IS NOT NULL AND lower(a.status) LIKE '%verify%')::integer AS projects_status_needs_verification
FROM reja.assets a
WHERE a.is_current = true;
