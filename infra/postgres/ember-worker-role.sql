-- Least-privilege PostgreSQL runtime role for the B1 API Worker.
-- Run after the Ember migrations as a database administrator. On providers that manage role
-- creation in their console (including Neon), create ember_worker there first; this script then
-- applies the same grants. Set credentials out of band and never commit them or put them in iOS.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ember_worker') THEN
    EXECUTE 'CREATE ROLE ember_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE '
      || 'NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
END
$$;

ALTER ROLE ember_worker WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE ember_worker SET statement_timeout = '5s';
ALTER ROLE ember_worker SET idle_in_transaction_session_timeout = '5s';

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ember_worker', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO ember_worker;
GRANT USAGE ON SCHEMA ember_private TO ember_worker;

-- Remove any old direct grants to this role before applying the narrow B1 set below.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ember_worker;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ember_worker;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ember_private FROM ember_worker;

GRANT INSERT ON TABLE public.tenants TO ember_worker;
GRANT SELECT, INSERT ON TABLE public.principals TO ember_worker;
GRANT SELECT, INSERT ON TABLE public.consumers TO ember_worker;
GRANT SELECT, INSERT, UPDATE ON TABLE public.consumer_identities TO ember_worker;
GRANT SELECT, INSERT, UPDATE ON TABLE public.consumer_sessions TO ember_worker;
GRANT SELECT, INSERT ON TABLE public.agents TO ember_worker;
GRANT SELECT, INSERT, UPDATE ON TABLE public.conversations TO ember_worker;
GRANT SELECT, INSERT ON TABLE public.conversation_messages TO ember_worker;
GRANT SELECT, INSERT, UPDATE ON TABLE public.assistant_turns TO ember_worker;
GRANT SELECT, INSERT, DELETE ON TABLE ember_private.apple_identity_nonce_replays TO ember_worker;
GRANT INSERT ON TABLE public.b1_turn_dispatch_outbox TO ember_worker;
