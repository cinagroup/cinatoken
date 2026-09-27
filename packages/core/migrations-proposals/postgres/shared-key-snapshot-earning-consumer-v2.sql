-- REVIEW ONLY. Version-aware entry point for the v340 seller earning consumer.
-- Apply after PG73, quote, dispatch, outbox, producer, v340 consumer, and the
-- buyer-debit-v2 companion, as direct migrator LOGIN in one transaction with:
--   SET LOCAL cinatoken.shared_key_consumer_v2_activation = 'reviewed-v1';
-- It does not install a worker, enable economic production, or release earnings.
-- The existing v340 quote calculation and atomic credit logic remain the core.
-- v2 is admitted only through this wrapper after the committed ordinary buyer
-- debit is checked. Reserved/none v2 events stay pending_manual with zero credit.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog,pg_temp;
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.api_key_request_logs,
  cinatoken_gateway.user_earnings,
  cinatoken_gateway.portal_ledger_entries,
  cinatoken_economic_outbox.shared_key_economic_events,
  cinatoken_economic_consumer.shared_key_attempt_consumptions,
  cinatoken_economic_consumer.shared_key_event_consumptions
  IN SHARE ROW EXCLUSIVE MODE;
-- Hold the old entry and guard catalog tuples through attestation and rename.
ALTER FUNCTION cinatoken_economic_consumer.consume_shared_key_economic_event(text)
  COST 100;
ALTER FUNCTION cinatoken_economic_consumer.reject_v2_event_from_v1_consumer()
  COST 100;
ALTER FUNCTION cinatoken_economic_outbox.verify_buyer_debit_v2() COST 100;

DO $preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE consumer_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO consumer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_earning_consumer';
  IF pg_catalog.current_setting('cinatoken.shared_key_consumer_v2_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR migrator_oid IS NULL OR runtime_oid IS NULL OR consumer_oid IS NULL
    OR (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE oid=consumer_oid)
      IS DISTINCT FROM TRUE
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid=consumer_oid
      AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
    OR pg_catalog.pg_has_role(consumer_oid,migrator_oid,'MEMBER')
    OR pg_catalog.pg_has_role(consumer_oid,runtime_oid,'MEMBER')
    OR pg_catalog.pg_has_role(consumer_oid,'pg_read_all_data'::pg_catalog.regrole,'MEMBER')
    OR pg_catalog.pg_has_role(consumer_oid,'pg_write_all_data'::pg_catalog.regrole,'MEMBER')
    OR (SELECT count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR pg_catalog.to_regprocedure(
      'cinatoken_economic_consumer.consume_shared_key_economic_event_v1_core(text)')
      IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
        AND c.relowner=migrator_oid AND c.relkind='r'
        AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid='cinatoken_economic_consumer.shared_key_attempt_consumptions'::pg_catalog.regclass
        AND c.relowner=migrator_oid AND c.relkind='r'
        AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
      WHERE c.conrelid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
        AND c.conname='shared_key_economic_event_version_debit'
        AND c.contype='c' AND c.convalidated)
    OR (SELECT count(*) FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE p.oid IN (
        'cinatoken_economic_consumer.consume_shared_key_economic_event(text)'::pg_catalog.regprocedure,
        'cinatoken_economic_consumer.reject_v2_event_from_v1_consumer()'::pg_catalog.regprocedure,
        'cinatoken_economic_outbox.verify_buyer_debit_v2()'::pg_catalog.regprocedure)
        AND p.proowner=migrator_oid AND l.lanname='plpgsql'
        AND p.provolatile='v' AND p.prosecdef AND p.procost=100
        AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))=
          CASE p.proname
            WHEN 'consume_shared_key_economic_event' THEN
              '1f80bb19a381a30bcdceffcc74d9f982'
            WHEN 'reject_v2_event_from_v1_consumer' THEN
              '76cf71ff9eca8868ffa8b3cd804ef81c'
            WHEN 'verify_buyer_debit_v2' THEN
              'f58977880d4f575264a2eb7110902b2b'
            ELSE '' END)<>3
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_economic_consumer.shared_key_attempt_consumptions'::pg_catalog.regclass
        AND tgname='shared_key_attempt_consumptions_v1_only'
        AND tgenabled='O'
        AND tgfoid='cinatoken_economic_consumer.reject_v2_event_from_v1_consumer()'::pg_catalog.regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
        AND tgname='shared_key_economic_events_verify_buyer_debit_v2'
        AND tgenabled='O' AND tgdeferrable AND tginitdeferred
        AND tgfoid='cinatoken_economic_outbox.verify_buyer_debit_v2()'::pg_catalog.regprocedure)
    OR pg_catalog.has_table_privilege(consumer_oid,
      'cinatoken_economic_outbox.shared_key_economic_events','SELECT')
    OR pg_catalog.has_table_privilege(consumer_oid,
      'cinatoken_economic_consumer.shared_key_attempt_consumptions','INSERT')
    OR NOT pg_catalog.has_function_privilege(consumer_oid,
      'cinatoken_economic_consumer.consume_shared_key_economic_event(text)','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_economic_consumer.consume_shared_key_economic_event(text)','EXECUTE')
  THEN
    RAISE EXCEPTION 'Version-aware seller consumer activation or dependency differs';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d,
      LATERAL pg_catalog.aclexplode(d.defaclacl) acl
    WHERE d.defaclrole=migrator_oid AND
      (d.defaclnamespace=0 OR d.defaclnamespace IN (
        'cinatoken_economic_consumer'::pg_catalog.regnamespace,
        'cinatoken_economic_outbox'::pg_catalog.regnamespace))
      AND d.defaclobjtype IN ('f','r') AND acl.grantee<>migrator_oid)
  THEN
    RAISE EXCEPTION 'Version-aware seller consumer default ACL differs';
  END IF;
