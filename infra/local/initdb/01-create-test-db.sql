-- Runs only when the local Docker volume is initialised for the first time.
-- The application database (`ember`) is created by POSTGRES_DB; this adds the
-- dedicated database used by `pnpm test:integration`.

CREATE DATABASE ember_test OWNER ember;
