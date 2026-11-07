-- Optional application role for user/organization/listing workflows.
-- Run after all schema migrations while connected as a database owner/admin.
-- Set a strong password interactively: psql> \\password reja_exchange_app
-- This role deliberately has NOBYPASSRLS. Every user-scoped request must set
-- reja.current_user_id transaction-locally after server-side identity checks.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reja_exchange_app') THEN
    CREATE ROLE reja_exchange_app LOGIN NOBYPASSRLS;
  END IF;
END
$$;
ALTER ROLE reja_exchange_app LOGIN NOBYPASSRLS;
GRANT CONNECT ON DATABASE reja TO reja_exchange_app;
GRANT USAGE ON SCHEMA reja TO reja_exchange_app;

-- Public/data reads are granted here; RLS still controls private records.
GRANT SELECT ON ALL TABLES IN SCHEMA reja TO reja_exchange_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA reja TO reja_exchange_app;

-- Account and organization writes. RLS defines which rows may be changed.
GRANT INSERT, UPDATE ON reja.app_users TO reja_exchange_app;
GRANT INSERT, UPDATE ON reja.organizations TO reja_exchange_app;
GRANT INSERT, UPDATE ON reja.organization_memberships TO reja_exchange_app;
GRANT INSERT, UPDATE ON reja.organization_invitations TO reja_exchange_app;
GRANT INSERT, UPDATE ON reja.platform_user_roles TO reja_exchange_app;

-- Seller authorization and first-party inventory. No physical DELETE is granted.
GRANT INSERT, UPDATE ON reja.listing_authorizations TO reja_exchange_app;
GRANT INSERT, UPDATE ON reja.exchange_listings TO reja_exchange_app;
GRANT INSERT ON reja.exchange_listing_observations TO reja_exchange_app;
GRANT INSERT ON reja.exchange_listing_events TO reja_exchange_app;

-- Keep future-table privileges explicit. Re-run this script after new migrations
-- if the migration owner differs from the role named here.
ALTER DEFAULT PRIVILEGES FOR ROLE reja IN SCHEMA reja
  GRANT SELECT ON TABLES TO reja_exchange_app;
ALTER DEFAULT PRIVILEGES FOR ROLE reja IN SCHEMA reja
  GRANT USAGE, SELECT ON SEQUENCES TO reja_exchange_app;
