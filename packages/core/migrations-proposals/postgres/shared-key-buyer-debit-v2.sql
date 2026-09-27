-- REVIEW ONLY. Versioned buyer debit schema companion; no v2 runtime writer.
-- Apply after PG73 and the quote, dispatch, economic outbox, economic producer,
-- and snapshot earning consumer proposals, as the direct migrator LOGIN inside
-- one transaction with:
--   SET LOCAL cinatoken.shared_key_buyer_debit_v2_activation = 'reviewed-v1';
-- This does not grant any new runtime access or turn on production economics.
-- v1 keeps buyer_debit_micros NULL and its original contract. v2 carries an
-- ordinary-user debit separately from buyer_budget_charged_micros (Guardrail).
-- Until a version-aware seller consumer and adjustment protocol are reviewed,
-- the existing v1 consumer rejects every v2 event before any credit.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.user_budget_reservations,
  cinatoken_gateway.api_key_request_logs,
  cinatoken_economic_outbox.shared_key_economic_events,
  cinatoken_economic_consumer.shared_key_attempt_consumptions,
  cinatoken_economic_consumer.shared_key_event_consumptions
  IN SHARE ROW EXCLUSIVE MODE;
-- No-op tuple updates hold these function catalog rows through the activation
-- transaction, so a concurrent migrator replacement cannot race attestation.
ALTER FUNCTION cinatoken_economic_outbox.guard_event_insert() COST 100;
ALTER FUNCTION cinatoken_economic_outbox.verify_economic_event() COST 100;
ALTER FUNCTION cinatoken_economic_outbox.reject_economic_fact_mutation() COST 100;
ALTER FUNCTION cinatoken_economic_consumer.consume_shared_key_economic_event(text)
  COST 100;

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
  IF pg_catalog.current_setting('cinatoken.shared_key_buyer_debit_v2_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR migrator_oid IS NULL OR runtime_oid IS NULL OR consumer_oid IS NULL
    OR (SELECT count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE
      oid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
      AND relowner=migrator_oid AND relkind='r'
      AND NOT relrowsecurity AND NOT relforcerowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE
      oid='cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass
      AND relowner=migrator_oid AND relkind='r'
      AND NOT relrowsecurity AND NOT relforcerowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE
      oid='cinatoken_economic_consumer.shared_key_attempt_consumptions'::pg_catalog.regclass
      AND relowner=migrator_oid AND relkind='r'
      AND NOT relrowsecurity AND NOT relforcerowsecurity)
    OR pg_catalog.to_regprocedure(
      'cinatoken_economic_outbox.write_shared_key_economic_event(text,text,text,jsonb,text)')
      IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_economic_consumer.consume_shared_key_economic_event(text)')
      IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE p.oid='cinatoken_economic_consumer.consume_shared_key_economic_event(text)'
          ::pg_catalog.regprocedure
        AND p.proowner=migrator_oid AND l.lanname='plpgsql'
        AND p.provolatile='v' AND p.prosecdef
        AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND p.procost=100
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
          ='1f80bb19a381a30bcdceffcc74d9f982')
    OR (SELECT count(*) FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE p.oid IN (
        'cinatoken_economic_outbox.guard_event_insert()'::pg_catalog.regprocedure,
        'cinatoken_economic_outbox.verify_economic_event()'::pg_catalog.regprocedure,
        'cinatoken_economic_outbox.reject_economic_fact_mutation()'::pg_catalog.regprocedure)
        AND p.proowner=migrator_oid AND l.lanname='plpgsql'
        AND p.provolatile='v' AND p.prosecdef
        AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND p.procost=100
        AND pg_catalog.md5(p.prosrc)=CASE p.proname
          WHEN 'guard_event_insert' THEN 'ac9a1207b45df0e38a5b3c0dce0eca77'
          WHEN 'verify_economic_event' THEN '6f9368aa5d93c4af204d9aad5dda3e77'
          WHEN 'reject_economic_fact_mutation' THEN 'fb4bf3ef2ba3a1a8adbe03877e299b33'
          ELSE '' END)<>3
    OR pg_catalog.to_regprocedure(
      'cinatoken_economic_outbox.verify_buyer_debit_v2()') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_economic_outbox.capture_v2_reservation_settlement()') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_economic_outbox.guard_v2_reservation_mutation()') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_economic_consumer.reject_v2_event_from_v1_consumer()') IS NOT NULL
    OR pg_catalog.to_regclass(
      'cinatoken_economic_outbox.shared_key_buyer_settlement_tx_markers') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE
      attrelid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
      AND attname='buyer_debit_micros' AND NOT attisdropped)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE
      conrelid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
      AND conname='shared_key_economic_events_event_version_check'
      AND contype='c' AND convalidated)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE
      tgrelid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
      AND tgname='shared_key_economic_events_verify' AND tgenabled='O'
      AND tgfoid='cinatoken_economic_outbox.verify_economic_event()'::pg_catalog.regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE
      tgrelid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
      AND tgname='shared_key_economic_events_no_change' AND tgenabled='O'
      AND tgfoid='cinatoken_economic_outbox.reject_economic_fact_mutation()'::pg_catalog.regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE
      tgrelid='cinatoken_economic_consumer.shared_key_attempt_consumptions'::pg_catalog.regclass
      AND tgname='shared_key_attempt_consumptions_no_change' AND tgenabled='O'
      AND tgfoid='cinatoken_economic_consumer.reject_consumption_mutation()'::pg_catalog.regprocedure)
    OR EXISTS (SELECT 1 FROM cinatoken_economic_outbox.shared_key_economic_events
      WHERE event_version<>1)
  THEN
    RAISE EXCEPTION 'Buyer debit v2 activation or dependency differs';
  END IF;
