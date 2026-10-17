# REJA — PostgreSQL-backed intelligence layer

This package upgrades the existing six-page REJA dossier from an embedded-JSON-only page to a local PostgreSQL-backed application. The design keeps the current UI and source records, but makes the relational database the source used to build each served dossier page.

## Architecture

```mermaid
flowchart LR
  A[REJA HTML source snapshot] --> B[Validated idempotent importer]
  B --> C[(PostgreSQL)]
  C --> D[Read-only Node API]
  D --> E[REJA six-page dossier UI]
  C --> F[Evidence / coverage / portfolio views]
  F --> D
```

### Data model

- `reja.assets` stores projects and multi-developer market segments separately, with checked numeric ranges and a retained source payload for lossless compatibility.
- `reja.developers` and `reja.asset_developers` normalize developers and many-to-many project relationships. A primary developer statement is stronger than a developer's portfolio list.
- `reja.sources` and `reja.asset_source_links` canonicalize URLs and make source linkage explicit. URL substrings are **not** treated as proof that a source is authoritative.
- `reja.asset_field_claims` records each field value, status, and source separately. A changed value creates a new claim; older claims are marked `is_current=false`, rather than erased.
- `reja.asset_timeline_events`, `reja.asset_assessment_factors`, and `reja.asset_conflicts` separate evidence timeline, risk/confidence reasons, and unresolved conflicts. Each retains prior imported rows and marks whether a row belongs to the current snapshot.
- `reja.owner_groups` and `reja.owner_group_assets` normalize owner-to-asset groupings.
- `reja.ingestion_runs`, `reja.data_quality_issues`, and `reja.audit_log` provide import/run and data-quality traceability.
- `reja.developer_portfolio_metrics` and `reja.data_quality_summary` are SQL views. They derive numbers from current linked rows instead of trusting copied count fields. Delivery score is not recomputed because the source data does not specify a reproducible methodology.

The `payload` JSONB fields are compatibility envelopes for facts that the old UI already uses (including raw labels like `Q4 2027` and each evidence state). Critical query paths use typed relational columns. Unknown stays `NULL`; the importer does not turn missing units or missing dates into zero.

## Requirements

- Node.js 20 or newer.
- Docker Compose v2 (recommended for local PostgreSQL) or an existing PostgreSQL 15+ database.
- A PostgreSQL role that can create the `reja` schema and its tables/views.

## Run locally

From this folder:

```bash
cp .env.example .env
docker compose up -d
npm install
npm run migrate
npm run import:html
npm start
```

Then open `http://127.0.0.1:8787/`.

The `docker-compose.yml` binds Postgres to loopback only. The password in `.env.example` is for local development; replace it before any shared or deployed environment. Node's `--env-file=.env` option loads the local settings. For an existing database, set `DATABASE_URL` to that database and run the same migration/import commands. For production-like use, create a `reja_app` role with `SELECT` only and set `APP_DATABASE_URL` to it for the web process. Migration and import commands continue to use the privileged `DATABASE_URL`; the web server uses `APP_DATABASE_URL` when set and falls back to `DATABASE_URL` only for local convenience.

### Import another REJA HTML snapshot

The importer reads the exact embedded `reja-data` JSON script, validates entity IDs and score/number ranges, then imports in a serializable transaction. It is idempotent for unchanged data and serializes competing import runs with a transaction advisory lock. The original HTML snapshot is retained in `public/REJA-standalone.html`.

```bash
npm run import:file -- /absolute/path/to/your-reja-export.html
```

Or set `REJA_HTML_PATH` in `.env` and run `npm run import:html`.

The importer does not infer that a source is governmental from `rdb`, `rha`, or another URL substring. URLs that appear in fields are canonicalized in the source table while unclassified sources remain unclassified until reviewed. Timeline events, scoring factors, conflicts, field claims, sources, assets, and developers are kept as history; the snapshot's `is_current` marker identifies live records. Relationship links use the same current/historical model: an import marks old developer/source/owner-group links non-current, and reactivates current links without deleting prior membership history. SQL views and API queries explicitly filter current relationships so old links do not inflate live metrics.

