import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { extractEmbeddedData, importKey, sha256, yearFromLabel, validateLegacyData, normaliseSourceType } from '../src/legacy-data.mjs';
import { withTransaction } from '../src/db.mjs';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const inputPath = path.resolve(process.argv[2] || process.env.REJA_HTML_PATH || path.join(root, 'public/REJA-standalone.html'));
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required. Start PostgreSQL and set DATABASE_URL before importing.');
  process.exit(1);
}

function json(value) { return JSON.stringify(value === undefined ? null : value); }
function meaningfulUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null;
    // Canonical source identity: normalise host/default ports and ignore page fragments.
    parsed.hash = '';
    return parsed.toString();
  } catch { return null; }
}

const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 30_000, application_name: 'reja-importer' });
let runId = null;
try {
  const html = await fs.readFile(inputPath, 'utf8');
  const sourceSha = sha256(html);
  const data = extractEmbeddedData(html);
  const rowCounts = validateLegacyData(data);
  const runInsert = await pool.query(
    `INSERT INTO reja.ingestion_runs(source_name, source_sha256, status)
     VALUES ($1, $2, 'started') RETURNING id`,
    [path.basename(inputPath), sourceSha]
  );
  runId = runInsert.rows[0].id;

  const report = await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('reja:html-import'))");
    // Snapshot flags are reset inside this transaction; old rows remain queryable for audit/history.
    await client.query('UPDATE reja.assets SET is_current=false');
    await client.query('UPDATE reja.developers SET is_current=false');
    await client.query('UPDATE reja.sources SET is_current=false');
    await client.query('UPDATE reja.asset_timeline_events SET is_current=false');
    await client.query('UPDATE reja.asset_assessment_factors SET is_current=false');
    await client.query('UPDATE reja.asset_conflicts SET is_current=false');
    await client.query('UPDATE reja.asset_developers SET is_current=false');
    await client.query('UPDATE reja.asset_source_links SET is_current=false');
    await client.query('UPDATE reja.owner_groups SET is_current=false');
    await client.query('UPDATE reja.owner_group_assets SET is_current=false');
    await client.query('UPDATE reja.asset_field_claims SET is_current=false');
    const sourceIdByUrl = new Map();
    const assetIdByExternal = new Map();
    const developerIdSet = new Set(data.developers.map((d) => d.id));
    const issueRows = [];
    const counts = { ...rowCounts, fieldClaims: 0, timelineEvents: 0, riskFactors: 0, confidenceFactors: 0, conflicts: 0, relations: 0, newSourcesForFieldRefs: 0 };

    async function addIssue(severity, code, entityType, entityId, message) {
      const fingerprint = importKey(severity, code, entityType, entityId || '', message);
      issueRows.push({ severity, code, entityType, entityId: entityId || null, message, fingerprint });
    }

    async function upsertSource(url, meta = {}, displayOrder = 0, explicitSourceKey = null) {
      const safeUrl = meaningfulUrl(url);
      if (!safeUrl && !explicitSourceKey) return null;
      const sourceKey = safeUrl ? `url:${safeUrl}` : explicitSourceKey;
      if (safeUrl && sourceIdByUrl.has(safeUrl)) return sourceIdByUrl.get(safeUrl);
      const payload = meta && typeof meta === 'object' ? meta : {};
      const result = await client.query(
        `INSERT INTO reja.sources(source_key, source_url, display_order, title, publisher, purpose, source_type, is_current, payload, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8::jsonb,now())
         ON CONFLICT (source_key) DO UPDATE SET
           display_order = LEAST(reja.sources.display_order, EXCLUDED.display_order),
           title = COALESCE(EXCLUDED.title, reja.sources.title),
           publisher = COALESCE(EXCLUDED.publisher, reja.sources.publisher),
           purpose = COALESCE(EXCLUDED.purpose, reja.sources.purpose),
           source_type = CASE WHEN reja.sources.source_type = 'unclassified' THEN EXCLUDED.source_type ELSE reja.sources.source_type END,
           payload = CASE WHEN EXCLUDED.payload <> '{}'::jsonb THEN EXCLUDED.payload ELSE reja.sources.payload END,
           is_current = true, last_seen_at = now()
         RETURNING id`,
        [sourceKey, safeUrl, displayOrder, payload.source ?? null, payload.publisher ?? null, payload.use ?? null,
          normaliseSourceType(payload), json(payload)]
      );
      const id = result.rows[0].id;
      if (safeUrl) sourceIdByUrl.set(safeUrl, id);
      return id;
    }

    // Canonical web URLs merge by URL; the two explicitly user-uploaded local CSV references stay separate.
    for (let i = 0; i < data.sources.length; i += 1) {
      const source = data.sources[i];
      const safeUrl = meaningfulUrl(source.url);
      const key = safeUrl ? null : `legacy-catalog:${i}:${importKey(source.source, source.publisher, source.use)}`;
      await upsertSource(source.url, source, i, key);
    }

    for (let i = 0; i < data.developers.length; i += 1) {
      const d = data.developers[i];
      await client.query(
        `INSERT INTO reja.developers(external_id, display_order, name, base, focus, is_current, payload)
         VALUES ($1,$2,$3,$4,$5,true,$6::jsonb)
         ON CONFLICT (external_id) DO UPDATE SET
           display_order = EXCLUDED.display_order, name = EXCLUDED.name, base = EXCLUDED.base,
           focus = EXCLUDED.focus, is_current = true,
           row_version = reja.developers.row_version + CASE WHEN reja.developers.payload IS DISTINCT FROM EXCLUDED.payload THEN 1 ELSE 0 END,
           updated_at = CASE WHEN reja.developers.payload IS DISTINCT FROM EXCLUDED.payload THEN now() ELSE reja.developers.updated_at END,
           payload = EXCLUDED.payload`,
        [d.id, i, d.name, d.base ?? null, d.focus ?? null, json(d)]
      );
    }

    const allAssets = [
      ...data.projects.map((a, i) => ({ ...a, __asset_type: 'project', __order: i })),
      ...data.segments.map((a, i) => ({ ...a, __asset_type: 'segment', __order: i }))
    ];

    for (const a of allAssets) {
      const startLabel = typeof a.start === 'string' ? a.start : null;
      const completionLabel = typeof a.completion === 'string' ? a.completion : null;
      const result = await client.query(
        `INSERT INTO reja.assets(
           external_id, asset_type, display_order, name, category, asset_class, district_label,
           sector_label, status, route, owner_name, owner_key, unit_count, land_area_ha,
           start_label, start_year, completion_label, completion_year, confidence_score, risk_score,
           risk_level, is_current, payload
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,true,$22::jsonb)
         ON CONFLICT (external_id) DO UPDATE SET
           asset_type=EXCLUDED.asset_type, display_order=EXCLUDED.display_order, name=EXCLUDED.name,
           category=EXCLUDED.category, asset_class=EXCLUDED.asset_class, district_label=EXCLUDED.district_label,
           sector_label=EXCLUDED.sector_label, status=EXCLUDED.status, route=EXCLUDED.route,
           owner_name=EXCLUDED.owner_name, owner_key=EXCLUDED.owner_key, unit_count=EXCLUDED.unit_count,
           land_area_ha=EXCLUDED.land_area_ha, start_label=EXCLUDED.start_label, start_year=EXCLUDED.start_year,
           completion_label=EXCLUDED.completion_label, completion_year=EXCLUDED.completion_year,
           confidence_score=EXCLUDED.confidence_score, risk_score=EXCLUDED.risk_score, risk_level=EXCLUDED.risk_level, is_current=true,
           row_version = reja.assets.row_version + CASE WHEN reja.assets.payload IS DISTINCT FROM EXCLUDED.payload THEN 1 ELSE 0 END,
           updated_at = CASE WHEN reja.assets.payload IS DISTINCT FROM EXCLUDED.payload THEN now() ELSE reja.assets.updated_at END,
           payload=EXCLUDED.payload
         RETURNING id`,
        [a.id, a.__asset_type, a.__order, a.name, a.category ?? null, a.assetClass ?? null,
          a.district ?? null, a.sector ?? null, a.status ?? null, a.route ?? null, a.ownerName ?? null,
          a.ownerKey ?? null, a.units ?? null, a.land_ha ?? null, startLabel, yearFromLabel(startLabel),
          completionLabel, yearFromLabel(completionLabel), a.dataConfidence ?? null, a.riskScore ?? null,
          a.riskLevel ?? 'UNKNOWN', json(Object.fromEntries(Object.entries(a).filter(([k]) => !k.startsWith('__'))))]
      );
      assetIdByExternal.set(a.id, result.rows[0].id);
    }

    // Keep relationship lineage: a project's stated primary developer is stronger than a developer's portfolio list.
    for (const a of allAssets) {
      const assetId = assetIdByExternal.get(a.id);
      const directDevId = a.developerId;
      if (directDevId && developerIdSet.has(directDevId)) {
        await client.query(
          `INSERT INTO reja.asset_developers(asset_id, developer_id, relationship_role, relationship_source,is_current)
           VALUES ($1,$2,'primary','asset_record',true)
           ON CONFLICT (asset_id, developer_id) DO UPDATE SET relationship_role='primary', relationship_source='asset_record',is_current=true,last_seen_at=now()`,
          [assetId, directDevId]
        );
      } else if (directDevId) {
        await addIssue('warning', 'UNKNOWN_DEVELOPER_REFERENCE', 'asset', a.id, `developerId points to ${directDevId}, which is not in the developer table.`);
      }
      const primaryUrl = meaningfulUrl(a.source);
      if (primaryUrl) {
        const sourceId = await upsertSource(primaryUrl, {}, 100000);
        await client.query(
          `INSERT INTO reja.asset_source_links(asset_id, source_id, source_role, field_key,is_current)
           VALUES ($1,$2,'primary','',true) ON CONFLICT (asset_id,source_id,source_role,field_key) DO UPDATE SET is_current=true,last_seen_at=now()`, [assetId, sourceId]
        );
      } else {
        await addIssue('warning', 'NO_PRIMARY_SOURCE', 'asset', a.id, 'No project-level source URL is recorded on this asset.');
      }
      if (String(a.district || '').trim().toLowerCase() === 'kigali') {
        await addIssue('warning', 'PLACE_LABEL_NEEDS_REVIEW', 'asset', a.id, 'The district label is “Kigali”; confirm whether this should be a city/province label or a district.');
      }
      if (String(a.status || '').toLowerCase().includes('verify')) {
        await addIssue('warning', 'STATUS_UNVERIFIED', 'asset', a.id, 'Status text explicitly indicates that verification is still required.');
      }
      if (a.__asset_type === 'segment') {
        await addIssue('info', 'SEGMENT_NOT_PROJECT', 'asset', a.id, 'This is a multi-developer market segment placeholder; it is stored separately from tracked projects.');
      }

      for (const [fieldKey, fieldValue] of Object.entries(a.fields || {})) {
        const claim = fieldValue && typeof fieldValue === 'object' ? fieldValue : { value: fieldValue, status: 'unknown', source: null };
        const sourceUrl = meaningfulUrl(claim.source);
        const sourceId = sourceUrl ? await upsertSource(sourceUrl, {}, 100000) : null;
        const status = ['verified','unverified','unknown','conflicted','inferred','disputed'].includes(claim.status) ? claim.status : 'unknown';
        const key = importKey(a.id, fieldKey, claim.value, status, sourceUrl);
        await client.query(
          `INSERT INTO reja.asset_field_claims(asset_id,field_key,value_json,claim_status,source_id,source_label,import_key,payload)
           VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8::jsonb)
           ON CONFLICT (import_key) DO UPDATE SET last_seen_at=now(), is_current=true`,
          [assetId, fieldKey, json(claim.value), status, sourceId, typeof claim.source === 'string' ? claim.source : null, key, json(claim)]
        );
        if (sourceId) {
          await client.query(
            `INSERT INTO reja.asset_source_links(asset_id,source_id,source_role,field_key,is_current)
             VALUES ($1,$2,'field_claim',$3,true) ON CONFLICT (asset_id,source_id,source_role,field_key) DO UPDATE SET is_current=true,last_seen_at=now()`, [assetId, sourceId, fieldKey]
          );
        }
        counts.fieldClaims += 1;
      }

      for (let i = 0; i < (a.timeline || []).length; i += 1) {
        const event = a.timeline[i] || {};
        const sourceUrl = meaningfulUrl(event.source);
        const sourceId = sourceUrl ? await upsertSource(sourceUrl, {}, 100000) : null;
        const dateLabel = event.date === undefined || event.date === null ? null : String(event.date);
        const eventYear = yearFromLabel(dateLabel);
        const key = importKey(a.id, i, dateLabel, event.event ?? '', sourceUrl, event.confidence ?? '');
        await client.query(
          `INSERT INTO reja.asset_timeline_events(asset_id,display_order,date_label,event_year,event_text,confidence_label,source_id,import_key,is_current,payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9::jsonb)
           ON CONFLICT (import_key) DO UPDATE SET is_current=true,last_seen_at=now()`,
          [assetId, i, dateLabel, eventYear, event.event || 'Timeline event not described', event.confidence ?? null, sourceId, key, json(event)]
        );
        if (sourceId) await client.query(`INSERT INTO reja.asset_source_links(asset_id,source_id,source_role,field_key,is_current) VALUES ($1,$2,'timeline','',true) ON CONFLICT (asset_id,source_id,source_role,field_key) DO UPDATE SET is_current=true,last_seen_at=now()`, [assetId, sourceId]);
        counts.timelineEvents += 1;
      }

      const reasonScoreSum = (a.riskReasons || []).reduce((sum, reason) => sum + (Array.isArray(reason) && Number.isFinite(reason[1]) ? reason[1] : 0), 0);
      if (Number.isFinite(a.riskScore) && (a.riskReasons || []).length && reasonScoreSum !== a.riskScore) {
        await addIssue('warning', 'RISK_SCORE_FACTOR_SUM_MISMATCH', 'asset', a.id, `Stored risk score is ${a.riskScore}, but the listed factor values sum to ${reasonScoreSum}; confirm the scoring formula or any cap/adjustment.`);
      }
      for (let i = 0; i < (a.riskReasons || []).length; i += 1) {
        const item = a.riskReasons[i] || [];
        const key = importKey(a.id, 'risk', i, item);
        await client.query(
          `INSERT INTO reja.asset_assessment_factors(asset_id,factor_kind,display_order,factor_label,numeric_value,status_value,import_key,is_current,payload)
           VALUES ($1,'risk',$2,$3,$4,NULL,$5,true,$6::jsonb) ON CONFLICT (import_key) DO UPDATE SET is_current=true`,
          [assetId, i, String(item[0] ?? 'Unlabelled risk factor'), Number.isFinite(item[1]) ? item[1] : null, key, json(item)]
        );
        counts.riskFactors += 1;
      }
      for (let i = 0; i < (a.confidenceReasons || []).length; i += 1) {
        const item = a.confidenceReasons[i] || [];
        const key = importKey(a.id, 'confidence', i, item);
        await client.query(
          `INSERT INTO reja.asset_assessment_factors(asset_id,factor_kind,display_order,factor_label,numeric_value,status_value,import_key,is_current,payload)
           VALUES ($1,'confidence',$2,$3,NULL,$4,$5,true,$6::jsonb) ON CONFLICT (import_key) DO UPDATE SET is_current=true`,
          [assetId, i, String(item[0] ?? 'Unlabelled confidence factor'), typeof item[1] === 'string' ? item[1] : null, key, json(item)]
        );
        counts.confidenceFactors += 1;
      }

      for (let i = 0; i < (a.conflicts || []).length; i += 1) {
        const conflictText = String(a.conflicts[i]);
        const key = importKey(a.id, 'conflict', conflictText);
        await client.query(
          `INSERT INTO reja.asset_conflicts(asset_id,conflict_text,import_key,is_current)
           VALUES ($1,$2,$3,true) ON CONFLICT (import_key) DO UPDATE SET is_current=true`, [assetId, conflictText, key]
        );
        counts.conflicts += 1;
      }
    }

    // Add portfolio-listed links without overriding a stronger asset-level primary developer assertion.
    for (const d of data.developers) {
      for (const assetExternalId of Array.isArray(d.projectIds) ? d.projectIds : []) {
        const assetId = assetIdByExternal.get(assetExternalId);
        if (!assetId) {
          await addIssue('warning', 'ORPHAN_DEVELOPER_PORTFOLIO_ID', 'developer', d.id, `Portfolio contains asset ID ${assetExternalId}, which is absent from this snapshot.`);
          continue;
        }
        await client.query(
          `INSERT INTO reja.asset_developers(asset_id,developer_id,relationship_role,relationship_source,is_current)
           VALUES ($1,$2,'associated','developer_portfolio',true)
           ON CONFLICT (asset_id,developer_id) DO UPDATE SET
             relationship_role = CASE WHEN reja.asset_developers.is_current=true AND reja.asset_developers.relationship_role='primary' THEN 'primary' ELSE 'associated' END,
             relationship_source = CASE WHEN reja.asset_developers.is_current=true AND reja.asset_developers.relationship_role='primary' THEN reja.asset_developers.relationship_source ELSE 'developer_portfolio' END,
             is_current=true,last_seen_at=now()`,
          [assetId, d.id]
        );
      }
    }

    let gi = 0;
    for (const [groupName, memberIds] of Object.entries(data.ownerGroups || {})) {
      const safeMembers = Array.isArray(memberIds) ? memberIds : [];
      await client.query(
        `INSERT INTO reja.owner_groups(group_name,display_order,is_current,payload)
         VALUES ($1,$2,true,$3::jsonb) ON CONFLICT (group_name) DO UPDATE SET display_order=EXCLUDED.display_order,is_current=true,payload=EXCLUDED.payload,updated_at=now()`,
        [groupName, gi++, json(safeMembers)]
      );
      for (const externalId of safeMembers) {
        const assetId = assetIdByExternal.get(externalId);
        if (!assetId) {
          await addIssue('warning', 'ORPHAN_OWNER_GROUP_ID', 'owner_group', groupName, `Owner group includes asset ID ${externalId}, which is absent from this snapshot.`);
          continue;
        }
        await client.query(`INSERT INTO reja.owner_group_assets(group_name,asset_id,is_current) VALUES ($1,$2,true) ON CONFLICT (group_name,asset_id) DO UPDATE SET is_current=true,last_seen_at=now()`, [groupName, assetId]);
      }
    }

    // Keep an import report, including non-fatal data-quality flags for analyst follow-up.
    for (const issue of issueRows) {
      await client.query(
        `INSERT INTO reja.data_quality_issues(ingestion_run_id,severity,issue_code,entity_type,entity_id,message,issue_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (ingestion_run_id,issue_fingerprint) DO NOTHING`,
        [runId, issue.severity, issue.code, issue.entityType, issue.entityId, issue.message, issue.fingerprint]
      );
    }

    // Keep a compact append-only audit event; raw payloads remain in canonical rows as migration evidence.
    await client.query(
      `INSERT INTO reja.audit_log(actor_key,event_name,entity_type,entity_key,after_data,correlation_id)
       VALUES ('importer','snapshot_imported','ingestion_run',$1,$2::jsonb,$1)`,
      [String(runId), json({ source: path.basename(inputPath), sourceSha, counts, issueCount: issueRows.length })]
    );
    return { counts, issueCount: issueRows.length, issuesBySeverity: issueRows.reduce((o, x) => (o[x.severity] = (o[x.severity] || 0) + 1, o), {}) };
  }, { isolation: 'SERIALIZABLE' });

  await pool.query(
    `UPDATE reja.ingestion_runs SET status='completed', finished_at=now(), counts=$2::jsonb WHERE id=$1`,
    [runId, json(report)]
  );
  console.log(JSON.stringify({ status: 'completed', runId, inputPath, sourceSha256: sha256(await fs.readFile(inputPath)), ...report }, null, 2));
} catch (error) {
  if (runId !== null) {
    await pool.query(`UPDATE reja.ingestion_runs SET status='failed',finished_at=now(),error_message=$2 WHERE id=$1`, [runId, String(error.stack || error.message).slice(0, 8000)]).catch(() => {});
  }
  console.error(`Import failed${runId ? ` (run ${runId})` : ''}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
