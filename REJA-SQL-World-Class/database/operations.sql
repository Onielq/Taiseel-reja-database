-- Operational checks for a DBA or analyst. Run with psql against the REJA database.

-- 1) Import status and snapshot history.
SELECT id, source_name, status, counts, started_at, finished_at, error_message
FROM reja.ingestion_runs
ORDER BY id DESC
LIMIT 20;

-- 2) Data coverage; NULL remains unknown, not zero.
SELECT * FROM reja.data_quality_summary;

-- 3) High-priority data-quality findings in the latest import.
SELECT q.severity, q.issue_code, q.entity_type, q.entity_id, q.message
FROM reja.data_quality_issues q
WHERE q.ingestion_run_id = (SELECT max(id) FROM reja.ingestion_runs)
ORDER BY CASE q.severity WHEN 'error' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END, q.issue_code;

-- 4) Projects with high confidence but no source link: review possible provenance gaps.
SELECT a.external_id, a.name, a.confidence_score, a.risk_level
FROM reja.assets a
WHERE a.asset_type = 'project'
  AND a.confidence_score >= 80
  AND NOT EXISTS (SELECT 1 FROM reja.asset_source_links sl WHERE sl.asset_id = a.id AND sl.is_current = true)
ORDER BY a.confidence_score DESC;

-- 5) Name-collision candidates; this is a review queue, not an automatic deduplication.
SELECT lower(regexp_replace(name, '[^[:alnum:]]+', ' ', 'g')) AS name_key,
       count(*) AS records,
       array_agg(external_id ORDER BY external_id) AS ids,
       array_agg(name ORDER BY external_id) AS names
FROM reja.assets
WHERE is_current = true
GROUP BY 1
HAVING count(*) > 1
ORDER BY records DESC, name_key;

-- 6) Developer portfolio metrics are computed from current tracked relations.
SELECT d.external_id, d.name, m.tracked_project_count,
       m.projects_with_known_units, m.known_units_across_tracked_projects,
       m.reported_completed_count, m.reported_stalled_count,
       m.observed_completion_rate_pct, m.observed_stalled_rate_pct
FROM reja.developers d
JOIN reja.developer_portfolio_metrics m ON m.developer_id = d.external_id
WHERE d.is_current = true
ORDER BY m.tracked_project_count DESC NULLS LAST, d.name;

-- 7) Evidence history for a field; is_current=false marks a prior imported claim.
SELECT a.external_id, a.name, c.field_key, c.value_json, c.claim_status,
       c.source_label, c.is_current, c.first_seen_at, c.last_seen_at
FROM reja.asset_field_claims c
JOIN reja.assets a ON a.id = c.asset_id
WHERE a.external_id = 'RW-NYA-NYA-0002'
ORDER BY c.field_key, c.is_current DESC, c.last_seen_at DESC;
