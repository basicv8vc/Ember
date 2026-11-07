-- Run once after all current migrations have been applied as `ember_migrator`.
-- Future objects created by this role inherit the defaults from least-privilege-roles.sql.

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ember TO ember_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ember TO ember_runtime;

-- The runtime does not need read or write access to migration history.
REVOKE ALL ON TABLE ember.schema_migrations FROM ember_runtime;
