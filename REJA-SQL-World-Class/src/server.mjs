import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool } from './db.mjs';
import { loadBootstrap, injectSqlSnapshot } from './bootstrap.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const indexPath = path.join(publicDir, 'index.html');
const host = process.env.HOST || '127.0.0.1';
const port = Number.parseInt(process.env.PORT || '8787', 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
const pool = createPool();
const sortColumns = new Map([
  ['name', 'lower(name)'], ['district', 'lower(district_label)'], ['sector', 'lower(sector_label)'],
  ['status', 'lower(status)'], ['risk', 'risk_score'], ['confidence', 'confidence_score'],
  ['units', 'unit_count'], ['updated', 'updated_at']
]);

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, status, code, message, requestId) {
  sendJson(res, status, { error: { code, message, requestId } });
}

function readInt(value, fallback, min, max) {
  if (value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

async function loadAssetEvidence(externalId) {
  const assetResult = await pool.query(
    `SELECT id, external_id, asset_type, name, district_label, sector_label, status,
            unit_count, land_area_ha, confidence_score, risk_score, risk_level, row_version,
            updated_at, payload
       FROM reja.assets WHERE external_id = $1 AND is_current=true`, [externalId]
  );
  if (!assetResult.rowCount) return null;
  const asset = assetResult.rows[0];
  const [claims, timeline, factors, conflicts, sources, developers] = await Promise.all([
    pool.query(`SELECT c.field_key, c.value_json, c.claim_status, c.source_label, c.is_current,
                       c.first_seen_at, c.last_seen_at, s.title, s.publisher
                  FROM reja.asset_field_claims c LEFT JOIN reja.sources s ON s.id=c.source_id
                 WHERE c.asset_id=$1 ORDER BY c.is_current DESC,c.field_key,c.last_seen_at DESC`, [asset.id]),
    pool.query(`SELECT date_label,event_year,event_text,confidence_label,s.source_url,s.title,s.publisher
                  FROM reja.asset_timeline_events t LEFT JOIN reja.sources s ON s.id=t.source_id
                 WHERE t.asset_id=$1 AND t.is_current=true ORDER BY t.display_order`, [asset.id]),
    pool.query(`SELECT factor_kind,factor_label,numeric_value,status_value,display_order
                  FROM reja.asset_assessment_factors WHERE asset_id=$1 AND is_current=true ORDER BY factor_kind,display_order`, [asset.id]),
    pool.query(`SELECT conflict_text,resolution_status,resolution_note,created_at
                  FROM reja.asset_conflicts WHERE asset_id=$1 AND is_current=true ORDER BY created_at`, [asset.id]),
    pool.query(`SELECT s.source_url,s.title,s.publisher,s.purpose, sl.source_role, sl.field_key
                  FROM reja.asset_source_links sl JOIN reja.sources s ON s.id=sl.source_id
                 WHERE sl.asset_id=$1 AND sl.is_current=true ORDER BY sl.source_role,s.title NULLS LAST`, [asset.id]),
    pool.query(`SELECT d.external_id,d.name,ad.relationship_role,ad.relationship_source
                  FROM reja.asset_developers ad JOIN reja.developers d ON d.external_id=ad.developer_id
                 WHERE ad.asset_id=$1 AND ad.is_current=true AND d.is_current=true ORDER BY (ad.relationship_role='primary') DESC,d.name`, [asset.id])
  ]);
  return {
    record: { ...asset, updated_at: asset.updated_at?.toISOString?.() ?? asset.updated_at },
    payload: asset.payload,
    evidence: { fieldClaims: claims.rows, timeline: timeline.rows, assessmentFactors: factors.rows, conflicts: conflicts.rows, sources: sources.rows, developers: developers.rows }
  };
}

async function route(req, res, requestId) {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { return sendError(res, 400, 'INVALID_PATH', 'The request path is malformed.', requestId); }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'This API is read-only. Changes require a controlled ingestion or a future authenticated write workflow.', requestId);
  }

  if (pathname === '/api/v1/health') {
    const result = await pool.query('SELECT current_setting(\'server_version\') AS postgres_version, now() AS database_time');
    const migration = await pool.query('SELECT max(applied_at) AS migrated_at, count(*)::integer AS migration_count FROM reja.schema_migrations');
    return sendJson(res, 200, { status: 'ok', service: 'reja-sql', database: 'connected', postgresVersion: result.rows[0].postgres_version, databaseTime: result.rows[0].database_time, migrations: Number(migration.rows[0].migration_count), migratedAt: migration.rows[0].migrated_at, requestId });
  }

  if (pathname === '/api/v1/bootstrap') {
    const data = await loadBootstrap(pool);
    return sendJson(res, 200, { data, servedAt: new Date().toISOString(), requestId });
  }

  if (pathname === '/api/v1/metrics') {
    const [quality, latestImport, latestIssues, devMetrics] = await Promise.all([
      pool.query('SELECT * FROM reja.data_quality_summary'),
      pool.query(`SELECT id,source_name,source_sha256,status,counts,started_at,finished_at FROM reja.ingestion_runs ORDER BY id DESC LIMIT 1`),
      pool.query(`SELECT severity,issue_code,count(*)::integer AS issue_count FROM reja.data_quality_issues WHERE ingestion_run_id=(SELECT max(id) FROM reja.ingestion_runs) GROUP BY severity,issue_code ORDER BY severity,issue_code`),
      pool.query(`SELECT count(*)::integer AS developers, count(*) FILTER (WHERE tracked_project_count > 0)::integer AS with_tracked_projects FROM reja.developer_portfolio_metrics`)
    ]);
    return sendJson(res, 200, { dataQuality: quality.rows[0], latestImport: latestImport.rows[0] || null, latestImportIssues: latestIssues.rows, developerCoverage: devMetrics.rows[0], requestId });
  }

  if (pathname === '/api/v1/data-quality/issues') {
    const limit = readInt(url.searchParams.get('limit'), 50, 1, 200);
    if (limit === null) return sendError(res, 400, 'INVALID_LIMIT', 'limit must be an integer from 1 to 200.', requestId);
    const severity = url.searchParams.get('severity');
    if (severity && !['info','warning','error'].includes(severity)) return sendError(res, 400, 'INVALID_SEVERITY', 'severity must be info, warning, or error.', requestId);
    const values = [];
    let where = '';
    if (severity) { values.push(severity); where = 'WHERE q.severity = $1'; }
    values.push(limit);
    const query = `SELECT q.id,q.severity,q.issue_code,q.entity_type,q.entity_id,q.message,q.created_at,r.id AS ingestion_run_id,r.source_name
                     FROM reja.data_quality_issues q JOIN reja.ingestion_runs r ON r.id=q.ingestion_run_id ${where}
                    ORDER BY q.id DESC LIMIT $${values.length}`;
    const result = await pool.query(query, values);
    return sendJson(res, 200, { rows: result.rows, count: result.rowCount, requestId });
  }

  if (pathname === '/api/v1/sources') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 160);
    const limit = readInt(url.searchParams.get('limit'), 50, 1, 200);
    if (limit === null) return sendError(res, 400, 'INVALID_LIMIT', 'limit must be an integer from 1 to 200.', requestId);
    const result = await pool.query(
      `SELECT id,source_url,title,publisher,purpose,source_type,first_seen_at,last_seen_at
         FROM reja.sources
        WHERE is_current=true AND ($1 = '' OR lower(coalesce(title,'') || ' ' || coalesce(publisher,'') || ' ' || coalesce(source_url,'')) LIKE '%' || lower($1) || '%')
        ORDER BY display_order,id LIMIT $2`, [q, limit]
    );
    return sendJson(res, 200, { rows: result.rows, count: result.rowCount, requestId });
  }

  if (pathname === '/api/v1/assets') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 160);
    const assetType = url.searchParams.get('type') || 'project';
    const district = (url.searchParams.get('district') || '').trim().slice(0, 100);
    const status = (url.searchParams.get('status') || '').trim().slice(0, 100);
    const risk = url.searchParams.get('risk');
    const page = readInt(url.searchParams.get('page'), 1, 1, 1000000);
    const pageSize = readInt(url.searchParams.get('pageSize'), 50, 1, 100);
    if (!['project','segment','all'].includes(assetType)) return sendError(res, 400, 'INVALID_TYPE', 'type must be project, segment, or all.', requestId);
    if (risk && !['LOW','MEDIUM','HIGH','CRITICAL','UNKNOWN'].includes(risk.toUpperCase())) return sendError(res, 400, 'INVALID_RISK', 'risk must be LOW, MEDIUM, HIGH, CRITICAL, or UNKNOWN.', requestId);
    if (page === null || pageSize === null) return sendError(res, 400, 'INVALID_PAGINATION', 'page must be a positive integer and pageSize must be from 1 to 100.', requestId);
    const sortBy = url.searchParams.get('sortBy') || 'name';
    const sortColumn = sortColumns.get(sortBy);
    if (!sortColumn) return sendError(res, 400, 'INVALID_SORT', `sortBy must be one of: ${[...sortColumns.keys()].join(', ')}.`, requestId);
    const sortDirection = (url.searchParams.get('sortDir') || 'asc').toLowerCase();
    if (!['asc','desc'].includes(sortDirection)) return sendError(res, 400, 'INVALID_SORT_DIRECTION', 'sortDir must be asc or desc.', requestId);
    const where = ['a.is_current=true'];
    const params = [];
    const bind = (value) => { params.push(value); return `$${params.length}`; };
    if (assetType !== 'all') where.push(`a.asset_type=${bind(assetType)}`);
    if (district) where.push(`lower(coalesce(a.district_label,''))=lower(${bind(district)})`);
    if (status) where.push(`lower(coalesce(a.status,'')) LIKE '%' || lower(${bind(status)}) || '%'`);
    if (risk) where.push(`coalesce(a.risk_level,'UNKNOWN')=${bind(risk.toUpperCase())}`);
    if (q) where.push(`a.search_vector @@ websearch_to_tsquery('simple', ${bind(q)})`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;
    const countResult = await pool.query(`SELECT count(*)::integer AS total FROM reja.assets a ${whereSql}`, params);
    const resultParams = params.slice();
    resultParams.push(pageSize, offset);
    const rows = await pool.query(
      `SELECT a.external_id,a.asset_type,a.name,a.category,a.asset_class,a.district_label,a.sector_label,a.status,
              a.owner_name,a.unit_count,a.land_area_ha,a.start_label,a.completion_label,a.confidence_score,a.risk_score,a.risk_level,a.updated_at,a.row_version
         FROM reja.assets a ${whereSql}
        ORDER BY ${sortColumn} ${sortDirection.toUpperCase()} NULLS LAST, a.external_id ASC
        LIMIT $${resultParams.length - 1} OFFSET $${resultParams.length}`,
      resultParams
    );
    const total = countResult.rows[0].total;
    return sendJson(res, 200, { rows: rows.rows, page, pageSize, total, pages: Math.ceil(total / pageSize), requestId });
  }

  const assetMatch = pathname.match(/^\/api\/v1\/assets\/([^/]+)(?:\/(evidence))?$/);
  if (assetMatch) {
    const externalId = assetMatch[1];
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(externalId)) return sendError(res, 400, 'INVALID_ASSET_ID', 'Asset ID contains unsupported characters.', requestId);
    if (assetMatch[2] === 'evidence') {
      const details = await loadAssetEvidence(externalId);
      if (!details) return sendError(res, 404, 'ASSET_NOT_FOUND', 'No tracked asset matches that ID.', requestId);
      return sendJson(res, 200, { id: externalId, evidence: details.evidence, requestId });
    }
    const details = await loadAssetEvidence(externalId);
    if (!details) return sendError(res, 404, 'ASSET_NOT_FOUND', 'No tracked asset matches that ID.', requestId);
    return sendJson(res, 200, { ...details, requestId });
  }

  const developerMatch = pathname.match(/^\/api\/v1\/developers\/([^/]+)$/);
  if (developerMatch) {
    const externalId = developerMatch[1];
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(externalId)) return sendError(res, 400, 'INVALID_DEVELOPER_ID', 'Developer ID contains unsupported characters.', requestId);
    const result = await pool.query(
      `SELECT d.external_id,d.name,d.base,d.focus,d.payload,d.row_version,d.updated_at,m.*
         FROM reja.developers d LEFT JOIN reja.developer_portfolio_metrics m ON m.developer_id=d.external_id
        WHERE d.external_id=$1 AND d.is_current=true`, [externalId]
    );
    if (!result.rowCount) return sendError(res, 404, 'DEVELOPER_NOT_FOUND', 'No tracked developer matches that ID.', requestId);
    return sendJson(res, 200, { row: result.rows[0], requestId });
  }

  return sendError(res, 404, 'NOT_FOUND', 'The requested route does not exist.', requestId);
}

