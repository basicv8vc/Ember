-- Run once while connected to the target database as its administrative database role.
-- Set unique passwords using the provider console or a secret manager after creating roles.
-- Never commit credentials or give ember_runtime ownership of the schema.

CREATE ROLE ember_migrator
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOBYPASSRLS;

CREATE ROLE ember_runtime
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOBYPASSRLS;

DO $setup$
DECLARE
  target_database text := current_database();
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ember_migrator, ember_runtime', target_database);
  EXECUTE format('ALTER ROLE ember_migrator IN DATABASE %I SET search_path TO ember', target_database);
  EXECUTE format('ALTER ROLE ember_runtime IN DATABASE %I SET search_path TO ember', target_database);
  EXECUTE format('ALTER ROLE ember_runtime IN DATABASE %I SET statement_timeout TO %L', target_database, '10s');
END
$setup$;

CREATE SCHEMA ember AUTHORIZATION ember_migrator;
REVOKE ALL ON SCHEMA ember FROM PUBLIC;
GRANT USAGE ON SCHEMA ember TO ember_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE ember_migrator IN SCHEMA ember
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ember_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE ember_migrator IN SCHEMA ember
  GRANT USAGE, SELECT ON SEQUENCES TO ember_runtime;
