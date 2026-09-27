-- REVIEW ONLY. Install after shared-key-buyer-budget-receipt-v2.sql.
-- No formal migration, scheduler, retention period, or production grant here.
-- Apply as the direct migrator LOGIN in one transaction with:
--   SET LOCAL cinatoken.shared_key_buyer_receipt_maintenance_install = 'reviewed-v1';
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
LOCK TABLE cinatoken_gateway.schema_migrations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts
  IN ACCESS EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.shared_key_buyer_receipt_maintenance_install',true)
        IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR runtime_oid IS NULL
    OR pg_catalog.pg_has_role(runtime_oid,migrator_oid,'MEMBER')
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid='cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts'::pg_catalog.regclass
        AND c.relowner=migrator_oid AND c.relkind='r'
        AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
        LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
          pg_catalog.acldefault('r',c.relowner))) acl
      WHERE c.oid='cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts'::pg_catalog.regclass
        AND acl.grantee<>migrator_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a,
        LATERAL pg_catalog.aclexplode(a.attacl) acl
      WHERE a.attrelid='cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts'::pg_catalog.regclass
        AND NOT a.attisdropped AND acl.grantee<>migrator_oid)
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute a
      WHERE a.attrelid='cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts'::pg_catalog.regclass
        AND NOT a.attisdropped AND (
          a.attname='xact_id' AND a.atttypid='xid8'::pg_catalog.regtype
          OR a.attname='user_id' AND a.atttypid='text'::pg_catalog.regtype))<>2
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid='cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts'::pg_catalog.regclass
        AND a.attname='first_seen_at' AND NOT a.attisdropped)
    OR pg_catalog.to_regprocedure(
      'cinatoken_economic_outbox.backfill_buyer_budget_receipt_time(integer)') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_economic_outbox.prune_buyer_budget_receipts(timestamptz,integer)') IS NOT NULL
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts'::pg_catalog.regclass,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d,
        LATERAL pg_catalog.aclexplode(d.defaclacl) acl
      WHERE d.defaclrole=migrator_oid
        AND (d.defaclnamespace=0 OR
          d.defaclnamespace='cinatoken_economic_outbox'::pg_catalog.regnamespace)
        AND d.defaclobjtype='f' AND acl.grantee<>migrator_oid)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid='cinatoken_gateway.users'::pg_catalog.regclass
        AND t.tgname='users_capture_shared_key_buyer_budget_tx'
        AND t.tgenabled='O' AND t.tgfoid=
          'cinatoken_economic_outbox.capture_buyer_budget_tx_receipt()'::pg_catalog.regprocedure)
  THEN
    RAISE EXCEPTION 'Buyer receipt maintenance installation contract differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_receipt_maintenance_install';
  END IF;
END;
$preflight$;

-- Nullable expansion avoids a table-wide timestamp rewrite. New receipts get
-- their real insertion time; old rows remain ineligible until bounded backfill
-- stamps them at the time they were first reviewed for retention.
ALTER TABLE cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts
  ADD COLUMN first_seen_at timestamptz;
ALTER TABLE cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts
  ALTER COLUMN first_seen_at SET DEFAULT pg_catalog.clock_timestamp();

CREATE FUNCTION cinatoken_economic_outbox.backfill_buyer_budget_receipt_time(
  p_limit integer)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path TO pg_catalog,pg_temp AS $backfill$
DECLARE changed integer;
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR pg_catalog.current_setting(
      'cinatoken.shared_key_buyer_receipt_maintenance_run',true)
        IS DISTINCT FROM 'reviewed-v1'
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Buyer receipt timestamp backfill requires direct bounded migrator run'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_receipt_maintenance_run';
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT xact_id,user_id FROM
      cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts
      WHERE first_seen_at IS NULL
      ORDER BY xact_id,user_id FOR UPDATE SKIP LOCKED LIMIT p_limit
  ), updated AS (
    UPDATE cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts r
      SET first_seen_at=pg_catalog.clock_timestamp()
      FROM candidates c
      WHERE r.xact_id=c.xact_id AND r.user_id=c.user_id
      RETURNING 1
  ) SELECT pg_catalog.count(*)::integer INTO changed FROM updated;
  RETURN changed;
END;
$backfill$;

CREATE FUNCTION cinatoken_economic_outbox.prune_buyer_budget_receipts(
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
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Buyer receipt pruning requires direct bounded migrator run'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_receipt_maintenance_run';
  END IF;
  safe_xmin:=pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot());
  WITH candidates AS MATERIALIZED (
    SELECT xact_id,user_id FROM
      cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts
      WHERE first_seen_at<p_before AND xact_id<safe_xmin
      ORDER BY first_seen_at,xact_id,user_id
      FOR UPDATE SKIP LOCKED LIMIT p_limit
  ), deleted AS (
    DELETE FROM cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts r
      USING candidates c
      WHERE r.xact_id=c.xact_id AND r.user_id=c.user_id
      RETURNING 1
  ) SELECT pg_catalog.count(*)::integer INTO changed FROM deleted;
  RETURN changed;
END;
$prune$;

REVOKE ALL ON FUNCTION
  cinatoken_economic_outbox.backfill_buyer_budget_receipt_time(integer),
  cinatoken_economic_outbox.prune_buyer_budget_receipts(timestamptz,integer)
  FROM PUBLIC,cinatoken_gateway_runtime;

DO $postflight$
DECLARE migrator_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid='cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts'::pg_catalog.regclass
        AND a.attname='first_seen_at' AND a.atttypid='timestamptz'::pg_catalog.regtype
        AND NOT a.attnotnull AND NOT a.attisdropped
        AND pg_catalog.pg_get_expr(d.adbin,d.adrelid)='clock_timestamp()')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a,
        LATERAL pg_catalog.aclexplode(a.attacl) acl
      WHERE a.attrelid='cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts'::pg_catalog.regclass
        AND NOT a.attisdropped AND acl.grantee<>migrator_oid)
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p,
        LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
          pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.oid IN (
        'cinatoken_economic_outbox.backfill_buyer_budget_receipt_time(integer)'::pg_catalog.regprocedure,
        'cinatoken_economic_outbox.prune_buyer_budget_receipts(timestamptz,integer)'::pg_catalog.regprocedure)
        AND (p.proowner<>migrator_oid OR p.prosecdef OR p.provolatile<>'v'
          OR p.proconfig<>ARRAY['search_path=pg_catalog, pg_temp']::text[]
          OR acl.grantee<>migrator_oid))<>0
  THEN
    RAISE EXCEPTION 'Buyer receipt maintenance postflight differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_receipt_maintenance_postflight';
  END IF;
END;
$postflight$;