## DXB Interact-inspired market intelligence

The new Market Intelligence page is served at `http://127.0.0.1:8787/market`. It is designed around a simple distinction: **a listing is an asking price; a verified transaction is evidence of a completed deal**. It borrows the useful transaction-first ideas of Dubai market tools but is built for Rwanda sources, geography, and currency.

### What this adds

- `reja.market_properties` identifies buildings, units, property types and locations.
- `reja.market_transactions` stores source-linked sales and rental transactions. Currency and rent period stay explicit; price per square metre is derived only where a valid area is available.
- `reja.market_transaction_evidence` lets other sources corroborate or challenge a canonical transaction without double-counting the deal.
- `reja.market_verified_transactions` is the shared eligibility view used by public transaction metrics. It excludes transactions with unresolved contradictory evidence.
- `reja.market_listings` and `reja.market_listing_observations` track current asking prices and changes over time separately from completed deals.
- Monthly area trends and project-comparison metrics are derived from current eligible records. Medians are grouped by currency, rent period, property type and transaction type so unlike records are not silently mixed.

No sample transaction or market price is seeded. An empty dashboard means verified source records have not yet been imported for that filter; it does not mean no property deals occurred.

### Import a sourced market snapshot

Create a JSON file with a `source` object and optional `properties`, `transactions` and `listings` arrays. The importer validates source identity, source URLs, date formats, currencies, positive prices and areas, property types and rental periods. Every transaction and listing must have a stable `sourceRecordKey`. Property records must have a stable `externalId`.

Transaction fields use these names:

- Required: `sourceRecordKey`, `transactionType` (`sale` or `rent`), `transactionDate` (`YYYY-MM-DD`), `amount`, `currency`, `propertyType`, and `district`.
- Rentals also require `rentPeriod` (`daily`, `weekly`, `monthly` or `yearly`). Sales use `not_applicable`.
- Optional links: `propertyExternalId` and `projectExternalId`. A project ID must already exist as a current project in REJA.
- Optional comparison inputs: `propertyAreaSqm`, `bedrooms`, `sector`, `buildingName`, `unitLabel`, `transactionChannel` and `paymentMethod`.
- Verification defaults to `unverified`. To be included in public market statistics, a row must be marked `verified`, include a timezone-aware `verifiedAt` timestamp and pass the importer's explicit verification override.

Listing fields use `sourceRecordKey`, `listingType`, `askingAmount`, `currency`, `propertyType` and `district`; they can optionally include `rentPeriod`, `propertyAreaSqm`, `listingUrl`, `propertyExternalId` and `projectExternalId`. The asking price is never written into the transaction table.

Run the normal migration first, then import the prepared source file from this directory:

```bash
npm run migrate
npm run market:import -- /absolute/path/to/market-snapshot.json
```

A regular import leaves transaction rows unverified. After a reviewer has inspected the underlying evidence and made the verification decision, use `--allow-verified` in the import command for a snapshot that explicitly marks approved records as verified and supplies `verifiedAt`. Do not use this flag simply because a price appears on a property website or social post. The source is recorded, but the importer does not automatically declare a source authoritative.

Identical transaction observations can be linked to one canonical transaction with additional source evidence when their stable property/unit identity and transaction attributes match. Rows with an unresolved `contradicts` evidence status are excluded from public aggregates until that conflict is resolved. Imports run in a serializable database transaction and are recorded in `reja.ingestion_runs`.

### Market endpoints

- `GET /api/v1/market/summary` — counts of verified sales, rentals, active listings and coverage.
- `GET /api/v1/market/areas?limit=100` — areas represented by verified transactions.
- `GET /api/v1/market/transactions?type=sale&propertyType=apartment&currency=RWF` — filtered transaction register.
- `GET /api/v1/market/trends?type=sale&propertyType=apartment&currency=RWF&rentPeriod=not_applicable` — monthly median trend data.
- `GET /api/v1/market/listings?type=sale&propertyType=apartment&currency=RWF` — active asking prices, clearly separate from verified deals.
- `GET /api/v1/market/projects/compare?ids=PROJECT-ID-1,PROJECT-ID-2` — compare current REJA projects with linked verified transactions.

