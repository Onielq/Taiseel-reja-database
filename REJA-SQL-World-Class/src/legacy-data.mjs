import crypto from 'node:crypto';

const DATA_SCRIPT = /<script\b(?=[^>]*\bid=["']reja-data["'])(?=[^>]*\btype=["']application\/json["'])[^>]*>([\s\S]*?)<\/script\s*>/i;
const HASH_RE = /^[a-f0-9]{64}$/;

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function extractEmbeddedData(html, { allowEmpty = false } = {}) {
  if (typeof html !== 'string') throw new TypeError('HTML input must be a string.');
  const match = DATA_SCRIPT.exec(html);
  if (!match) throw new Error('Could not find the reja-data JSON script in the HTML file.');
  let data;
  try { data = JSON.parse(match[1]); }
  catch (error) { throw new Error(`Embedded REJA JSON is invalid: ${error.message}`); }
  validateLegacyData(data, { allowEmpty });
  return data;
}

export function validateLegacyData(data, { allowEmpty = false } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('Dataset must be a JSON object.');
  for (const key of ['projects', 'segments', 'developers', 'sources']) {
    if (!Array.isArray(data[key])) throw new TypeError(`Dataset property "${key}" must be an array.`);
  }
  if (!data.ownerGroups || typeof data.ownerGroups !== 'object' || Array.isArray(data.ownerGroups)) {
    throw new TypeError('Dataset property "ownerGroups" must be an object.');
  }
  const assetIds = new Set();
  for (const [assetType, rows] of [['project', data.projects], ['segment', data.segments]]) {
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id.trim() || typeof row.name !== 'string' || !row.name.trim()) {
        throw new TypeError(`${assetType} rows require non-empty id and name fields.`);
      }
      if (assetIds.has(row.id)) throw new Error(`Duplicate asset id in projects/segments: ${row.id}`);
      assetIds.add(row.id);
      for (const key of ['dataConfidence', 'riskScore']) {
        const value = row[key];
        if (value !== null && value !== undefined && (!Number.isInteger(value) || value < 0 || value > 100)) {
          throw new RangeError(`${row.id}.${key} must be an integer from 0 to 100, or null.`);
        }
      }
      if (row.units !== null && row.units !== undefined && (!Number.isInteger(row.units) || row.units < 0)) {
        throw new RangeError(`${row.id}.units must be a non-negative integer, or null.`);
      }
      if (row.land_ha !== null && row.land_ha !== undefined && (!Number.isFinite(row.land_ha) || row.land_ha <= 0)) {
        throw new RangeError(`${row.id}.land_ha must be greater than zero, or null.`);
      }
    }
  }
  const devIds = new Set();
  for (const dev of data.developers) {
    if (!dev || typeof dev.id !== 'string' || !dev.id.trim() || typeof dev.name !== 'string' || !dev.name.trim()) {
      throw new TypeError('Developer rows require non-empty id and name fields.');
    }
    if (devIds.has(dev.id)) throw new Error(`Duplicate developer id: ${dev.id}`);
    devIds.add(dev.id);
  }
  for (const source of data.sources) {
    if (!source || typeof source.url !== 'string' || (!/^https?:\/\//i.test(source.url) && source.url !== '(local file)')) {
      throw new TypeError('Every source row must contain an http(s) URL or the explicit legacy marker “(local file)”.');
    }
    if (source.url !== '(local file)') {
      let parsed;
      try { parsed = new URL(source.url); } catch { throw new TypeError(`Invalid source URL: ${source.url}`); }
      if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname || source.url.length > 4096) {
        throw new TypeError(`Invalid source URL: ${source.url}`);
      }
    }
  }
  if (!allowEmpty && data.projects.length === 0) throw new Error('No project records found; refusing to import an empty project snapshot.');
  return { projects: data.projects.length, segments: data.segments.length, developers: data.developers.length, sources: data.sources.length };
}

export function yearFromLabel(label) {
  if (typeof label !== 'string') return null;
  const match = label.match(/\b((?:18|19|20|21)\d{2})\b/);
  return match ? Number(match[1]) : null;
}

export function importKey(...parts) {
  return sha256(parts.map((part) => part === null || part === undefined ? '∅' : typeof part === 'string' ? part : JSON.stringify(part)).join('\u001f'));
}

export function normaliseSourceType(source) {
  // The legacy catalogue explicitly labels these two rows as user-uploaded CSVs.
  if (typeof source?.source === 'string' && source.source.startsWith('User-supplied CSV:')) return 'user_supplied';
  // Deliberately do not infer authority from a URL substring or publisher name.
  return 'unclassified';
}

export { HASH_RE };
