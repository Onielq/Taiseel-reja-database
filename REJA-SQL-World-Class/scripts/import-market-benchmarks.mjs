import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = path.resolve(root, process.argv[2] || 'data/rwanda-land-dashboard-benchmarks.json');

function fail(message) { throw new Error(message); }
function requiredString(v, label, max = 1200) {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) fail(`${label} must be a non-empty string no longer than ${max} characters.`);
  return v.trim();
}
function validDate(v, label) {
  const value = requiredString(v, label, 10);
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) fail(`${label} must use YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail(`${label} must be a real date.`);
  return value;
}
function amount(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1e15) fail(`${label} must be a positive finite amount.`);
  return n.toFixed(2);
}
function validateSource(source, index) {
  const label = `sources[${index}]`;
  const sourceKey = requiredString(source.sourceKey, `${label}.sourceKey`, 160);
  const url = requiredString(source.sourceUrl, `${label}.sourceUrl`, 4096);
  let parsed;
  try { parsed = new URL(url); } catch { fail(`${label}.sourceUrl must be a valid URL.`); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'rwandalanddashboard.lands.rw') {
    fail(`${label}.sourceUrl must be an HTTPS Rwanda Land Dashboard URL.`);
  }
  if (source.sourceType !== 'government') fail(`${label}.sourceType must be government.`);
  return {
    sourceKey, sourceUrl: parsed.href,
    title: requiredString(source.title, `${label}.title`, 300),
    publisher: requiredString(source.publisher, `${label}.publisher`, 300),
    purpose: requiredString(source.purpose, `${label}.purpose`, 2000),
    sourceType: 'government',
    observedOn: validDate(source.observedOn, `${label}.observedOn`),
    sourcePeriodLabel: requiredString(source.sourcePeriodLabel, `${label}.sourcePeriodLabel`, 600),
    methodologyNote: requiredString(source.methodologyNote, `${label}.methodologyNote`, 2000)
  };
}
function validateBenchmark(row, index, sourcesByKey) {
  const label = `benchmarks[${index}]`;
  const sourceKey = requiredString(row.sourceKey, `${label}.sourceKey`, 160);
  const source = sourcesByKey.get(sourceKey);
  if (!source) fail(`${label}.sourceKey does not refer to a declared source.`);
  const benchmarkKind = row.benchmarkKind;
  const districtKind = benchmarkKind === 'district_average_land_price';
  const landUseKind = benchmarkKind === 'land_use_transaction_average';
  if (!districtKind && !landUseKind) fail(`${label}.benchmarkKind is not supported.`);
  if (row.geographyLevel !== (districtKind ? 'district' : 'land_use')) fail(`${label}.geographyLevel does not match benchmarkKind.`);
  if (row.metricCode !== (districtKind ? 'district_average_land_price_per_sqm' : 'average_land_price_per_sqm_by_existing_use')) fail(`${label}.metricCode does not match benchmarkKind.`);
  if (row.unitCode !== 'RWF_PER_SQM' || row.currency !== 'RWF') fail(`${label} must use RWF per square metre.`);
  const district = districtKind ? requiredString(row.district, `${label}.district`, 120) : null;
  const landUse = landUseKind ? requiredString(row.landUse, `${label}.landUse`, 120) : null;
  if (districtKind && row.landUse != null) fail(`${label}.landUse must be null for a district average.`);
  if (landUseKind && row.district != null) fail(`${label}.district must be null for a land-use average.`);
  return {
    sourceKey,
    sourceRecordKey: requiredString(row.sourceRecordKey, `${label}.sourceRecordKey`, 200),
    benchmarkKind, geographyLevel: row.geographyLevel,
    district, landUse, metricCode: row.metricCode, amount: amount(row.amount, `${label}.amount`),
    currency: 'RWF', unitCode: 'RWF_PER_SQM', observedOn: source.observedOn,
    sourcePeriodLabel: requiredString(row.sourcePeriodLabel || source.sourcePeriodLabel, `${label}.sourcePeriodLabel`, 600),
    methodologyNote: requiredString(row.methodologyNote || source.methodologyNote, `${label}.methodologyNote`, 2000),
    payload: row
  };
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.');
  process.exit(1);
}

let client;
let runId = null;
let inTransaction = false;
try {
  const raw = await fs.readFile(input);
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const document = JSON.parse(raw.toString('utf8'));
  if (document.schemaVersion !== 1) fail('schemaVersion must be 1.');
  const snapshotDate = validDate(document.snapshotDate, 'snapshotDate');
  if (!Array.isArray(document.sources) || document.sources.length < 1 || document.sources.length > 10) fail('sources must contain between 1 and 10 sources.');
  if (!Array.isArray(document.benchmarks) || document.benchmarks.length < 1 || document.benchmarks.length > 5000) fail('benchmarks must contain between 1 and 5000 rows.');
  const normalizedSources = document.sources.map(validateSource);
  if (normalizedSources.some(s => s.observedOn !== snapshotDate)) fail('Each source observedOn must match the document snapshotDate.');
  const sourcesByKey = new Map(normalizedSources.map(s => [s.sourceKey, s]));
  if (sourcesByKey.size !== normalizedSources.length) fail('Source keys must be unique.');
  const normalizedRows = document.benchmarks.map((row, index) => validateBenchmark(row, index, sourcesByKey));
  const keys = new Set();
  for (const row of normalizedRows) {
    const key = `${row.sourceKey}|${row.sourceRecordKey}`;
    if (keys.has(key)) fail(`Duplicate source record key: ${key}`);
    keys.add(key);
  }

  client = new Client({ connectionString, application_name: 'reja-land-benchmark-import', connectionTimeoutMillis: 5000 });
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  inTransaction = true;
  await client.query("SELECT pg_advisory_xact_lock(hashtext('reja:market-reference-benchmark-import'))");
  const run = await client.query(
    `INSERT INTO reja.ingestion_runs(source_name, source_sha256, status, counts)
     VALUES ($1,$2,'started',$3::jsonb) RETURNING id`,
    ['rwanda-land-dashboard-benchmarks.json', hash, JSON.stringify({ inputRows: normalizedRows.length, sources: normalizedSources.length, snapshotDate })]
  );
  runId = run.rows[0].id;

  const sourceIds = new Map();
  for (const source of normalizedSources) {
    const result = await client.query(
      `INSERT INTO reja.sources(source_key,source_url,title,publisher,purpose,source_type,is_current,payload,first_seen_at,last_seen_at)
       VALUES ($1,$2,$3,$4,$5,'government',true,$6::jsonb,now(),now())
       ON CONFLICT (source_key) DO UPDATE SET
         source_url=EXCLUDED.source_url,title=EXCLUDED.title,publisher=EXCLUDED.publisher,purpose=EXCLUDED.purpose,
         source_type='government',is_current=true,payload=EXCLUDED.payload,last_seen_at=now()
       RETURNING id`,
      [source.sourceKey, source.sourceUrl, source.title, source.publisher, source.purpose,
       JSON.stringify({ benchmarkSnapshotDate: source.observedOn, sourcePeriodLabel: source.sourcePeriodLabel, methodologyNote: source.methodologyNote })]
    );
    sourceIds.set(source.sourceKey, result.rows[0].id);
    await client.query(
      `UPDATE reja.market_reference_benchmarks SET is_current=false, updated_at=now()
        WHERE source_id=$1 AND is_current=true`,
      [result.rows[0].id]
    );
  }

  for (const row of normalizedRows) {
    const sourceId = sourceIds.get(row.sourceKey);
    await client.query(
      `INSERT INTO reja.market_reference_benchmarks
         (source_id,source_record_key,benchmark_kind,geography_level,district_label,land_use_label,metric_code,
          amount,currency,unit_code,observed_on,source_period_label,methodology_note,is_current,payload,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13,true,$14::jsonb,now())
       ON CONFLICT (source_id,source_record_key,observed_on) DO UPDATE SET
          benchmark_kind=EXCLUDED.benchmark_kind,geography_level=EXCLUDED.geography_level,
          district_label=EXCLUDED.district_label,land_use_label=EXCLUDED.land_use_label,metric_code=EXCLUDED.metric_code,
          amount=EXCLUDED.amount,currency=EXCLUDED.currency,unit_code=EXCLUDED.unit_code,
          source_period_label=EXCLUDED.source_period_label,methodology_note=EXCLUDED.methodology_note,
          is_current=true,payload=EXCLUDED.payload,updated_at=now()`,
      [sourceId,row.sourceRecordKey,row.benchmarkKind,row.geographyLevel,row.district,row.landUse,row.metricCode,
       row.amount,row.currency,row.unitCode,row.observedOn,row.sourcePeriodLabel,row.methodologyNote,JSON.stringify(row.payload)]
    );
  }

  await client.query(
    `UPDATE reja.ingestion_runs SET status='completed',finished_at=now(),
       counts=counts || $2::jsonb WHERE id=$1`,
    [runId, JSON.stringify({
      insertedOrUpdated: normalizedRows.length,
      districtAverages: normalizedRows.filter(r => r.benchmarkKind === 'district_average_land_price').length,
      landUseAverages: normalizedRows.filter(r => r.benchmarkKind === 'land_use_transaction_average').length,
      sourceCount: normalizedSources.length,
      snapshotDate
    })]
  );
  await client.query('COMMIT');
  inTransaction = false;
  console.log(`Imported ${normalizedRows.length} published benchmark rows from ${normalizedSources.length} official dashboard source(s). Snapshot: ${snapshotDate}. These are aggregate indicators, not individual transactions.`);
} catch (error) {
  if (client && inTransaction) await client.query('ROLLBACK').catch(() => {});
  console.error(`Rwanda benchmark import failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => {});
}