END;
$preflight$;

ALTER TABLE cinatoken_economic_outbox.shared_key_economic_events
  DROP CONSTRAINT shared_key_economic_events_event_version_check;
ALTER TABLE cinatoken_economic_outbox.shared_key_economic_events
  ADD COLUMN buyer_debit_micros bigint;
ALTER TABLE cinatoken_economic_outbox.shared_key_economic_events
  ADD CONSTRAINT shared_key_economic_event_version_debit CHECK (
    (event_version=1 AND buyer_debit_micros IS NULL)
    OR (event_version=2 AND buyer_debit_micros IS NOT NULL
      AND buyer_debit_micros BETWEEN 0 AND 9007199254740991));

-- A terminal ordinary reservation can predate the buyer log after a timeout.
-- The v2 event may only attribute that debit to its log if the terminal
-- reservation transition is in the SAME transaction. The marker is private;
-- the runtime cannot forge it or update it outside the trigger.
CREATE TABLE cinatoken_economic_outbox.shared_key_buyer_settlement_tx_markers (
  request_id text PRIMARY KEY REFERENCES cinatoken_gateway.user_budget_reservations(request_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  settlement_xact_id xid8 NOT NULL,
  settled_micros bigint NOT NULL CHECK (settled_micros BETWEEN 0 AND 9007199254740991),
  state text NOT NULL CHECK (state IN ('settled','expired'))
);
CREATE FUNCTION cinatoken_economic_outbox.capture_v2_reservation_settlement()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $capture$
BEGIN
  IF TG_RELID<>'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass
    OR TG_NAME<>'user_budget_reservations_capture_v2_settlement'
    OR TG_LEVEL<>'ROW' OR TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'Buyer settlement marker trigger binding differs';
  END IF;
  IF OLD.state NOT IN ('reserved','dispatched')
    OR NEW.state NOT IN ('settled','expired')
    OR OLD.settled_micros<>0 THEN RETURN NULL; END IF;
  -- Limit durable markers to requests enrolled by a pre-egress quote claim.
  IF NOT EXISTS (SELECT 1 FROM
    cinatoken_economic_quotes.shared_key_dispatch_quote_attempts
    WHERE request_log_id=NEW.request_id) THEN RETURN NULL; END IF;
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'Buyer settlement marker requires READ COMMITTED'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_isolation';
  END IF;
  INSERT INTO cinatoken_economic_outbox.shared_key_buyer_settlement_tx_markers
    (request_id,settlement_xact_id,settled_micros,state)
    VALUES (NEW.request_id,pg_catalog.pg_current_xact_id(),
      NEW.settled_micros,NEW.state)
    ON CONFLICT (request_id) DO NOTHING;
  RETURN NULL;
END;
$capture$;
CREATE TRIGGER user_budget_reservations_capture_v2_settlement
  AFTER UPDATE ON cinatoken_gateway.user_budget_reservations
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_economic_outbox.capture_v2_reservation_settlement();

-- The v2 event records what the ordinary-user budget actually settled. Its
-- amount is not derived from the log's Guardrail charge. A reserved ceiling
-- must match the terminal reservation row and its buyer/key identity.
CREATE FUNCTION cinatoken_economic_outbox.verify_buyer_debit_v2()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $verify$
DECLARE r cinatoken_gateway.user_budget_reservations%ROWTYPE;
DECLARE marker cinatoken_economic_outbox.shared_key_buyer_settlement_tx_markers%ROWTYPE;
DECLARE reservation_found boolean;
BEGIN
  IF TG_RELID<>'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
    OR TG_NAME<>'shared_key_economic_events_verify_buyer_debit_v2'
    OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Buyer debit v2 verification binding differs';
  END IF;
  IF NEW.event_version=1 THEN RETURN NULL; END IF;
  IF NEW.event_version<>2
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'Buyer debit v2 requires version 2 and READ COMMITTED'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_protocol';
  END IF;
  SELECT * INTO r FROM cinatoken_gateway.user_budget_reservations
    WHERE request_id=NEW.request_log_id FOR UPDATE;
  reservation_found:=FOUND;
  IF reservation_found AND (r.user_id IS DISTINCT FROM NEW.buyer_user_id
    OR r.api_key_id IS DISTINCT FROM NEW.buyer_api_key_id) THEN
    RAISE EXCEPTION 'Buyer debit v2 reservation identity differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_identity';
  END IF;
  IF reservation_found THEN
    SELECT * INTO marker FROM
      cinatoken_economic_outbox.shared_key_buyer_settlement_tx_markers
      WHERE request_id=NEW.request_log_id;
    IF NOT FOUND OR marker.settlement_xact_id<>pg_catalog.pg_current_xact_id()
      OR marker.settled_micros IS DISTINCT FROM r.settled_micros
      OR marker.state IS DISTINCT FROM r.state THEN
      RAISE EXCEPTION 'Buyer debit v2 requires same-transaction reservation settlement'
        USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_same_tx';
    END IF;
  END IF;
  IF NEW.buyer_charge_basis='reserved' THEN
    IF NOT reservation_found OR r.state<>'expired' OR r.reserved_micros<>r.settled_micros
      OR r.settled_micros IS DISTINCT FROM NEW.buyer_debit_micros THEN
      RAISE EXCEPTION 'Reserved buyer debit must equal the expired ceiling settlement'
        USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_reserved';
    END IF;
  ELSIF NEW.buyer_charge_basis='actual' THEN
    IF NEW.buyer_usage_certainty<>'actual'
      OR NEW.buyer_debit_micros::numeric
        IS DISTINCT FROM NEW.buyer_charged_cost*1000000::numeric
      OR (reservation_found AND (r.state NOT IN ('settled','expired')
        OR r.settled_micros IS DISTINCT FROM NEW.buyer_debit_micros)) THEN
      RAISE EXCEPTION 'Actual buyer debit differs from settled amount'
        USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_actual';
    END IF;
  ELSIF NEW.buyer_charge_basis='none' THEN
    IF reservation_found OR NEW.buyer_debit_micros<>0
      OR NEW.buyer_charged_cost<>0 OR NEW.buyer_budget_charged_micros<>0 THEN
      RAISE EXCEPTION 'No-charge buyer debit must be zero without reservation'
        USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_none';
    END IF;
  ELSE
    RAISE EXCEPTION 'Buyer debit v2 basis differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_basis';
  END IF;
  RETURN NULL;
END;
$verify$;
CREATE CONSTRAINT TRIGGER shared_key_economic_events_verify_buyer_debit_v2
  AFTER INSERT ON cinatoken_economic_outbox.shared_key_economic_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION cinatoken_economic_outbox.verify_buyer_debit_v2();

-- A later actual reconciliation would otherwise rewrite the reservation's
-- settled amount while leaving an immutable reserved v2 debit behind. Block
-- settlement-changing updates for enrolled v2 requests pending an explicit
-- adjustment event. Other requests and timestamp-only updates remain allowed.
CREATE FUNCTION cinatoken_economic_outbox.guard_v2_reservation_mutation()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $guard$
BEGIN
  IF TG_RELID<>'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass
    OR TG_NAME<>'user_budget_reservations_guard_v2_economic_debit'
    OR TG_OP NOT IN ('INSERT','UPDATE') OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Buyer debit v2 reservation guard binding differs';
  END IF;
  IF TG_OP='INSERT' THEN
    IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
      RAISE EXCEPTION 'Reservation insertion requires READ COMMITTED'
        USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_isolation';
    END IF;
    IF EXISTS (SELECT 1 FROM cinatoken_economic_outbox.shared_key_economic_events
      WHERE request_log_id=NEW.request_id AND event_version=2) THEN
      RAISE EXCEPTION 'Buyer debit v2 prohibits a later reservation'
        USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_adjustment_required';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('settled','expired')
    AND NEW.state IN ('reserved','dispatched','released')
    AND EXISTS (SELECT 1 FROM
      cinatoken_economic_quotes.shared_key_dispatch_quote_attempts
      WHERE request_log_id=OLD.request_id) THEN
    RAISE EXCEPTION 'Terminal enrolled reservation cannot reopen'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_terminal';
  END IF;
  IF OLD.request_id IS DISTINCT FROM NEW.request_id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.api_key_id IS DISTINCT FROM NEW.api_key_id
    OR OLD.reserved_micros IS DISTINCT FROM NEW.reserved_micros
    OR OLD.settled_micros IS DISTINCT FROM NEW.settled_micros
    OR OLD.state IS DISTINCT FROM NEW.state THEN
    IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
      RAISE EXCEPTION 'Settlement-changing reservation update requires READ COMMITTED'
        USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_isolation';
    END IF;
    IF EXISTS (SELECT 1 FROM cinatoken_economic_outbox.shared_key_economic_events
      WHERE request_log_id=OLD.request_id AND event_version=2) THEN
      RAISE EXCEPTION 'Buyer debit v2 reservation requires an adjustment event'
        USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_adjustment_required';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER user_budget_reservations_guard_v2_economic_debit
  BEFORE INSERT OR UPDATE ON cinatoken_gateway.user_budget_reservations
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_economic_outbox.guard_v2_reservation_mutation();

-- The existing consumer can credit on an actual basis without inspecting
-- buyer_debit_micros. Fail before its first per-attempt balance/ledger write;
-- a later version-aware consumer must replace this gate in a reviewed change.
CREATE FUNCTION cinatoken_economic_consumer.reject_v2_event_from_v1_consumer()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $guard$
BEGIN
  IF TG_RELID<>'cinatoken_economic_consumer.shared_key_attempt_consumptions'::pg_catalog.regclass
    OR TG_NAME<>'shared_key_attempt_consumptions_v1_only'
    OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Buyer debit v2 consumer guard binding differs';
  END IF;
  IF EXISTS (SELECT 1 FROM cinatoken_economic_outbox.shared_key_economic_events
    WHERE event_id=NEW.event_id AND event_version<>1) THEN
    RAISE EXCEPTION 'v1 earning consumer cannot process v2 economic events'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_consumer_gate';
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER shared_key_attempt_consumptions_v1_only
  BEFORE INSERT ON cinatoken_economic_consumer.shared_key_attempt_consumptions
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_economic_consumer.reject_v2_event_from_v1_consumer();

REVOKE ALL ON FUNCTION cinatoken_economic_outbox.verify_buyer_debit_v2()
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_shared_earning_consumer;
REVOKE ALL ON FUNCTION cinatoken_economic_outbox.capture_v2_reservation_settlement()
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_shared_earning_consumer;
REVOKE ALL ON FUNCTION cinatoken_economic_outbox.guard_v2_reservation_mutation()
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_shared_earning_consumer;
REVOKE ALL ON FUNCTION cinatoken_economic_consumer.reject_v2_event_from_v1_consumer()
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_shared_earning_consumer;
REVOKE ALL ON TABLE cinatoken_economic_outbox.shared_key_buyer_settlement_tx_markers
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_shared_earning_consumer;

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
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
        pg_catalog.acldefault('f',p.proowner))) acl
    WHERE p.oid IN (
      'cinatoken_economic_outbox.verify_buyer_debit_v2()'::pg_catalog.regprocedure,
      'cinatoken_economic_outbox.capture_v2_reservation_settlement()'::pg_catalog.regprocedure,
      'cinatoken_economic_outbox.guard_v2_reservation_mutation()'::pg_catalog.regprocedure,
      'cinatoken_economic_consumer.reject_v2_event_from_v1_consumer()'::pg_catalog.regprocedure)
      AND (p.proowner<>migrator_oid OR acl.grantee<>migrator_oid))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE
      c.oid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
      AND (pg_catalog.has_table_privilege(runtime_oid,c.oid,'SELECT')
        OR pg_catalog.has_table_privilege(runtime_oid,c.oid,'INSERT')
        OR pg_catalog.has_table_privilege(consumer_oid,c.oid,'SELECT')
        OR pg_catalog.has_table_privilege(consumer_oid,c.oid,'INSERT')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
      LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
        pg_catalog.acldefault('r',c.relowner))) acl
      WHERE c.oid='cinatoken_economic_outbox.shared_key_buyer_settlement_tx_markers'::pg_catalog.regclass
        AND (c.relowner<>migrator_oid OR acl.grantee<>migrator_oid))
  THEN
    RAISE EXCEPTION 'Buyer debit v2 ACL exceeds reviewed contract';
  END IF;
END;
$postflight$;
