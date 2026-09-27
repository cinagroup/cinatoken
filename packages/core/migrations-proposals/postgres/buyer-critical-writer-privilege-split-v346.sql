-- REVIEW ONLY. Apply only in an owned test database after PG73 and the current
-- runtime grant. This is a cutover probe, not a formal migration or a complete
-- production ACL: management, admission, payout, C03 and v2 producer identities
-- still need separate reviewed contracts.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.users,
  cinatoken_gateway.api_keys,
  cinatoken_gateway.user_earnings,
  cinatoken_gateway.withdrawals,
  cinatoken_gateway.shared_key_earnings,
  cinatoken_gateway.portal_ledger_entries,
  cinatoken_gateway.user_budget_reservations,
  cinatoken_gateway.api_key_request_logs,
  cinatoken_gateway.user_audit_logs,
  cinatoken_gateway.provider_attempt_availability,
  cinatoken_gateway.public_model_daily_stats,
  cinatoken_gateway.guardrail_budget_reservations,
  cinatoken_gateway.guardrail_budget_windows
  IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE buyer_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_runtime';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_buyer_settlement';
  IF CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR SESSION_USER <> CURRENT_USER
    OR pg_catalog.current_setting('cinatoken.buyer_settlement_privilege_split', true)
       IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR runtime_oid IS NULL OR buyer_oid IS NULL
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
        WHERE nspname = 'cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE oid = buyer_oid)
       IS DISTINCT FROM TRUE
    OR (SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication
        OR rolbypassrls OR rolinherit
        FROM pg_catalog.pg_roles WHERE oid = buyer_oid) IS DISTINCT FROM FALSE
    OR pg_catalog.pg_has_role(buyer_oid, migrator_oid, 'MEMBER')
    OR pg_catalog.pg_has_role(buyer_oid, runtime_oid, 'MEMBER')
    OR pg_catalog.pg_has_role(runtime_oid, buyer_oid, 'MEMBER')
    OR pg_catalog.pg_has_role(buyer_oid,
        'pg_read_all_data'::pg_catalog.regrole, 'MEMBER')
    OR pg_catalog.pg_has_role(buyer_oid,
        'pg_write_all_data'::pg_catalog.regrole, 'MEMBER')
    OR NOT EXISTS (SELECT 1 FROM cinatoken_gateway.schema_migrations
        WHERE version = '0073_recovery_api_key_workspace_lock.sql')
    OR (SELECT count(*) FROM cinatoken_gateway.schema_migrations) <> 73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version, E'\n'
        ORDER BY version COLLATE "C"))
        FROM cinatoken_gateway.schema_migrations)
       <> 'ca1ea96a1b4bcd0675642f30dcf48042'
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
        WHERE c.oid IN (
          'cinatoken_gateway.users'::pg_catalog.regclass,
          'cinatoken_gateway.api_keys'::pg_catalog.regclass,
          'cinatoken_gateway.user_earnings'::pg_catalog.regclass,
          'cinatoken_gateway.withdrawals'::pg_catalog.regclass,
          'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass,
          'cinatoken_gateway.portal_ledger_entries'::pg_catalog.regclass,
          'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass,
          'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass,
          'cinatoken_gateway.user_audit_logs'::pg_catalog.regclass,
          'cinatoken_gateway.provider_attempt_availability'::pg_catalog.regclass,
          'cinatoken_gateway.public_model_daily_stats'::pg_catalog.regclass,
          'cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass,
          'cinatoken_gateway.guardrail_budget_windows'::pg_catalog.regclass)
          AND (c.relowner <> migrator_oid OR c.relkind <> 'r'
            OR c.relrowsecurity OR c.relforcerowsecurity))
  THEN
    RAISE EXCEPTION 'buyer settlement privilege split activation or dependency differs'
      USING ERRCODE = 'P0001';
  END IF;
END
$preflight$;

-- Existing runtime table-level grants must be removed before column grants can
-- constrain financial writes. This test policy deliberately breaks legacy
-- management/admission/payout callers; no production rollout is implied.
REVOKE INSERT, UPDATE, DELETE ON TABLE
  cinatoken_gateway.users,
  cinatoken_gateway.user_earnings,
  cinatoken_gateway.withdrawals,
  cinatoken_gateway.user_budget_reservations
FROM cinatoken_gateway_runtime;
REVOKE INSERT ON TABLE
  cinatoken_gateway.shared_key_earnings,
  cinatoken_gateway.portal_ledger_entries
FROM cinatoken_gateway_runtime;

GRANT USAGE ON SCHEMA cinatoken_gateway
  TO cinatoken_gateway_buyer_settlement;
GRANT SELECT ON TABLE
  cinatoken_gateway.users,
  cinatoken_gateway.api_keys,
  cinatoken_gateway.workspaces,
  cinatoken_gateway.user_budget_reservations,
  cinatoken_gateway.api_key_request_logs,
  cinatoken_gateway.guardrail_budget_reservations,
  cinatoken_gateway.guardrail_budget_windows
TO cinatoken_gateway_buyer_settlement;
-- SELECT FOR UPDATE needs UPDATE permission, but no identity-changing API-key
-- column is granted for mutation.
GRANT UPDATE (updated_at) ON TABLE cinatoken_gateway.api_keys
  TO cinatoken_gateway_buyer_settlement;
GRANT UPDATE (budget_spent, budget_reserved_micros, updated_at)
  ON TABLE cinatoken_gateway.users
  TO cinatoken_gateway_buyer_settlement;
GRANT UPDATE (state, settled_micros, terminal_at, terminal_reason, updated_at)
  ON TABLE cinatoken_gateway.user_budget_reservations
  TO cinatoken_gateway_buyer_settlement;
GRANT INSERT ON TABLE
  cinatoken_gateway.api_key_request_logs,
  cinatoken_gateway.user_audit_logs,
  cinatoken_gateway.provider_attempt_availability
TO cinatoken_gateway_buyer_settlement;
GRANT SELECT, INSERT, UPDATE ON TABLE
  cinatoken_gateway.public_model_daily_stats
TO cinatoken_gateway_buyer_settlement;
GRANT SELECT, UPDATE ON TABLE
  cinatoken_gateway.guardrail_budget_reservations,
  cinatoken_gateway.guardrail_budget_windows
TO cinatoken_gateway_buyer_settlement;

DO $postflight$
DECLARE runtime_oid oid;
DECLARE buyer_oid oid;
BEGIN
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_runtime';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_buyer_settlement';
  IF pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.users', 'INSERT,UPDATE,DELETE')
    OR pg_catalog.has_column_privilege(runtime_oid,
      'cinatoken_gateway.users', 'budget_spent', 'UPDATE')
    OR pg_catalog.has_column_privilege(runtime_oid,
      'cinatoken_gateway.users', 'budget_reserved_micros', 'UPDATE')
    OR pg_catalog.has_column_privilege(runtime_oid,
      'cinatoken_gateway.user_earnings', 'balance_micros', 'UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.shared_key_earnings', 'INSERT')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.user_budget_reservations', 'INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.user_earnings', 'INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.shared_key_earnings', 'INSERT')
    OR pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.users', 'budget_max', 'UPDATE')
    OR pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.api_keys', 'workspace_id', 'UPDATE')
    OR NOT pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.users', 'budget_spent', 'UPDATE')
    OR NOT pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.users', 'budget_reserved_micros', 'UPDATE')
  THEN
    RAISE EXCEPTION 'buyer settlement privilege split postflight differs'
      USING ERRCODE = 'P0001';
  END IF;
END
$postflight$;
