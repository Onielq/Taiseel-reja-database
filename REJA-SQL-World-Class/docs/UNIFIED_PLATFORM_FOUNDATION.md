# Taiseel unified platform foundation

This migration extends the existing REJA PostgreSQL model. It does not replace its asset, developer, source-claim, audit or Market Intelligence structures.

## Four-pillar mapping

| Product pillar | Canonical records |
| --- | --- |
| Land Intelligence | `geo_areas`, `geo_area_source_records`, `parcels`, `parcel_source_records`, `asset_parcels`; source reuse permissions are kept on `sources` |
| Development Intelligence | Existing `assets`, `developers`, claims and timelines; new `development_phases`, `development_buildings`, `development_units` |
| Real Estate Exchange / MLS | `app_users`, `organizations`, `organization_memberships`, `organization_invitations`, `listing_authorizations`, `exchange_listings`, `exchange_listing_observations`, `exchange_listing_events` |
| Market Intelligence | Existing `market_properties`, `market_transactions`, `market_transaction_evidence`, `market_listings` and market views; properties can now link to parcels and development units |

## Boundaries that must remain separate

- `market_listings` is external/source-observed listing data. `exchange_listings` is first-party Taiseel inventory. An imported advert is not automatically an authorized Taiseel listing.
- Asking prices remain separate from completed transaction records.
- Organization identity, professional role and permission to publish are separate claims.
- A listing cannot enter `published` state unless its linked seller authorization is verified, matches the exact market property and is within its validity period.
- Parcel geometry and UPI are cadastral evidence, not proof of ownership, encumbrances, legal build permission or title.
- Source reuse permissions are nullable. `NULL` means unknown/not established, never permission granted.
- No demo users, organizations, parcels, project units, listings or transactions are seeded.

## Authentication contract

The schema reads the transaction-local PostgreSQL setting `reja.current_user_id`. A trusted backend must:

1. Verify the signed session/JWT with the selected identity provider.
2. Resolve the verified provider subject to `reja.app_users.id`.
3. Begin a database transaction.
4. Set the user context with `SELECT set_config('reja.current_user_id', $1, true)`.
5. Perform all authorized operations within that same transaction, then commit or roll back.

Never accept a user UUID from an untrusted browser payload and write it into this setting. Never keep user context across pooled requests. Only trusted server code may set it, after token verification.

A user's newly created organization can receive its first owner membership through the bootstrap policy. Additional memberships require an active owner/admin or platform administrator. Platform roles are provisioned only through a controlled operator process.

A seller can submit authorization evidence but cannot verify their own claim. Verification requires a platform moderator/admin. The schema provides policy boundaries; it does not yet implement an authentication UI, invitation email delivery, moderation console, or government verification integration.

## Runtime and migration sequence

1. Provision a development PostgreSQL project with PostGIS enabled.
2. Apply migrations in order: `001_initial_schema.sql`, `002_market_intelligence.sql`, `003_unified_platform.sql`.
3. Create least-privilege runtime roles. The public application should receive read access only to approved public datasets. Listing writes must use a server-side role with RLS enforced.
4. Choose and integrate the identity provider. Until verified signed-session context exists, keep user and listing writes disabled.
5. Connect Vercel and Cloudflare Worker runtimes to the same database using pooled request-time connections; use a direct connection for migrations. Cloudflare currently recommends Hyperdrive with `pg` for Workers; the Neon serverless driver is also supported.
6. Import research records as unverified/source-documented claims, preserving source URLs, dates and conflicts. Do not bulk-mark records verified.
7. Connect map and directory APIs to canonical records only after identity mapping, source attribution and integration tests pass.

## Current deployment limitation

The connected Neon account currently has no provisioned project, and the existing Cloudflare Worker has no Hyperdrive binding. This migration therefore does not attempt a live connection or deployment. Create and test the development database, least-privilege roles and direct migration connection before adding Hyperdrive or application secrets.

References:
- [Cloudflare: Neon on Workers](https://developers.cloudflare.com/workers/databases/third-party-integrations/neon/)
- [Cloudflare: Connect to databases](https://developers.cloudflare.com/workers/databases/connecting-to-databases/)
- [Neon: Connection pooling](https://neon.com/docs/connect/connection-pooling)
