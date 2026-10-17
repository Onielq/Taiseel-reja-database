import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFile(path.join(root, relativePath), 'utf8');

test('official benchmarks have their own database table and cannot be confused with individual deals', async () => {
  const sql = await read('database/003_official_land_benchmarks.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS reja\.market_reference_benchmarks/);
  assert.match(sql, /REFERENCES reja\.sources\(id\)/);
  assert.match(sql, /district_average_land_price/);
  assert.match(sql, /land_use_transaction_average/);
  assert.match(sql, /observed_on IS/);
  assert.match(sql, /Never treat these rows as individual property transactions/);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+reja\.market_transactions/i);
});

test('captured National Land Authority benchmark snapshot includes 30 districts and 14 land-use categories', async () => {
  const doc = JSON.parse(await read('data/rwanda-land-dashboard-benchmarks.json'));
  const district = doc.benchmarks.filter(row => row.benchmarkKind === 'district_average_land_price');
  const landUse = doc.benchmarks.filter(row => row.benchmarkKind === 'land_use_transaction_average');
  assert.equal(doc.snapshotDate, '2026-10-17');
  assert.equal(district.length, 30);
  assert.equal(landUse.length, 14);
  assert.equal(doc.sources.length, 2);
  assert.equal(new Set(doc.benchmarks.map(row => row.sourceKey + '|' + row.sourceRecordKey)).size, doc.benchmarks.length);
  assert.equal(district.find(row => row.district === 'Kicukiro')?.amount, 61491);
  assert.equal(district.find(row => row.district === 'Nyarugenge')?.amount, 50735);
  assert.equal(landUse.find(row => row.landUse === 'Residential')?.amount, 10847);
  assert.ok(doc.benchmarks.every(row => row.currency === 'RWF' && row.unitCode === 'RWF_PER_SQM'));
  assert.ok(doc.sources.every(source => source.sourceType === 'government' && source.sourceUrl.startsWith('https://rwandalanddashboard.lands.rw/')));
  assert.match(doc.notes, /NOT the date of the underlying deals/);
});

test('benchmark importer validates source domain and data types before import', async () => {
  const importer = await read('scripts/import-market-benchmarks.mjs');
  assert.match(importer, /market-reference-benchmark-import/);
  assert.match(importer, /BEGIN ISOLATION LEVEL SERIALIZABLE/);
  assert.match(importer, /rwandalanddashboard\.lands\.rw/);
  assert.match(importer, /snapshotDate/);
  assert.match(importer, /sourceRecordKey/);
  assert.match(importer, /market_reference_benchmarks/);
  assert.doesNotMatch(importer, /INSERT INTO reja\.market_transactions/i);
  assert.match(importer, /these are aggregate indicators, not individual transactions/i);
});

test('benchmark read API returns explicit methodological limitations', async () => {
  const server = await read('src/server.mjs');
  assert.match(server, /pathname === '\/api\/v1\/market\/benchmarks'/);
  assert.match(server, /FROM reja\.market_reference_benchmarks b/);
  assert.match(server, /periodDisclosedBySource: false/);
  assert.match(server, /individualTransactions: false/);
  assert.match(server, /formalValuation: false/);
  assert.match(server, /snapshotDateMeaning/);
});

test('market page displays district and land-use benchmarks with a clear caveat', async () => {
  const html = await read('public/market.html');
  assert.match(html, /District land-price indicators/);
  assert.match(html, /Average price by existing land use/);
  assert.match(html, /districtBenchmarkRows/);
  assert.match(html, /landUseBenchmarkRows/);
  assert.match(html, /these are published aggregate land indicators—not individual transactions/);
  assert.match(html, /api\/v1\/market\/benchmarks\?kind=district_average_land_price/);
  assert.match(html, /api\/v1\/market\/benchmarks\?kind=land_use_transaction_average/);
});

test('migration command imports the source-documented snapshot while transaction tables remain independent', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.match(pkg.scripts.migrate, /scripts\/migrate\.mjs.*scripts\/import-market-benchmarks\.mjs/);
  assert.match(pkg.scripts['market:benchmarks:import'], /scripts\/import-market-benchmarks\.mjs/);
  const workflow = await read('../.github/workflows/reja-validation.yml');
  assert.match(workflow, /api\/v1\/market\/benchmarks/);
  assert.match(workflow, /feature\/official-rwanda-land-benchmarks/);
});
