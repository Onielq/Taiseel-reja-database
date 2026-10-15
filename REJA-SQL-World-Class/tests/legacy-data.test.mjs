import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractEmbeddedData, validateLegacyData, yearFromLabel, importKey, sha256, normaliseSourceType } from '../src/legacy-data.mjs';
import { safeScriptJson, injectSqlSnapshot, loadBootstrap } from '../src/bootstrap.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const standalonePath = path.join(root, 'public/REJA-standalone.html');
const sqlIndexPath = path.join(root, 'public/index.html');

test('legacy HTML dataset parses with all expected entity groups', async () => {
  const html = await fs.readFile(standalonePath, 'utf8');
  const data = extractEmbeddedData(html);
  assert.equal(data.projects.length, 54);
  assert.equal(data.segments.length, 6);
  assert.equal(data.developers.length, 20);
  assert.equal(data.sources.length, 18);
  assert.equal(data.sources.filter((x) => x.url === '(local file)').length, 2);
  assert.ok(Object.keys(data.ownerGroups).length > 0);
  assert.deepEqual(validateLegacyData(data), {
    projects: 54, segments: 6, developers: 20, sources: 18
  });
});



test('unit counts must be whole numbers because the database stores them as bigint', async () => {
  const html = await fs.readFile(standalonePath, 'utf8');
  const data = extractEmbeddedData(html);
  const invalid = structuredClone(data);
  invalid.projects[0].units = 12.5;
  assert.throws(() => validateLegacyData(invalid), /units must be a non-negative integer/);
});