let indexHtml;
try {
  indexHtml = await fs.readFile(indexPath, 'utf8');
  if (!/<script\b(?=[^>]*\bid=["']reja-data["'])(?=[^>]*\btype=["']application\/json["'])[^>]*>/.test(indexHtml)) {
    throw new Error('public/index.html is missing the reja-data JSON script element.');
  }
  // Verify database availability and migrations before exposing the application.
  await pool.query('SELECT 1 FROM reja.schema_migrations LIMIT 1');
} catch (error) {
  console.error(`REJA startup failed: ${error.message}`);
  await pool.end().catch(() => {});
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const requestId = crypto.randomUUID();
  securityHeaders(res);
  res.setHeader('X-Request-Id', requestId);
  const started = Date.now();
  try {
    if (!req.url) return sendError(res, 400, 'BAD_REQUEST', 'Request URL is missing.', requestId);
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const bootstrap = await loadBootstrap(pool);
      const html = injectSqlSnapshot(indexHtml, bootstrap);
      if (html === indexHtml) throw new Error('Failed to inject SQL-backed dataset into the HTML template.');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    await route(req, res, requestId);
  } catch (error) {
    const status = error.code === '57014' ? 504 : 500;
    // Keep SQL text and connection details server-side; expose only a correlation ID to the client.
    console.error(JSON.stringify({ level: 'error', requestId, path: String(req.url || '/').split('?')[0], method: req.method, durationMs: Date.now() - started, code: error.code || 'INTERNAL', message: error.message }));
    if (!res.headersSent) sendError(res, status, status === 504 ? 'QUERY_TIMEOUT' : 'INTERNAL_ERROR', status === 504 ? 'The database query timed out. Try a narrower search.' : 'The request failed. Use the request ID when reviewing server logs.', requestId);
    else res.destroy();
  }
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ level: 'info', message: 'REJA SQL server listening', host, port, frontend: `http://${host}:${port}/`, health: `http://${host}:${port}/api/v1/health`, mode: process.env.NODE_ENV || 'development' }));
});

async function shutdown(signal) {
  console.log(JSON.stringify({ level: 'info', message: 'Shutting down REJA SQL server', signal }));
  server.close(async () => {
    await pool.end().catch((error) => console.error(`Pool shutdown error: ${error.message}`));
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