END;
$preflight$;

-- Keep the old reviewed body unchanged. It is callable only by the new
-- version-aware SECURITY DEFINER wrapper; no runtime role receives EXECUTE.
ALTER FUNCTION cinatoken_economic_consumer.consume_shared_key_economic_event(text)
  RENAME TO consume_shared_key_economic_event_v1_core;
REVOKE ALL ON FUNCTION
  cinatoken_economic_consumer.consume_shared_key_economic_event_v1_core(text)
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_shared_earning_consumer;
DROP TRIGGER shared_key_attempt_consumptions_v1_only
  ON cinatoken_economic_consumer.shared_key_attempt_consumptions;
DROP FUNCTION cinatoken_economic_consumer.reject_v2_event_from_v1_consumer();

CREATE FUNCTION cinatoken_economic_consumer.consume_shared_key_economic_event(
  p_event_id text)
RETURNS TABLE(out_event_id text,out_decision text,out_credited_attempts integer,
  out_pending_attempts integer,out_net_micros bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $consume_v2$
DECLARE e cinatoken_economic_outbox.shared_key_economic_events%ROWTYPE;
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>'cinatoken_gateway_shared_earning_consumer'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_event_id IS NULL OR pg_catalog.length(p_event_id)<1 THEN
    RAISE EXCEPTION 'Version-aware seller consumer identity or isolation differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_consumer_v2_protocol';
  END IF;
  -- The lock is held through the core's decision and account transaction.
  SELECT * INTO e FROM cinatoken_economic_outbox.shared_key_economic_events
    WHERE event_id=p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shared-key economic event is absent'
      USING ERRCODE='23503',CONSTRAINT='shared_key_consumer_event_absent';
  END IF;
  IF e.event_version=1 THEN
    IF e.buyer_debit_micros IS NOT NULL THEN
      RAISE EXCEPTION 'Version one event carries an ordinary buyer debit'
        USING ERRCODE='23514',CONSTRAINT='shared_key_consumer_v2_version_debit';
    END IF;
  ELSIF e.event_version=2 THEN
    IF e.buyer_debit_micros IS NULL
      OR e.buyer_debit_micros NOT BETWEEN 0 AND 9007199254740991
      OR (e.buyer_charge_basis='actual' AND
        (e.buyer_usage_certainty<>'actual'
          OR e.buyer_debit_micros::numeric IS DISTINCT FROM
            e.buyer_charged_cost*1000000::numeric)) THEN
      RAISE EXCEPTION 'Version two ordinary buyer debit is not settled actual'
        USING ERRCODE='23514',CONSTRAINT='shared_key_consumer_v2_version_debit';
    END IF;
    -- The v340 core credits only actual/actual buyer facts. A reserved or
    -- no-charge v2 event receives per-attempt pending_manual decisions.
  ELSE
    RAISE EXCEPTION 'Unsupported shared-key economic event version'
      USING ERRCODE='23514',CONSTRAINT='shared_key_consumer_v2_version';
  END IF;
  RETURN QUERY SELECT * FROM
    cinatoken_economic_consumer.consume_shared_key_economic_event_v1_core(p_event_id);
END;
$consume_v2$;
REVOKE ALL ON FUNCTION
  cinatoken_economic_consumer.consume_shared_key_economic_event(text)
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_shared_earning_consumer;
GRANT EXECUTE ON FUNCTION
  cinatoken_economic_consumer.consume_shared_key_economic_event(text)
  TO cinatoken_gateway_shared_earning_consumer;

DO $postflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE consumer_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO consumer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_earning_consumer';
  IF pg_catalog.to_regprocedure(
      'cinatoken_economic_consumer.reject_v2_event_from_v1_consumer()') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_economic_consumer.shared_key_attempt_consumptions'::pg_catalog.regclass
        AND tgname='shared_key_attempt_consumptions_v1_only')
    OR (SELECT count(*) FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE p.oid IN (
        'cinatoken_economic_consumer.consume_shared_key_economic_event(text)'::pg_catalog.regprocedure,
        'cinatoken_economic_consumer.consume_shared_key_economic_event_v1_core(text)'::pg_catalog.regprocedure)
        AND p.proowner=migrator_oid AND l.lanname='plpgsql'
        AND p.provolatile='v' AND p.prosecdef
        AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[])<>2
    OR pg_catalog.md5(pg_catalog.replace((SELECT p.prosrc FROM pg_catalog.pg_proc p
        WHERE p.oid='cinatoken_economic_consumer.consume_shared_key_economic_event_v1_core(text)'::pg_catalog.regprocedure),
        pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
      <>'1f80bb19a381a30bcdceffcc74d9f982'
    OR pg_catalog.has_function_privilege(consumer_oid,
      'cinatoken_economic_consumer.consume_shared_key_economic_event_v1_core(text)','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_economic_consumer.consume_shared_key_economic_event_v1_core(text)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege(consumer_oid,
      'cinatoken_economic_consumer.consume_shared_key_economic_event(text)','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_economic_consumer.consume_shared_key_economic_event(text)','EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
        LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
          pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.pronamespace='cinatoken_economic_consumer'::pg_catalog.regnamespace
        AND (p.proowner<>migrator_oid
          OR acl.grantee NOT IN (migrator_oid,consumer_oid)
          OR (acl.grantee=consumer_oid AND
            (p.oid<>'cinatoken_economic_consumer.consume_shared_key_economic_event(text)'::pg_catalog.regprocedure
              OR acl.privilege_type<>'EXECUTE' OR acl.is_grantable))))
  THEN
    RAISE EXCEPTION 'Version-aware seller consumer ACL or catalog differs';
  END IF;
END;
$postflight$;
