-- REVIEW ONLY. Install after shared-key-buyer-budget-receipt-maintenance.sql.
-- This does not select a retention period, schedule maintenance, or grant runtime access.
-- Apply as the direct migrator LOGIN in one transaction with:
--   SET LOCAL cinatoken.shared_key_buyer_receipt_retention_install = 'reviewed-v1';
-- Build the two separate CONCURRENTLY indexes before running either function.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
LOCK TABLE cinatoken_gateway.schema_migrations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts
  IN ACCESS EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE receipt_oid oid := 'cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts'::pg_catalog.regclass;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.shared_key_buyer_receipt_retention_install',true)
        IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR runtime_oid IS NULL
    OR pg_catalog.pg_has_role(runtime_oid,migrator_oid,'MEMBER')
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid=receipt_oid AND c.relowner=migrator_oid AND c.relkind='r'
        AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
        LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
          pg_catalog.acldefault('r',c.relowner))) acl
      WHERE c.oid=receipt_oid AND acl.grantee<>migrator_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a,
        LATERAL pg_catalog.aclexplode(a.attacl) acl
      WHERE a.attrelid=receipt_oid AND NOT a.attisdropped
        AND acl.grantee<>migrator_oid)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=receipt_oid AND a.attname='first_seen_at'
        AND a.atttypid='timestamptz'::pg_catalog.regtype
        AND NOT a.attnotnull AND NOT a.attisdropped
        AND pg_catalog.pg_get_expr(d.adbin,d.adrelid)='clock_timestamp()')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid=receipt_oid AND a.attname='finalized_observed_at'
        AND NOT a.attisdropped)
    OR pg_catalog.to_regprocedure(
      'cinatoken_economic_outbox.observe_buyer_budget_receipt_finalization(integer)')
        IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid='cinatoken_economic_outbox.prune_buyer_budget_receipts(timestamptz,integer)'::pg_catalog.regprocedure
        AND p.proowner=migrator_oid AND NOT p.prosecdef AND p.provolatile='v')
    OR pg_catalog.has_table_privilege(runtime_oid,receipt_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d,
        LATERAL pg_catalog.aclexplode(d.defaclacl) acl
      WHERE d.defaclrole=migrator_oid
        AND (d.defaclnamespace=0 OR
          d.defaclnamespace='cinatoken_economic_outbox'::pg_catalog.regnamespace)
        AND d.defaclobjtype='f' AND acl.grantee<>migrator_oid)
  THEN
    RAISE EXCEPTION 'Buyer receipt retention installation contract differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_receipt_retention_install';
  END IF;
END;
$preflight$;

-- This is deliberately NULL for newly inserted as well as historical rows.
-- Only a later committed-row observation can stamp it.
ALTER TABLE cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts
  ADD COLUMN finalized_observed_at timestamptz;

CREATE FUNCTION cinatoken_economic_outbox.observe_buyer_budget_receipt_finalization(
  p_limit integer)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path TO pg_catalog,pg_temp AS $observe$
DECLARE safe_xmin xid8;
DECLARE changed integer;
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR pg_catalog.current_setting(
      'cinatoken.shared_key_buyer_receipt_maintenance_run',true)
        IS DISTINCT FROM 'reviewed-v1'
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000
    OR NOT cinatoken_economic_outbox.buyer_receipt_retention_indexes_ready() THEN
    RAISE EXCEPTION 'Buyer receipt finalization observation requires indexed bounded direct migrator run'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_receipt_retention_run';
  END IF;
  safe_xmin:=pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot());
  WITH candidates AS MATERIALIZED (
    SELECT xact_id,user_id FROM
      cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts
      WHERE finalized_observed_at IS NULL AND xact_id<safe_xmin
      ORDER BY xact_id,user_id FOR UPDATE SKIP LOCKED LIMIT p_limit
  ), updated AS (
    UPDATE cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts r
      SET finalized_observed_at=pg_catalog.clock_timestamp()
      FROM candidates c
      WHERE r.xact_id=c.xact_id AND r.user_id=c.user_id
        AND r.finalized_observed_at IS NULL
      RETURNING 1
  ) SELECT pg_catalog.count(*)::integer INTO changed FROM updated;
  RETURN changed;
END;
$observe$;

-- Replace v345's insertion/backfill-age rule. A caller-supplied cutoff can
-- never make a row eligible until its transaction was observed finalized.
CREATE OR REPLACE FUNCTION cinatoken_economic_outbox.prune_buyer_budget_receipts(
  p_before timestamptz,p_limit integer)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path TO pg_catalog,pg_temp AS $prune$
