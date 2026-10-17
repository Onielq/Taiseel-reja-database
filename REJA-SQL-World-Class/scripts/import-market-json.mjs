import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { isSafeHttpsOrHttpUrl } from '../src/db.mjs';

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const allowVerified = args.includes('--allow-verified');
const inputArg = args.find((value) => !value.startsWith('--'));

const PROPERTY_TYPES = ['apartment','house','land','commercial','industrial','mixed_use','other','unknown'];
const SOURCE_TYPES = ['government','developer','publisher','listing','social','registry','user_supplied','unclassified'];
const TRANSACTION_TYPES = ['sale','rent'];
const RENT_PERIODS = ['not_applicable','daily','weekly','monthly','yearly'];
const TRANSACTION_CHANNELS = ['primary','resale','off_plan','unknown'];
const PAYMENT_METHODS = ['cash','mortgage','installment','unknown'];
const VERIFICATION_STATUSES = ['verified','partially_verified','unverified','disputed','rejected'];
const EVIDENCE_STATUSES = ['supports','contradicts','unreviewed','resolved'];
const LISTING_STATUSES = ['active','withdrawn','expired','sold_or_leased','unknown'];

function fail(message) {
  throw new Error(message);
}

function requiredString(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    fail(`${label} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}

function optionalString(value, label, max = 500) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) {
    fail(`${label} must be a string of at most ${max} characters.`);
  }
  return value.trim() || null;
}

function enumValue(value, choices, label, fallback) {
  const result = value === undefined || value === null || value === '' ? fallback : value;
  if (!choices.includes(result)) fail(`${label} must be one of: ${choices.join(', ')}.`);
  return result;
}

function decimal(value, label, { optional = false, positive = false, maxDigits = 2 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    fail(`${label} is required.`);
  }
  const stringValue = String(value).trim();
  const match = /^-?(?:\d+)(?:\.(\d+))?$/.exec(stringValue);
  if (!match || (match[1]?.length ?? 0) > maxDigits) {
    fail(`${label} must be a valid decimal with at most ${maxDigits} decimal places.`);
  }
  const numberValue = Number(stringValue);
  if (!Number.isFinite(numberValue) || (positive && numberValue <= 0)) fail(`${label} must be a finite number${positive ? ' greater than zero' : ''}.`);
  return stringValue;
}

function integer(value, label, { optional = true, min = 0, max = 30 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    fail(`${label} is required.`);
  }
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < min || numberValue > max) {
    fail(`${label} must be an integer from ${min} to ${max}.`);
  }
  return numberValue;
}

function dateOnly(value, label) {
  const result = requiredString(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) fail(`${label} must use YYYY-MM-DD format.`);
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    fail(`${label} must be a real calendar date.`);
  }
  return result;
}

function timestamp(value, label) {
  const result = requiredString(value, label, 80);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || !/(Z|[+-]\d{2}:?\d{2})$/i.test(result)) {
    fail(`${label} must be an ISO 8601 timestamp with an explicit timezone.`);
  }
  return parsed.toISOString();
}

function objectValue(value, label) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be a JSON object.`);
  return value;
}

function safeSourceUrl(value, label) {
  const result = optionalString(value, label, 4096);
  if (result && !isSafeHttpsOrHttpUrl(result)) fail(`${label} must be a valid HTTP(S) URL.`);
  return result;
}

