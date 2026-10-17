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
const marketPath = path.join(publicDir, 'market.html');
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

function isValidDateOnly(value) {
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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

  if (pathname === '/api/v1/market/summary') {
    const [transactions, listings] = await Promise.all([
      pool.query(`
        SELECT count(*)::integer AS verified_transaction_count,
               count(*) FILTER (WHERE transaction_type='sale')::integer AS verified_sale_count,
               count(*) FILTER (WHERE transaction_type='rent')::integer AS verified_rent_count,
               count(DISTINCT lower(district_label))::integer AS districts_represented,
               count(DISTINCT currency)::integer AS currencies_represented,
               max(transaction_date) AS latest_verified_transaction_date
          FROM reja.market_verified_transactions`),
      pool.query(`
        SELECT count(*) FILTER (WHERE listing_status='active')::integer AS active_listing_count,
               count(DISTINCT lower(district_label)) FILTER (WHERE listing_status='active')::integer AS listing_districts
          FROM reja.market_listings
         WHERE is_current=true`)
    ]);
    return sendJson(res, 200, {
      summary: { ...transactions.rows[0], ...listings.rows[0] },
      dataPolicy: { transactionMetricsUseVerifiedRecordsOnly: true, askingPricesAreTransactions: false },
      requestId
    });
  }

  if (pathname === '/api/v1/market/areas') {
    const limit = readInt(url.searchParams.get('limit'), 100, 1, 300);
    if (limit === null) return sendError(res, 400, 'INVALID_LIMIT', 'limit must be an integer from 1 to 300.', requestId);
    const result = await pool.query(`
      SELECT min(district_label) AS district_label,
             coalesce(min(sector_label) FILTER (WHERE sector_label IS NOT NULL AND sector_label <> ''), '') AS sector_label,
             count(*)::integer AS verified_transaction_count,
             max(transaction_date) AS latest_transaction_date
        FROM reja.market_verified_transactions
       GROUP BY lower(district_label), lower(coalesce(sector_label,''))
       ORDER BY verified_transaction_count DESC, lower(min(district_label)), lower(min(sector_label))
       LIMIT $1`, [limit]);
    return sendJson(res, 200, { rows: result.rows, count: result.rowCount, requestId });
  }

  if (pathname === '/api/v1/market/transactions') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
    const district = (url.searchParams.get('district') || '').trim().slice(0, 100);
    const sector = (url.searchParams.get('sector') || '').trim().slice(0, 100);
    const transactionType = url.searchParams.get('type') || 'all';
    const propertyType = url.searchParams.get('propertyType') || 'all';
    const currency = (url.searchParams.get('currency') || '').toUpperCase();
    const rentPeriod = url.searchParams.get('rentPeriod') || '';
    const channel = url.searchParams.get('channel') || '';
    const paymentMethod = url.searchParams.get('paymentMethod') || '';
    const fromDate = url.searchParams.get('from') || '';
    const toDate = url.searchParams.get('to') || '';
    const page = readInt(url.searchParams.get('page'), 1, 1, 1000000);
    const pageSize = readInt(url.searchParams.get('pageSize'), 25, 1, 100);
    const propertyTypes = ['apartment','house','land','commercial','industrial','mixed_use','other','unknown'];
    if (!['all','sale','rent'].includes(transactionType)) return sendError(res, 400, 'INVALID_TRANSACTION_TYPE', 'type must be all, sale, or rent.', requestId);
    if (propertyType !== 'all' && !propertyTypes.includes(propertyType)) return sendError(res, 400, 'INVALID_PROPERTY_TYPE', 'propertyType is not supported.', requestId);
    if (currency && !/^[A-Z]{3}$/.test(currency)) return sendError(res, 400, 'INVALID_CURRENCY', 'currency must be a three-letter uppercase code.', requestId);
    if (rentPeriod && !['daily','weekly','monthly','yearly','not_applicable'].includes(rentPeriod)) return sendError(res, 400, 'INVALID_RENT_PERIOD', 'rentPeriod is not supported.', requestId);
    if (channel && !['primary','resale','off_plan','unknown'].includes(channel)) return sendError(res, 400, 'INVALID_CHANNEL', 'channel is not supported.', requestId);
    if (paymentMethod && !['cash','mortgage','installment','unknown'].includes(paymentMethod)) return sendError(res, 400, 'INVALID_PAYMENT_METHOD', 'paymentMethod is not supported.', requestId);
    if (fromDate && !isValidDateOnly(fromDate)) return sendError(res, 400, 'INVALID_FROM_DATE', 'from must be a real date in YYYY-MM-DD format.', requestId);
    if (toDate && !isValidDateOnly(toDate)) return sendError(res, 400, 'INVALID_TO_DATE', 'to must be a real date in YYYY-MM-DD format.', requestId);
    if (fromDate && toDate && fromDate > toDate) return sendError(res, 400, 'INVALID_DATE_RANGE', 'from must be on or before to.', requestId);
    if (page === null || pageSize === null) return sendError(res, 400, 'INVALID_PAGINATION', 'page must be positive and pageSize must be from 1 to 100.', requestId);
    const sortMap = new Map([
      ['date','t.transaction_date'], ['amount','t.amount'], ['pricePerSqm','t.price_per_sqm'],
      ['area','t.property_area_sqm'], ['district','lower(t.district_label)'],
      ['project','lower(coalesce(a.name,p.project_name,p.building_name,\'\'))']
    ]);
    const sortBy = url.searchParams.get('sortBy') || 'date';
    const sortColumn = sortMap.get(sortBy);
    if (!sortColumn) return sendError(res, 400, 'INVALID_SORT', `sortBy must be one of: ${[...sortMap.keys()].join(', ')}.`, requestId);
    const sortDir = (url.searchParams.get('sortDir') || 'desc').toLowerCase();
    if (!['asc','desc'].includes(sortDir)) return sendError(res, 400, 'INVALID_SORT_DIRECTION', 'sortDir must be asc or desc.', requestId);

    const where = ["t.is_current=true", "t.verification_status='verified'"];
    const params = [];
    const bind = value => { params.push(value); return `$${params.length}`; };
    if (transactionType !== 'all') where.push(`t.transaction_type=${bind(transactionType)}`);
    if (propertyType !== 'all') where.push(`t.property_type=${bind(propertyType)}`);
    if (currency) where.push(`t.currency=${bind(currency)}`);
    if (rentPeriod) where.push(`t.rent_period=${bind(rentPeriod)}`);
    if (channel) where.push(`t.transaction_channel=${bind(channel)}`);
    if (paymentMethod) where.push(`t.payment_method=${bind(paymentMethod)}`);
    if (district) where.push(`lower(t.district_label)=lower(${bind(district)})`);
    if (sector) where.push(`lower(coalesce(t.sector_label,''))=lower(${bind(sector)})`);
    if (fromDate) where.push(`t.transaction_date >= ${bind(fromDate)}::date`);
    if (toDate) where.push(`t.transaction_date <= ${bind(toDate)}::date`);
    if (q) where.push(`(lower(t.district_label || ' ' || coalesce(t.sector_label,'') || ' ' || coalesce(p.project_name,'') || ' ' || coalesce(p.building_name,'') || ' ' || coalesce(p.unit_label,'') || ' ' || coalesce(a.name,'')) LIKE '%' || lower(${bind(q)}) || '%')`);
    const fromSql = `FROM reja.market_verified_transactions t
      LEFT JOIN reja.market_properties p ON p.id=t.property_id
      LEFT JOIN reja.assets a ON a.id=coalesce(t.asset_id,p.asset_id) AND a.is_current=true
      JOIN reja.sources s ON s.id=t.source_id
      LEFT JOIN LATERAL (
        SELECT count(*)::integer AS corroborating_source_count
          FROM reja.market_transaction_evidence e
         WHERE e.transaction_id=t.id AND e.is_current=true
      ) ev ON true`;
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const counts = await pool.query(`SELECT count(*)::integer AS total ${fromSql} ${whereSql}`, params);
    const offset = (page - 1) * pageSize;
    const dataParams = [...params, pageSize, offset];
    const rows = await pool.query(`
      SELECT t.id, t.transaction_date, t.transaction_type, t.amount, t.currency, t.rent_period,
             t.price_per_sqm, t.property_area_sqm, t.property_type, t.district_label, t.sector_label,
             t.transaction_channel, t.payment_method, t.verification_status,
             coalesce(a.name,p.project_name,p.building_name) AS project_name,
             p.building_name, p.unit_label, s.title AS source_title, s.publisher AS source_publisher, s.source_url,
             coalesce(ev.corroborating_source_count,0)::integer AS corroborating_source_count
        ${fromSql} ${whereSql}
       ORDER BY ${sortColumn} ${sortDir.toUpperCase()} NULLS LAST, t.transaction_date DESC, t.id DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`, dataParams);
    const total = counts.rows[0].total;
    return sendJson(res, 200, { rows: rows.rows, page, pageSize, total, pages: Math.ceil(total / pageSize), filters: { type: transactionType, propertyType, currency: currency || null, district: district || null, sector: sector || null, from: fromDate || null, to: toDate || null }, requestId });
  }

  if (pathname === '/api/v1/market/trends') {
    const district = (url.searchParams.get('district') || '').trim().slice(0, 100);
    const sector = (url.searchParams.get('sector') || '').trim().slice(0, 100);
    const transactionType = url.searchParams.get('type') || 'sale';
    const propertyType = url.searchParams.get('propertyType') || 'apartment';
    const currency = (url.searchParams.get('currency') || 'RWF').toUpperCase();
    const rentPeriod = url.searchParams.get('rentPeriod') || (transactionType === 'rent' ? 'monthly' : 'not_applicable');
    const fromDate = url.searchParams.get('from') || '';
    const toDate = url.searchParams.get('to') || '';
    const limit = readInt(url.searchParams.get('limit'), 120, 1, 600);
    if (!['all','sale','rent'].includes(transactionType)) return sendError(res, 400, 'INVALID_TRANSACTION_TYPE', 'type must be all, sale, or rent.', requestId);
    if (!['all','apartment','house','land','commercial','industrial','mixed_use','other','unknown'].includes(propertyType)) return sendError(res, 400, 'INVALID_PROPERTY_TYPE', 'propertyType is not supported.', requestId);
    if (!/^[A-Z]{3}$/.test(currency)) return sendError(res, 400, 'INVALID_CURRENCY', 'currency must be a three-letter code.', requestId);
    if (rentPeriod && !['daily','weekly','monthly','yearly','not_applicable'].includes(rentPeriod)) return sendError(res, 400, 'INVALID_RENT_PERIOD', 'rentPeriod is not supported.', requestId);
    if (fromDate && !isValidDateOnly(fromDate)) return sendError(res, 400, 'INVALID_FROM_DATE', 'from must be a real date in YYYY-MM-DD format.', requestId);
    if (toDate && !isValidDateOnly(toDate)) return sendError(res, 400, 'INVALID_TO_DATE', 'to must be a real date in YYYY-MM-DD format.', requestId);
    if (fromDate && toDate && fromDate > toDate) return sendError(res, 400, 'INVALID_DATE_RANGE', 'from must be on or before to.', requestId);
    if (limit === null) return sendError(res, 400, 'INVALID_LIMIT', 'limit must be from 1 to 600.', requestId);
    const where = ["is_current=true", "verification_status='verified'", "currency=$1"];
    const params = [currency];
    const bind = value => { params.push(value); return `$${params.length}`; };
    if (transactionType !== 'all') where.push(`transaction_type=${bind(transactionType)}`);
    if (propertyType !== 'all') where.push(`property_type=${bind(propertyType)}`);
    if (rentPeriod) where.push(`rent_period=${bind(rentPeriod)}`);
    if (district) where.push(`lower(district_label)=lower(${bind(district)})`);
    if (sector) where.push(`lower(coalesce(sector_label,''))=lower(${bind(sector)})`);
    if (fromDate) where.push(`transaction_date >= ${bind(fromDate)}::date`);
    if (toDate) where.push(`transaction_date <= ${bind(toDate)}::date`);
    params.push(limit);
    const result = await pool.query(`
      SELECT date_trunc('month', transaction_date)::date AS month_start,
             currency, rent_period, transaction_type, property_type,
             count(*)::integer AS transaction_count,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY amount)::numeric(20,2) AS median_amount,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_sqm)::numeric(20,2) AS median_price_per_sqm,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY property_area_sqm)::numeric(14,2) AS median_area_sqm
        FROM reja.market_verified_transactions
       WHERE ${where.join(' AND ')}
       GROUP BY date_trunc('month', transaction_date)::date, currency, rent_period, transaction_type, property_type
       ORDER BY month_start ASC
       LIMIT $${params.length}`, params);
    return sendJson(res, 200, { rows: result.rows, count: result.rowCount, filters: { type: transactionType, propertyType, currency, rentPeriod, district: district || null, sector: sector || null, from: fromDate || null, to: toDate || null }, requestId });
  }

  if (pathname === '/api/v1/market/listings') {
    const district = (url.searchParams.get('district') || '').trim().slice(0, 100);
    const sector = (url.searchParams.get('sector') || '').trim().slice(0, 100);
    const listingType = url.searchParams.get('type') || 'sale';
    const propertyType = url.searchParams.get('propertyType') || 'all';
    const currency = (url.searchParams.get('currency') || '').toUpperCase();
    const page = readInt(url.searchParams.get('page'), 1, 1, 1000000);
    const pageSize = readInt(url.searchParams.get('pageSize'), 12, 1, 100);
    const propertyTypes = ['apartment','house','land','commercial','industrial','mixed_use','other','unknown'];
    if (!['all','sale','rent'].includes(listingType)) return sendError(res, 400, 'INVALID_LISTING_TYPE', 'type must be all, sale, or rent.', requestId);
    if (propertyType !== 'all' && !propertyTypes.includes(propertyType)) return sendError(res, 400, 'INVALID_PROPERTY_TYPE', 'propertyType is not supported.', requestId);
    if (currency && !/^[A-Z]{3}$/.test(currency)) return sendError(res, 400, 'INVALID_CURRENCY', 'currency must be a three-letter uppercase code.', requestId);
    if (page === null || pageSize === null) return sendError(res, 400, 'INVALID_PAGINATION', 'page must be positive and pageSize must be from 1 to 100.', requestId);
    const where = ["l.is_current=true", "l.listing_status='active'"];
    const params = [];
    const bind = value => { params.push(value); return `$${params.length}`; };
    if (listingType !== 'all') where.push(`l.listing_type=${bind(listingType)}`);
    if (propertyType !== 'all') where.push(`l.property_type=${bind(propertyType)}`);
    if (currency) where.push(`l.currency=${bind(currency)}`);
    if (district) where.push(`lower(l.district_label)=lower(${bind(district)})`);
    if (sector) where.push(`lower(coalesce(l.sector_label,''))=lower(${bind(sector)})`);
    const fromSql = `FROM reja.market_listings l
      LEFT JOIN reja.market_properties p ON p.id=l.property_id
      LEFT JOIN reja.assets a ON a.id=coalesce(l.asset_id,p.asset_id) AND a.is_current=true
      JOIN reja.sources s ON s.id=l.source_id`;
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const counts = await pool.query(`SELECT count(*)::integer AS total ${fromSql} ${whereSql}`, params);
    const dataParams = [...params, pageSize, (page - 1) * pageSize];
    const result = await pool.query(`
      SELECT l.id,l.listing_type,l.asking_amount,l.currency,l.rent_period,l.asking_price_per_sqm,
             l.property_area_sqm,l.property_type,l.district_label,l.sector_label,l.listing_url,
             l.first_seen_at,l.last_seen_at,
             coalesce(a.name,p.project_name,p.building_name) AS project_name,
             p.building_name,p.unit_label,s.title AS source_title,s.publisher AS source_publisher,s.source_url
        ${fromSql} ${whereSql}
       ORDER BY l.last_seen_at DESC,l.id DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`, dataParams);
    const total = counts.rows[0].total;
    return sendJson(res, 200, { rows: result.rows, page, pageSize, total, pages: Math.ceil(total / pageSize), requestId });
  }

  if (pathname === '/api/v1/market/projects/compare') {
    const idsRaw = url.searchParams.get('ids') || '';
    const ids = [...new Set(idsRaw.split(',').map(value => value.trim()).filter(Boolean))];
    if (ids.length < 1 || ids.length > 10 || ids.some(id => !/^[A-Za-z0-9._-]{1,80}$/.test(id))) {
      return sendError(res, 400, 'INVALID_PROJECT_IDS', 'Provide 1 to 10 comma-separated valid project IDs in ids.', requestId);
    }
    const result = await pool.query(`
      SELECT project_id, project_name, transaction_type, currency, rent_period, transaction_channel,
             transaction_count, distinct_property_count, median_amount, median_price_per_sqm,
             median_area_sqm, latest_transaction_date
        FROM reja.market_project_metrics
       WHERE project_id = ANY($1::text[])
       ORDER BY project_name, transaction_type, currency, rent_period, transaction_channel`, [ids]);
    return sendJson(res, 200, { requestedProjectIds: ids, rows: result.rows, count: result.rowCount, note: result.rowCount ? null : 'No verified linked transaction records were found for these projects.', requestId });
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
let marketHtml;
try {
  indexHtml = await fs.readFile(indexPath, 'utf8');
  marketHtml = await fs.readFile(marketPath, 'utf8');
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
    if (req.method === 'GET' && (url.pathname === '/market' || url.pathname === '/market.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(marketHtml) });
      return res.end(marketHtml);
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