DECLARE safe_xmin xid8;
DECLARE changed integer;
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR pg_catalog.current_setting(
      'cinatoken.shared_key_buyer_receipt_maintenance_run',true)
        IS DISTINCT FROM 'reviewed-v1'
    OR p_before IS NULL OR p_before>pg_catalog.clock_timestamp()
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000
    OR NOT cinatoken_economic_outbox.buyer_receipt_retention_indexes_ready() THEN
    RAISE EXCEPTION 'Buyer receipt pruning requires indexed bounded direct migrator run'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_receipt_retention_run';
  END IF;
  safe_xmin:=pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot());
  WITH candidates AS MATERIALIZED (
    SELECT xact_id,user_id FROM
      cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts
      WHERE finalized_observed_at<p_before AND xact_id<safe_xmin
      ORDER BY finalized_observed_at,xact_id,user_id
      FOR UPDATE SKIP LOCKED LIMIT p_limit
  ), deleted AS (
    DELETE FROM cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts r
      USING candidates c
      WHERE r.xact_id=c.xact_id AND r.user_id=c.user_id
        AND r.finalized_observed_at<p_before
      RETURNING 1
  ) SELECT pg_catalog.count(*)::integer INTO changed FROM deleted;
  RETURN changed;
END;
$prune$;

-- SQL invoker function keeps catalog lookup free of role-elevation and gives
-- each maintenance page an explicit fail-closed valid-index check.
CREATE FUNCTION cinatoken_economic_outbox.buyer_receipt_retention_indexes_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO pg_catalog,pg_temp AS $ready$
  SELECT pg_catalog.count(*)=2 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
    WHERE i.indrelid='cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts'::pg_catalog.regclass
      AND c.relname IN (
        'shared_key_buyer_budget_receipts_unobserved_v346',
        'shared_key_buyer_budget_receipts_retention_due_v346')
      AND c.relnamespace='cinatoken_economic_outbox'::pg_catalog.regnamespace
      AND c.relowner=(SELECT oid FROM pg_catalog.pg_roles
        WHERE rolname='cinatoken_gateway_migrator')
      AND i.indisvalid AND i.indisready AND i.indislive
      AND ((c.relname='shared_key_buyer_budget_receipts_unobserved_v346'
          AND pg_catalog.pg_get_indexdef(c.oid)=
            'CREATE INDEX shared_key_buyer_budget_receipts_unobserved_v346 ON cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts USING btree (xact_id, user_id) WHERE (finalized_observed_at IS NULL)')
        OR (c.relname='shared_key_buyer_budget_receipts_retention_due_v346'
          AND pg_catalog.pg_get_indexdef(c.oid)=
            'CREATE INDEX shared_key_buyer_budget_receipts_retention_due_v346 ON cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts USING btree (finalized_observed_at, xact_id, user_id) WHERE (finalized_observed_at IS NOT NULL)'));
$ready$;

REVOKE ALL ON FUNCTION
  cinatoken_economic_outbox.observe_buyer_budget_receipt_finalization(integer),
  cinatoken_economic_outbox.prune_buyer_budget_receipts(timestamptz,integer),
  cinatoken_economic_outbox.buyer_receipt_retention_indexes_ready()
  FROM PUBLIC,cinatoken_gateway_runtime;

DO $postflight$
DECLARE migrator_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid='cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts'::pg_catalog.regclass
        AND a.attname='finalized_observed_at'
        AND a.atttypid='timestamptz'::pg_catalog.regtype
        AND NOT a.attnotnull AND NOT a.attisdropped AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_attrdef d
          WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p,
        LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
          pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.oid IN (
        'cinatoken_economic_outbox.observe_buyer_budget_receipt_finalization(integer)'::pg_catalog.regprocedure,
        'cinatoken_economic_outbox.prune_buyer_budget_receipts(timestamptz,integer)'::pg_catalog.regprocedure,
        'cinatoken_economic_outbox.buyer_receipt_retention_indexes_ready()'::pg_catalog.regprocedure)
        AND (p.proowner<>migrator_oid OR p.prosecdef
          OR p.proconfig IS DISTINCT FROM
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
          OR (p.oid='cinatoken_economic_outbox.buyer_receipt_retention_indexes_ready()'::pg_catalog.regprocedure
            AND p.provolatile<>'s')
          OR (p.oid<>'cinatoken_economic_outbox.buyer_receipt_retention_indexes_ready()'::pg_catalog.regprocedure
            AND p.provolatile<>'v')
          OR acl.grantee<>migrator_oid))<>0
  THEN
    RAISE EXCEPTION 'Buyer receipt retention postflight differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_receipt_retention_postflight';
  END IF;
END;
$postflight$;