function normalizeProperty(value, index) {
  const label = `properties[${index}]`;
  const row = objectValue(value, label);
  let latitude = null;
  let longitude = null;
  if (row.latitude !== undefined && row.latitude !== null && row.latitude !== '') {
    latitude = decimal(row.latitude, `${label}.latitude`, { maxDigits: 6 });
    if (Number(latitude) < -90 || Number(latitude) > 90) fail(`${label}.latitude must be between -90 and 90.`);
  }
  if (row.longitude !== undefined && row.longitude !== null && row.longitude !== '') {
    longitude = decimal(row.longitude, `${label}.longitude`, { maxDigits: 6 });
    if (Number(longitude) < -180 || Number(longitude) > 180) fail(`${label}.longitude must be between -180 and 180.`);
  }
  if ((latitude === null) !== (longitude === null)) fail(`${label} must provide both latitude and longitude or neither.`);
  return {
    externalId: requiredString(row.externalId, `${label}.externalId`, 100),
    projectExternalId: optionalString(row.projectExternalId, `${label}.projectExternalId`, 80),
    propertyType: enumValue(row.propertyType, PROPERTY_TYPES, `${label}.propertyType`, 'unknown'),
    district: requiredString(row.district, `${label}.district`, 100),
    sector: optionalString(row.sector, `${label}.sector`, 100),
    cell: optionalString(row.cell, `${label}.cell`, 100),
    address: optionalString(row.address, `${label}.address`, 300),
    projectName: optionalString(row.projectName, `${label}.projectName`, 200),
    buildingName: optionalString(row.buildingName, `${label}.buildingName`, 200),
    unitLabel: optionalString(row.unitLabel, `${label}.unitLabel`, 100),
    unitSeries: optionalString(row.unitSeries, `${label}.unitSeries`, 100),
    bedrooms: integer(row.bedrooms, `${label}.bedrooms`, { max: 30 }),
    bathrooms: decimal(row.bathrooms, `${label}.bathrooms`, { optional: true, maxDigits: 1 }),
    floorLabel: optionalString(row.floorLabel, `${label}.floorLabel`, 80),
    internalAreaSqm: decimal(row.internalAreaSqm, `${label}.internalAreaSqm`, { optional: true, positive: true }),
    plotAreaSqm: decimal(row.plotAreaSqm, `${label}.plotAreaSqm`, { optional: true, positive: true }),
    latitude,
    longitude,
    payload: objectValue(row.payload, `${label}.payload`)
  };
}

