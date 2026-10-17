export async function loadBootstrap(pool) {
  const [assetRows, developerRows, sourceRows, groupRows, metricRows, relationshipRows] = await Promise.all([
    pool.query('SELECT asset_type, payload FROM reja.assets WHERE is_current=true ORDER BY asset_type, display_order, external_id'),
    pool.query('SELECT external_id, payload FROM reja.developers WHERE is_current=true ORDER BY display_order, external_id'),
    pool.query("SELECT payload FROM reja.sources WHERE is_current=true AND payload <> '{}'::jsonb ORDER BY display_order, id"),
    pool.query('SELECT group_name, payload FROM reja.owner_groups WHERE is_current=true ORDER BY display_order, group_name'),
    pool.query('SELECT * FROM reja.developer_portfolio_metrics'),
    pool.query(`SELECT ad.developer_id, a.external_id AS project_external_id
      FROM reja.asset_developers ad
      JOIN reja.assets a ON a.id = ad.asset_id
      WHERE a.asset_type = 'project' AND a.is_current = true AND ad.is_current = true
      ORDER BY ad.developer_id, (ad.relationship_role = 'primary') DESC, a.display_order, a.external_id`)
  ]);
  const projectIdsByDeveloper = new Map();
  for (const row of relationshipRows.rows) {
    if (!projectIdsByDeveloper.has(row.developer_id)) projectIdsByDeveloper.set(row.developer_id, []);
    projectIdsByDeveloper.get(row.developer_id).push(row.project_external_id);
  }
  const metrics = new Map(metricRows.rows.map((row) => [row.developer_id, row]));
  const developers = developerRows.rows.map(({ external_id, payload }) => {
    const dev = { ...payload };
    // The SQL relationship table is the authority for project membership; legacy payload lists can be stale.
    dev.projectIds = projectIdsByDeveloper.get(external_id) || [];
    const m = metrics.get(external_id);
    if (!m) return dev;
    const tracked = Number(m.tracked_project_count || 0);
    // Runtime metrics are computed from the relational link table, never trusted from the imported counters.
    // An absent tracked portfolio is UNKNOWN for real-world performance, not proof of zero delivery.
    dev.sourceReportedProjectCount = dev.projectCount ?? null;
    dev.sourceReportedTotalUnits = dev.totalUnits ?? null;
    dev.sourceReportedCompletionRate = dev.completionRate ?? null;
    dev.sourceReportedDeliveryScore = dev.deliveryScore ?? null;
    dev.projectCount = tracked > 0 ? tracked : null;
    dev.totalUnits = m.known_units_across_tracked_projects === null ? null : Number(m.known_units_across_tracked_projects);
    dev.completedCount = tracked > 0 ? Number(m.reported_completed_count || 0) : null;
    dev.stalledCount = tracked > 0 ? Number(m.reported_stalled_count || 0) : null;
    dev.activeCount = tracked > 0 ? Number(m.reported_active_count || 0) : null;
    dev.pipelineCount = tracked > 0 ? Number(m.reported_pipeline_count || 0) : null;
    dev.completionRate = m.observed_completion_rate_pct === null ? null : Number(m.observed_completion_rate_pct);
    dev.stalledRatio = m.observed_stalled_rate_pct === null ? null : Number(m.observed_stalled_rate_pct);
    // REJA's input data does not define a reproducible delivery-score methodology.
    // Preserve the imported figure in sourceReportedDeliveryScore; do not expose it as a current computed score.
    dev.deliveryScore = null;
    dev.databaseMetrics = {
      trackedProjectCount: tracked,
      projectsWithKnownUnits: Number(m.projects_with_known_units || 0),
      metricMethod: 'computed_from_reja.asset_developers_and_assets_v1'
    };
    return dev;
  });
  const out = { projects: [], segments: [], developers, sources: sourceRows.rows.map((r) => r.payload), ownerGroups: {} };
  for (const row of assetRows.rows) out[row.asset_type === 'segment' ? 'segments' : 'projects'].push(row.payload);
  for (const row of groupRows.rows) out.ownerGroups[row.group_name] = row.payload;
  return out;
}

export function safeScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function injectSqlSnapshot(htmlTemplate, data) {
  const pattern = /(<script\b(?=[^>]*\bid=["']reja-data["'])(?=[^>]*\btype=["']application\/json["'])[^>]*>)[\s\S]*?(<\/script\s*>)/i;
  if (!pattern.test(htmlTemplate)) throw new Error('HTML template is missing the reja-data JSON script element.');
  const dataJson = safeScriptJson(data);
  return htmlTemplate.replace(pattern, (_match, openTag, closeTag) => `${openTag}${dataJson}${closeTag}`);
}