test('all asset identifiers are unique across projects and market segments', async () => {
  const html = await fs.readFile(standalonePath, 'utf8');
  const data = extractEmbeddedData(html);
  const ids = [...data.projects, ...data.segments].map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('year parsing preserves original labels and only exposes an extracted year', () => {
  assert.equal(yearFromLabel('2025-08'), 2025);
  assert.equal(yearFromLabel('Q4 2027'), 2027);
  assert.equal(yearFromLabel('Unknown'), null);
  assert.equal(yearFromLabel(null), null);
});

test('import keys are deterministic and sensitive to all dimensions', () => {
  assert.equal(importKey('A','owner','Some Co','verified'), importKey('A','owner','Some Co','verified'));
  assert.notEqual(importKey('A','owner','Some Co','verified'), importKey('A','owner','Some Co','unverified'));
  assert.match(sha256('reja'), /^[a-f0-9]{64}$/);
});

test('source authority is not inferred from URL substrings', () => {
  assert.equal(normaliseSourceType({ url: 'https://visionmedia.rw/news/rdb-launches-housing' }), 'unclassified');
  assert.equal(normaliseSourceType({ publisher: 'Government office' }), 'unclassified');
});

test('server-side JSON escaping prevents closing the embedded script element', () => {
  const escaped = safeScriptJson({ title: '</script><script>alert(1)</script>', amp: '&', separator: '\u2028' });
  assert.equal(escaped.includes('</script>'), false);
  assert.equal(escaped.includes('<script>'), false);
  assert.equal(escaped.includes('\\u003c/script\\u003e'), true);
  assert.equal(escaped.includes('\\u0026'), true);
});

test('served HTML template is deliberately empty until the SQL server injects a DB snapshot', async () => {
  const html = await fs.readFile(sqlIndexPath, 'utf8');
  const data = extractEmbeddedData(html, { allowEmpty: true });
  assert.deepEqual([data.projects.length, data.segments.length, data.developers.length, data.sources.length], [0,0,0,0]);
  assert.match(html, /PostgreSQL-backed workstation/);
});


test('SQL snapshot injection safely handles replacement tokens and script-closing text', () => {
  const template = '<html><script id="reja-data" type="application/json">{}<\/script><main>UI</main></html>';
  const payload = { name: '$& $1 $\\', text: '</script><script>attack()</script>' };
  const html = injectSqlSnapshot(template, payload);
  assert.match(html, /<main>UI<\/main>/);
  assert.equal(html.includes('</script><script>attack()'), false);
  const scriptContent = html.match(/<script id="reja-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.deepEqual(JSON.parse(scriptContent), payload);
});

test('SQL bootstrap makes computed developer metrics unknown when no tracked projects exist', async () => {
  const payload = { id:'D1', name:'Developer 1', projectIds:['STALE'], projectCount:0, totalUnits:0, completionRate:0, deliveryScore:60 };
  const pool = { query: async (sql) => {
    if (sql.includes('FROM reja.assets WHERE is_current=true ORDER BY')) return { rows:[{asset_type:'project',payload:{id:'P1',name:'Project 1'}},{asset_type:'segment',payload:{id:'S1',name:'Segment 1'}}] };
    if (sql.includes('FROM reja.developers WHERE is_current=true ORDER BY')) return { rows:[{external_id:'D1',payload}] };
    if (sql.includes('FROM reja.sources WHERE')) return { rows:[{payload:{source:'RHA',publisher:'RHA',url:'https://example.org'}}] };
    if (sql.includes('FROM reja.owner_groups WHERE is_current=true ORDER BY')) return { rows:[{group_name:'Owner A',payload:['P1']}] };
    if (sql.includes('FROM reja.developer_portfolio_metrics')) return { rows:[{developer_id:'D1',tracked_project_count:0,projects_with_known_units:0,known_units_across_tracked_projects:null,reported_completed_count:0,reported_stalled_count:0,reported_active_count:0,reported_pipeline_count:0,observed_completion_rate_pct:null,observed_stalled_rate_pct:null}] };
    if (sql.includes('FROM reja.asset_developers ad')) return { rows:[] };
    throw new Error('Unexpected SQL in bootstrap unit test.');
  }};
  const data = await loadBootstrap(pool);
  assert.equal(data.projects.length,1);
  assert.equal(data.segments.length,1);
  assert.deepEqual(data.ownerGroups, {'Owner A':['P1']});
  assert.deepEqual(data.developers[0].projectIds, [], 'relational membership overrides stale embedded portfolio IDs');
  assert.equal(data.developers[0].projectCount,null);
  assert.equal(data.developers[0].totalUnits,null);
  assert.equal(data.developers[0].completionRate,null);
  assert.equal(data.developers[0].deliveryScore,null);
  assert.equal(data.developers[0].sourceReportedDeliveryScore,60);
});

test('SQL migration encodes core data integrity, provenance and query indexes', async () => {
  const sql = await fs.readFile(path.join(root, 'database/001_initial_schema.sql'), 'utf8');
  for (const phrase of [
    'REFERENCES reja.assets(id)', 'REFERENCES reja.sources(id)', 'REFERENCES reja.developers(external_id)',
    'CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 100)',
    'CREATE INDEX IF NOT EXISTS assets_search_gin_idx',
    'CREATE INDEX IF NOT EXISTS assets_payload_gin_idx',
    'CREATE OR REPLACE VIEW reja.developer_portfolio_metrics',
    'CREATE OR REPLACE VIEW reja.data_quality_summary',
    "(^|[^a-z])(completed|complete|occupied|delivered)([^a-z]|$)", 'is_current', 'import_key', 'last_seen_at'
  ]) assert.ok(sql.includes(phrase), `Expected SQL migration to contain: ${phrase}`);
});


test('current import marks timeline and factors stale instead of deleting history', async () => {
  const importer = await fs.readFile(path.join(root, 'scripts/import-html.mjs'), 'utf8');
  assert.match(importer, /UPDATE reja\.asset_timeline_events SET is_current=false/);
  assert.match(importer, /UPDATE reja\.asset_assessment_factors SET is_current=false/);
  assert.doesNotMatch(importer, /DELETE FROM reja\.asset_timeline_events/);
  assert.doesNotMatch(importer, /DELETE FROM reja\.asset_assessment_factors/);
  assert.doesNotMatch(importer, /DELETE FROM reja\.asset_developers/);
  assert.doesNotMatch(importer, /DELETE FROM reja\.asset_source_links/);
  assert.doesNotMatch(importer, /DELETE FROM reja\.owner_group_assets/);
  const schema = await fs.readFile(path.join(root, 'database/001_initial_schema.sql'), 'utf8');
  assert.match(schema, /asset_developers_one_primary_idx[\s\S]*?is_current = true/);
  assert.match(schema, /owner_group_assets[\s\S]*?is_current\s+boolean NOT NULL DEFAULT true/);
  assert.match(importer, /UPDATE reja\.asset_developers SET is_current=false/);
  assert.match(importer, /UPDATE reja\.asset_source_links SET is_current=false/);
  assert.match(importer, /UPDATE reja\.owner_group_assets SET is_current=false/);
  assert.match(importer, /ON CONFLICT \(import_key\) DO UPDATE SET is_current=true`[\s\S]*?\[assetId, conflictText, key\]/);
  assert.doesNotMatch(importer, /resolution_status='open',resolution_note=NULL,resolved_at=NULL/);
});


test('runtime database configuration supports least-privilege credentials and rejects unsafe pool sizes', async () => {
  const db = await fs.readFile(path.join(root, 'src/db.mjs'), 'utf8');
  assert.match(db, /APP_DATABASE_URL \|\| process\.env\.DATABASE_URL/);
  assert.match(db, /PG_POOL_MAX must be an integer from 1 to 100/);
});


test('SQL-served UI and offline standalone keep the same browser logic', async () => {
  const [serverHtml, standaloneHtml] = await Promise.all([
    fs.readFile(sqlIndexPath, 'utf8'), fs.readFile(standalonePath, 'utf8')
  ]);
  const getAppScript = (html) => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    const match = scripts.find((m) => !/type=["']application\/json["']/i.test(m[1]) && !/\bsrc=/i.test(m[1]));
    assert.ok(match, 'expected an inline app script');
    return match[2];
  };
  assert.equal(getAppScript(serverHtml), getAppScript(standaloneHtml));
});


test('migration runner serializes concurrent migration attempts and protects applied checksums', async () => {
  const migrationRunner = await fs.readFile(path.join(root, 'scripts/migrate.mjs'), 'utf8');
  assert.match(migrationRunner, /pg_advisory_lock\(hashtext\('reja:schema-migrations'\)\)/);
  assert.match(migrationRunner, /pg_advisory_unlock\(hashtext\('reja:schema-migrations'\)\)/);
  assert.match(migrationRunner, /Applied migration .* has changed/);
});
