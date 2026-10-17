-- Optional least-privilege application role.
-- Run while connected to the REJA database as a database owner/admin.
-- After this script, set a strong password interactively: psql> \password reja_app
-- Adjust ALTER DEFAULT PRIVILEGES FOR ROLE if migrations run under a different owner.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reja_app') THEN
        CREATE ROLE reja_app;
    END IF;
END
$$;
ALTER ROLE reja_app LOGIN;
GRANT CONNECT ON DATABASE reja TO reja_app;
GRANT USAGE ON SCHEMA reja TO reja_app;
GRANT SELECT ON ALL TABLES IN SCHEMA reja TO reja_app;
ALTER DEFAULT PRIVILEGES FOR ROLE reja IN SCHEMA reja GRANT SELECT ON TABLES TO reja_app;