function normalizeTransaction(value, index, sourceKey) {
  const label = `transactions[${index}]`;
  const row = objectValue(value, label);
  const type = enumValue(row.transactionType, TRANSACTION_TYPES, `${label}.transactionType`);
  const rentPeriod = enumValue(row.rentPeriod, RENT_PERIODS, `${label}.rentPeriod`, type === 'sale' ? 'not_applicable' : null);
  if (type === 'rent' && rentPeriod === 'not_applicable') fail(`${label}.rentPeriod is required for rentals and cannot be not_applicable.`);
  if (type === 'sale' && rentPeriod !== 'not_applicable') fail(`${label}.rentPeriod must be not_applicable for sales.`);
  const status = enumValue(row.verificationStatus, VERIFICATION_STATUSES, `${label}.verificationStatus`, 'unverified');
  let verifiedAt = null;
  if (status === 'verified') {
    if (!allowVerified) fail(`${label} is marked verified. Re-run with --allow-verified only after a human review of the source evidence.`);
    verifiedAt = timestamp(row.verifiedAt, `${label}.verifiedAt`);
  }
  const currency = requiredString(row.currency, `${label}.currency`, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail(`${label}.currency must be a three-letter currency code such as RWF or USD.`);
  return {
    sourceRecordKey: requiredString(row.sourceRecordKey, `${label}.sourceRecordKey`, 200),
    propertyExternalId: optionalString(row.propertyExternalId, `${label}.propertyExternalId`, 100),
    projectExternalId: optionalString(row.projectExternalId, `${label}.projectExternalId`, 80),
    transactionType: type,
    transactionDate: dateOnly(row.transactionDate, `${label}.transactionDate`),
    amount: decimal(row.amount, `${label}.amount`, { positive: true }),
    currency,
    rentPeriod,
    propertyType: enumValue(row.propertyType, PROPERTY_TYPES, `${label}.propertyType`, 'unknown'),
    district: requiredString(row.district, `${label}.district`, 100),
    sector: optionalString(row.sector, `${label}.sector`, 100),
    cell: optionalString(row.cell, `${label}.cell`, 100),
    propertyAreaSqm: decimal(row.propertyAreaSqm, `${label}.propertyAreaSqm`, { optional: true, positive: true }),
    bedrooms: integer(row.bedrooms, `${label}.bedrooms`, { max: 30 }),
    transactionChannel: enumValue(row.transactionChannel, TRANSACTION_CHANNELS, `${label}.transactionChannel`, 'unknown'),
    paymentMethod: enumValue(row.paymentMethod, PAYMENT_METHODS, `${label}.paymentMethod`, 'unknown'),
    verificationStatus: status,
    verifiedAt,
    evidenceStatus: row.evidenceStatus === undefined ? null : enumValue(row.evidenceStatus, EVIDENCE_STATUSES, `${label}.evidenceStatus`),
    buildingName: optionalString(row.buildingName, `${label}.buildingName`, 200),
    unitLabel: optionalString(row.unitLabel, `${label}.unitLabel`, 100),
    payload: objectValue(row.payload, `${label}.payload`)
  };
}

function normalizeListing(value, index) {
  const label = `listings[${index}]`;
  const row = objectValue(value, label);
  const type = enumValue(row.listingType, TRANSACTION_TYPES, `${label}.listingType`);
  const rentPeriod = enumValue(row.rentPeriod, RENT_PERIODS, `${label}.rentPeriod`, type === 'sale' ? 'not_applicable' : null);
  if (type === 'rent' && rentPeriod === 'not_applicable') fail(`${label}.rentPeriod is required for rentals.`);
  if (type === 'sale' && rentPeriod !== 'not_applicable') fail(`${label}.rentPeriod must be not_applicable for sale listings.`);
  const currency = requiredString(row.currency, `${label}.currency`, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail(`${label}.currency must be a three-letter currency code.`);
  return {
    sourceRecordKey: requiredString(row.sourceRecordKey, `${label}.sourceRecordKey`, 200),
    propertyExternalId: optionalString(row.propertyExternalId, `${label}.propertyExternalId`, 100),
    projectExternalId: optionalString(row.projectExternalId, `${label}.projectExternalId`, 80),
    listingType: type,
    askingAmount: decimal(row.askingAmount, `${label}.askingAmount`, { positive: true }),
    currency,
    rentPeriod,
    propertyType: enumValue(row.propertyType, PROPERTY_TYPES, `${label}.propertyType`, 'unknown'),
    district: requiredString(row.district, `${label}.district`, 100),
    sector: optionalString(row.sector, `${label}.sector`, 100),
    propertyAreaSqm: decimal(row.propertyAreaSqm, `${label}.propertyAreaSqm`, { optional: true, positive: true }),
    listingUrl: safeSourceUrl(row.listingUrl, `${label}.listingUrl`),
    listingStatus: enumValue(row.listingStatus, LISTING_STATUSES, `${label}.listingStatus`, 'active'),
    payload: objectValue(row.payload, `${label}.payload`)
  };
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) fail('The JSON root must be an object.');
  const source = objectValue(snapshot.source, 'source');
  const normalizedSource = {
    sourceKey: requiredString(source.sourceKey, 'source.sourceKey', 160),
    sourceUrl: safeSourceUrl(source.sourceUrl, 'source.sourceUrl'),
    title: optionalString(source.title, 'source.title', 500),
    publisher: optionalString(source.publisher, 'source.publisher', 300),
    purpose: optionalString(source.purpose, 'source.purpose', 1000),
    sourceType: enumValue(source.sourceType, SOURCE_TYPES, 'source.sourceType', 'unclassified'),
    payload: objectValue(source.payload, 'source.payload')
  };
  const normalizeArray = (key, fn) => {
    const rows = snapshot[key] ?? [];
    if (!Array.isArray(rows)) fail(`${key} must be an array.`);
    if (rows.length > 50000) fail(`${key} cannot exceed 50,000 rows per snapshot.`);
    return rows.map(fn);
  };
  const properties = normalizeArray('properties', normalizeProperty);
  const transactions = normalizeArray('transactions', (row, index) => normalizeTransaction(row, index, normalizedSource.sourceKey));
  const listings = normalizeArray('listings', normalizeListing);
  for (const [key, values] of [
    ['properties.externalId', properties.map((row) => row.externalId)],
    ['transactions.sourceRecordKey', transactions.map((row) => row.sourceRecordKey)],
    ['listings.sourceRecordKey', listings.map((row) => row.sourceRecordKey)]
  ]) {
    if (new Set(values).size !== values.length) fail(`${key} values must be unique within one input snapshot.`);
  }
  return { source: normalizedSource, properties, transactions, listings };
}

function hashCanonical(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function transactionHash(row, sourceKey) {
  // Only merge across sources when a stable property/unit identity exists.
  const stableIdentity = row.propertyExternalId ||
    (row.buildingName && row.unitLabel ? `${row.buildingName.trim().toLowerCase()}|${row.unitLabel.trim().toLowerCase()}` : null);
  const identity = stableIdentity ? `property:${stableIdentity.toLowerCase()}` : `source:${sourceKey}|${row.sourceRecordKey}`;
  return hashCanonical({
    identity,
    transactionType: row.transactionType,
    transactionDate: row.transactionDate,
    amount: row.amount,
    currency: row.currency,
    rentPeriod: row.rentPeriod,
    propertyType: row.propertyType,
    district: row.district.trim().toLowerCase(),
    sector: (row.sector || '').trim().toLowerCase(),
    propertyAreaSqm: row.propertyAreaSqm,
    bedrooms: row.bedrooms,
    transactionChannel: row.transactionChannel
  });
}

async function findPropertyId(client, externalId) {
  if (!externalId) return null;
  const result = await client.query(
    'SELECT id FROM reja.market_properties WHERE external_id=$1 AND is_current=true',
    [externalId]
  );
  if (!result.rowCount) fail(`Property ${externalId} was referenced but is not present in this import or the current database.`);
  return result.rows[0].id;
}

async function findProjectAssetId(client, externalId) {
  if (!externalId) return null;
  const result = await client.query(
    "SELECT id FROM reja.assets WHERE external_id=$1 AND asset_type='project' AND is_current=true",
    [externalId]
  );
  if (!result.rowCount) fail(`Project ${externalId} was referenced but is not a current REJA project.`);
  return result.rows[0].id;
}

async function upsertProperty(client, row) {
  const assetId = await findProjectAssetId(client, row.projectExternalId);
  const result = await client.query(`
    INSERT INTO reja.market_properties (
      external_id,asset_id,property_type,district_label,sector_label,cell_label,address_label,
      project_name,building_name,unit_label,unit_series,bedrooms,bathrooms,floor_label,
      internal_area_sqm,plot_area_sqm,latitude,longitude,is_current,payload,updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,true,$19::jsonb,now()
    )
    ON CONFLICT (external_id) DO UPDATE SET
      asset_id=coalesce(EXCLUDED.asset_id,reja.market_properties.asset_id),
      property_type=EXCLUDED.property_type,district_label=EXCLUDED.district_label,
      sector_label=EXCLUDED.sector_label,cell_label=EXCLUDED.cell_label,address_label=EXCLUDED.address_label,
      project_name=EXCLUDED.project_name,building_name=EXCLUDED.building_name,unit_label=EXCLUDED.unit_label,
      unit_series=EXCLUDED.unit_series,bedrooms=EXCLUDED.bedrooms,bathrooms=EXCLUDED.bathrooms,
      floor_label=EXCLUDED.floor_label,internal_area_sqm=EXCLUDED.internal_area_sqm,plot_area_sqm=EXCLUDED.plot_area_sqm,
      latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,is_current=true,payload=EXCLUDED.payload,updated_at=now()
    RETURNING id`, [
    row.externalId, assetId, row.propertyType, row.district, row.sector, row.cell, row.address,
    row.projectName, row.buildingName, row.unitLabel, row.unitSeries, row.bedrooms, row.bathrooms,
    row.floorLabel, row.internalAreaSqm, row.plotAreaSqm, row.latitude, row.longitude, JSON.stringify(row.payload)
  ]);
  return result.rows[0].id;
}

async function linkAdditionalEvidence(client, { transactionId, sourceId, sourceRecordKey, evidenceStatus, payload }) {
  const existing = await client.query(`
    SELECT id,transaction_id FROM reja.market_transaction_evidence
     WHERE source_id=$1 AND source_record_key=$2 AND is_current=true
     LIMIT 1`, [sourceId, sourceRecordKey]);
  if (existing.rowCount && Number(existing.rows[0].transaction_id) === Number(transactionId)) {
    await client.query(
      'UPDATE reja.market_transaction_evidence SET last_seen_at=now(),payload=$2::jsonb,evidence_status=$3 WHERE id=$1',
      [existing.rows[0].id, JSON.stringify(payload), evidenceStatus]
    );
    return;
  }
  if (existing.rowCount) {
    await client.query('UPDATE reja.market_transaction_evidence SET is_current=false,last_seen_at=now() WHERE id=$1', [existing.rows[0].id]);
  }
  await client.query(`
    INSERT INTO reja.market_transaction_evidence
      (transaction_id,source_id,source_record_key,evidence_role,evidence_status,source_url,payload)
    VALUES ($1,$2,$3,'corroborating',$4,NULL,$5::jsonb)`, [
    transactionId, sourceId, sourceRecordKey, evidenceStatus, JSON.stringify(payload)
  ]);
}

async function importSnapshot(client, snapshot, fileHash, fileName) {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('reja:market-import'))");
    const ready = await client.query("SELECT to_regclass('reja.market_transactions') AS transactions_table, to_regclass('reja.market_listings') AS listings_table");
    if (!ready.rows[0].transactions_table || !ready.rows[0].listings_table) {
      fail('Market tables do not exist. Run npm run migrate before importing market records.');
    }
    const run = await client.query(`
      INSERT INTO reja.ingestion_runs (source_name,source_sha256,status,counts,started_at)
      VALUES ($1,$2,'started','{}'::jsonb,now()) RETURNING id`, [fileName, fileHash]);
    const runId = run.rows[0].id;
    const source = snapshot.source;
    const sourceResult = await client.query(`
      INSERT INTO reja.sources (source_key,source_url,display_order,title,publisher,purpose,source_type,is_current,payload,first_seen_at,last_seen_at)
      VALUES ($1,$2,0,$3,$4,$5,$6,true,$7::jsonb,now(),now())
      ON CONFLICT (source_key) DO UPDATE SET
        source_url=coalesce(EXCLUDED.source_url,reja.sources.source_url),
        title=coalesce(EXCLUDED.title,reja.sources.title),
        publisher=coalesce(EXCLUDED.publisher,reja.sources.publisher),
        purpose=coalesce(EXCLUDED.purpose,reja.sources.purpose),
        source_type=CASE WHEN EXCLUDED.source_type='unclassified' THEN reja.sources.source_type ELSE EXCLUDED.source_type END,is_current=true,
        payload=reja.sources.payload || EXCLUDED.payload,last_seen_at=now()
      RETURNING id`, [source.sourceKey, source.sourceUrl, source.title, source.publisher, source.purpose, source.sourceType, JSON.stringify(source.payload)]);
    const sourceId = sourceResult.rows[0].id;

    for (const property of snapshot.properties) await upsertProperty(client, property);

    let importedTransactions = 0;
    let linkedEvidence = 0;
    for (const row of snapshot.transactions) {
      const propertyId = await findPropertyId(client, row.propertyExternalId);
      const assetId = await findProjectAssetId(client, row.projectExternalId);
      const hash = transactionHash(row, source.sourceKey);

      // A corrected source row retires the old current version without deleting its history.
      await client.query(`
        UPDATE reja.market_transactions SET is_current=false
         WHERE source_id=$1 AND source_record_key=$2 AND is_current=true AND record_hash<>$3`,
      [sourceId, row.sourceRecordKey, hash]);

      const existing = await client.query(
        'SELECT id,source_id,source_record_key FROM reja.market_transactions WHERE record_hash=$1 LIMIT 1',
        [hash]
      );
      let transactionId;
      if (existing.rowCount) {
        transactionId = existing.rows[0].id;
        await client.query(`
          UPDATE reja.market_transactions
             SET is_current=true,
                 verification_status=CASE WHEN $2='verified' THEN 'verified' ELSE verification_status END,
                 verified_at=CASE WHEN $2='verified' THEN $3::timestamptz ELSE verified_at END
           WHERE id=$1`, [transactionId, row.verificationStatus, row.verifiedAt]);
        const isPrimary = Number(existing.rows[0].source_id) === Number(sourceId)
          && existing.rows[0].source_record_key === row.sourceRecordKey;
        if (!isPrimary) {
          await linkAdditionalEvidence(client, {
            transactionId, sourceId, sourceRecordKey: row.sourceRecordKey,
            evidenceStatus: row.evidenceStatus || (row.verificationStatus === 'verified' ? 'supports' : 'unreviewed'),
            payload: row.payload
          });
          linkedEvidence += 1;
        }
      } else {
        const inserted = await client.query(`
          INSERT INTO reja.market_transactions (
            source_id,ingestion_run_id,source_record_key,record_hash,property_id,asset_id,
            transaction_type,transaction_date,amount,currency,rent_period,property_type,
            district_label,sector_label,cell_label,property_area_sqm,bedrooms,transaction_channel,
            payment_method,verification_status,verified_at,is_current,payload
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,true,$22::jsonb
          ) RETURNING id`, [
          sourceId, runId, row.sourceRecordKey, hash, propertyId, assetId,
          row.transactionType, row.transactionDate, row.amount, row.currency, row.rentPeriod,
          row.propertyType, row.district, row.sector, row.cell, row.propertyAreaSqm, row.bedrooms,
          row.transactionChannel, row.paymentMethod, row.verificationStatus, row.verifiedAt,
          JSON.stringify(row.payload)
        ]);
        transactionId = inserted.rows[0].id;
        importedTransactions += 1;
      }
    }

    let importedListings = 0;
    let listingObservations = 0;
    for (const row of snapshot.listings) {
      const propertyId = await findPropertyId(client, row.propertyExternalId);
      const assetId = await findProjectAssetId(client, row.projectExternalId);
      const result = await client.query(`
        INSERT INTO reja.market_listings (
          source_id,source_record_key,property_id,asset_id,listing_type,asking_amount,currency,
          rent_period,property_type,district_label,sector_label,property_area_sqm,listing_url,
          listing_status,first_seen_at,last_seen_at,is_current,payload
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now(),true,$15::jsonb)
        ON CONFLICT (source_id,source_record_key) WHERE is_current=true DO UPDATE SET
          property_id=coalesce(EXCLUDED.property_id,reja.market_listings.property_id),
          asset_id=coalesce(EXCLUDED.asset_id,reja.market_listings.asset_id),
          listing_type=EXCLUDED.listing_type,asking_amount=EXCLUDED.asking_amount,currency=EXCLUDED.currency,
          rent_period=EXCLUDED.rent_period,property_type=EXCLUDED.property_type,
          district_label=EXCLUDED.district_label,sector_label=EXCLUDED.sector_label,
          property_area_sqm=EXCLUDED.property_area_sqm,listing_url=EXCLUDED.listing_url,
          listing_status=EXCLUDED.listing_status,last_seen_at=now(),payload=EXCLUDED.payload
        RETURNING id,asking_amount,currency,rent_period,property_area_sqm,listing_status`, [
        sourceId, row.sourceRecordKey, propertyId, assetId, row.listingType, row.askingAmount,
        row.currency, row.rentPeriod, row.propertyType, row.district, row.sector, row.propertyAreaSqm,
        row.listingUrl, row.listingStatus, JSON.stringify(row.payload)
      ]);
      importedListings += 1;
      await client.query(`
        INSERT INTO reja.market_listing_observations
          (listing_id,observed_at,asking_amount,currency,rent_period,property_area_sqm,listing_status,payload)
        VALUES ($1,now(),$2,$3,$4,$5,$6,$7::jsonb)`, [
        result.rows[0].id, result.rows[0].asking_amount, result.rows[0].currency,
        result.rows[0].rent_period, result.rows[0].property_area_sqm, result.rows[0].listing_status,
        JSON.stringify(row.payload)
      ]);
      listingObservations += 1;
    }

    const counts = {
      properties_upserted: snapshot.properties.length,
      transactions_seen: snapshot.transactions.length,
      transactions_inserted: importedTransactions,
      additional_source_links_seen: linkedEvidence,
      listings_seen: snapshot.listings.length,
      listing_observations_written: listingObservations
    };
    await client.query(`
      UPDATE reja.ingestion_runs SET status='completed',counts=$2::jsonb,finished_at=now()
       WHERE id=$1`, [runId, JSON.stringify(counts)]);
    await client.query('COMMIT');
    return { runId, counts };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    try {
      await client.query(`
        INSERT INTO reja.ingestion_runs (source_name,source_sha256,status,counts,started_at,finished_at,error_message)
        VALUES ($1,$2,'failed','{}'::jsonb,now(),now(),$3)`, [fileName, fileHash, String(error.message || error).slice(0, 4000)]);
    } catch { /* the schema may be absent; retain the original error */ }
    throw error;
  }
}

async function main() {
  if (!inputArg) {
    console.error('Usage: npm run market:import -- /absolute/path/to/market-snapshot.json [--allow-verified]');
    process.exitCode = 2;
    return;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) fail('DATABASE_URL is required. Copy .env.example to .env and configure a migration-capable database role.');
  const inputPath = path.resolve(inputArg);
  const bytes = await fs.readFile(inputPath);
  const fileHash = crypto.createHash('sha256').update(bytes).digest('hex');
  let raw;
  try { raw = JSON.parse(bytes.toString('utf8')); }
  catch { fail('Input file is not valid UTF-8 JSON.'); }
  const snapshot = normalizeSnapshot(raw);
  const client = new Client({ connectionString, application_name: 'reja-market-import', connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const result = await importSnapshot(client, snapshot, fileHash, path.basename(inputPath));
    console.log(JSON.stringify({ status: 'completed', ...result }, null, 2));
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`Market import failed: ${error.message}`);
  process.exitCode = 1;
});