These are read-only HTTP endpoints. Imports run as an explicit command; public API requests cannot create or modify investment records. This market layer is not a land-title registry, proof of ownership, or an official valuation service.

## Runtime least-privilege role

The web application exposes only read endpoints, so it should not connect with the migration/import owner in any shared environment. After the initial migration, export the local settings and connect to the `reja` database as its owner/admin:

```bash
set -a; . ./.env; set +a
psql "$DATABASE_URL" -f database/runtime_readonly_role.sql
psql "$DATABASE_URL"
```

In the interactive `psql` session, set a strong role password with `\password reja_app`; do not save it in source control. Exit `psql`, then uncomment/configure `APP_DATABASE_URL` in `.env` to use the read-only role for the web process. The `ALTER DEFAULT PRIVILEGES` owner must match the role that creates future tables and views; adjust `FOR ROLE reja` in the script if migrations run under a different owner.

## Useful endpoints

- `GET /api/v1/health` — server/database/migration health.
- `GET /api/v1/bootstrap` — database-backed payload used to render the existing UI.
- `GET /api/v1/metrics` — coverage and most recent import summary.
- `GET /api/v1/data-quality/issues?severity=warning&limit=50` — data-quality review queue.
- `GET /api/v1/assets?type=project&q=Rebero&page=1&pageSize=25&sortBy=confidence&sortDir=desc` — parameterized asset query with a safe sort whitelist.
- `GET /api/v1/assets/{asset-id}` — one normalized asset plus its evidence register.
- `GET /api/v1/assets/{asset-id}/evidence` — field claims, timeline, sources, conflicts and score factors.
- `GET /api/v1/developers/{developer-id}` — developer row and relational portfolio metrics.
- `GET /api/v1/sources?q=RHA&limit=50` — canonical source catalogue.

Write endpoints are intentionally not exposed. Import is a deliberate command, not a publicly reachable `POST` that silently changes investment records. Watchlists and diligence cases in the existing prototype still have browser-session scope; they are not misrepresented as database-persisted. A future shared deployment needs authentication/authorization and user-owned workspace tables before these become persistent multi-user features.

## Checks

```bash
npm run check
```

`npm run check` syntax-checks the Node services and embedded browser JavaScript, and tests the embedded data shape, uniqueness, whole-number unit counts, null/unknown behavior, URL-authority policy, JSON script escaping, current/history semantics, SQL migration contracts, and the empty SQL-serving template. A live database smoke test should also be run on the target PostgreSQL instance after migration and import:

```bash
curl -fsS http://127.0.0.1:8787/api/v1/health
curl -fsS http://127.0.0.1:8787/api/v1/metrics
curl -fsS 'http://127.0.0.1:8787/api/v1/assets?type=project&pageSize=5'
```

`npm run check` does not replace a live PostgreSQL execution test.

## Backup and restore

Use a unique destination filename and keep backups outside the project directory:

```bash
set -a; . ./.env; set +a
pg_dump "$DATABASE_URL" --format=custom --file="reja-$(date +%F-%H%M%S).dump"
createdb reja_restore_test
pg_restore --dbname="postgres://USER:PASSWORD@HOST:5432/reja_restore_test" --clean --if-exists reja-YYYY-MM-DD-HHMMSS.dump
```

Run restore tests periodically; a backup is not verified until restore succeeds.

## Production notes

- The web server binds to `127.0.0.1` by default; avoid exposing it directly to the public Internet.
- Use a private network, TLS-terminating reverse proxy, explicit authentication/authorization, secret manager, database least-privilege role and rate limiting before sharing it across a network.
- Create new numbered migration files instead of editing an applied migration. The runner checks migration checksums and fails if an already-applied file changes.
- Keep import snapshots, backups, source provenance and data-quality issues under retention policy. Do not treat the imported legacy payload as a legal title or verified transaction register.
- Risk and confidence fields are stored as supplied; this layer does not claim that the underlying source material has been independently verified.
