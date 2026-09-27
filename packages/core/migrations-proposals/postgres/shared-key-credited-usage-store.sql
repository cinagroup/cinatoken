-- REVIEW ONLY. C04.7 canonical credited-usage contribution store.
-- Apply after exact formal PG73, v338 quote, v339 dispatch/outbox, v340 seller
-- consumer, and shared-key-earnings-history-guard.sql as the direct migrator
-- LOGIN in one transaction with:
--   SET LOCAL cinatoken.shared_key_credited_usage_store_activation = 'reviewed-v1';
-- This proposal supplies no worker, application reader switch, or production
-- grant. Trigger installation commits before bounded historical backfill starts.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.shared_key_earnings,
  cinatoken_economic_consumer.shared_key_attempt_consumptions
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE owner_oid oid;
DECLARE runtime_oid oid;
DECLARE consumer_oid oid;
BEGIN
  SELECT oid INTO owner_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO consumer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_earning_consumer';
  IF pg_catalog.current_setting('cinatoken.shared_key_credited_usage_store_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR owner_oid IS NULL OR runtime_oid IS NULL OR consumer_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR pg_catalog.to_regnamespace('cinatoken_shared_stats') IS NOT NULL
    OR pg_catalog.pg_has_role(runtime_oid,owner_oid,'MEMBER')
    OR pg_catalog.pg_has_role(consumer_oid,owner_oid,'MEMBER')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d,
        LATERAL pg_catalog.aclexplode(d.defaclacl) acl
      WHERE d.defaclrole=owner_oid AND d.defaclobjtype IN ('n','f','r')
        AND acl.grantee<>owner_oid AND acl.is_grantable)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN (
      'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass,
      'cinatoken_economic_consumer.shared_key_attempt_consumptions'::pg_catalog.regclass)
      AND (c.relowner<>owner_oid OR c.relkind<>'r'
        OR c.relrowsecurity OR c.relforcerowsecurity))
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE
      tgrelid='cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
      AND tgname='shared_key_earnings_credit_after_insert' AND tgenabled='O'
      AND tgfoid='cinatoken_gateway.shared_key_earnings_credit_after_insert_fn()'::pg_catalog.regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE
      tgrelid='cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
      AND tgname='shared_key_earnings_history_immutable' AND tgenabled='O'
      AND tgfoid='cinatoken_gateway.reject_shared_key_earnings_history_mutation()'::pg_catalog.regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE
      tgrelid='cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
      AND tgname='shared_key_earnings_history_no_truncate' AND tgenabled='O')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE
      tgrelid='cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
      AND tgname='shared_key_earnings_reject_economic_event' AND tgenabled='O')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE
      tgrelid='cinatoken_economic_consumer.shared_key_attempt_consumptions'::pg_catalog.regclass
      AND tgname='shared_key_attempt_consumptions_no_change' AND tgenabled='O'
      AND tgfoid='cinatoken_economic_consumer.reject_consumption_mutation()'::pg_catalog.regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE
      tgrelid='cinatoken_economic_consumer.shared_key_attempt_consumptions'::pg_catalog.regclass
      AND tgname='shared_key_attempt_consumptions_no_truncate' AND tgenabled='O')
  THEN
    RAISE EXCEPTION 'Credited-usage store activation, source, or guard differs';
  END IF;
END;
$preflight$;

CREATE SCHEMA cinatoken_shared_stats AUTHORIZATION cinatoken_gateway_migrator;
REVOKE ALL ON SCHEMA cinatoken_shared_stats FROM PUBLIC,
  cinatoken_gateway_runtime,cinatoken_gateway_shared_earning_consumer;

-- One request may have many economic attempts, but cannot be both legacy and
-- economic. The enrollment row makes the exclusion concurrency-safe.
CREATE TABLE cinatoken_shared_stats.request_sources (
  request_log_id text PRIMARY KEY REFERENCES cinatoken_gateway.api_key_request_logs(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_kind text NOT NULL CHECK (source_kind IN ('legacy','economic_attempt'))
);
CREATE TABLE cinatoken_shared_stats.contributions (
  source_kind text NOT NULL CHECK (source_kind IN ('legacy','economic_attempt')),
  source_id text NOT NULL,
  request_log_id text NOT NULL REFERENCES cinatoken_shared_stats.request_sources(request_log_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  event_id text,
  shared_key_id text NOT NULL REFERENCES cinatoken_gateway.shared_keys(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  seller_user_id text NOT NULL REFERENCES cinatoken_gateway.users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  input_tokens numeric(38,0) NOT NULL CHECK (input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens numeric(38,0) NOT NULL CHECK (output_tokens BETWEEN 0 AND 9007199254740991),
  net_micros numeric(38,0) NOT NULL CHECK (net_micros BETWEEN 0 AND 9007199254740991),
  credited_at timestamptz NOT NULL,
  PRIMARY KEY (source_kind,source_id),
  CHECK ((source_kind='legacy' AND event_id IS NULL)
    OR (source_kind='economic_attempt' AND event_id IS NOT NULL))
);
CREATE INDEX contributions_by_seller_key_time
  ON cinatoken_shared_stats.contributions(seller_user_id,shared_key_id,credited_at);
CREATE TABLE cinatoken_shared_stats.summaries (
  shared_key_id text NOT NULL REFERENCES cinatoken_gateway.shared_keys(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  seller_user_id text NOT NULL REFERENCES cinatoken_gateway.users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  credited_rows numeric(38,0) NOT NULL CHECK (credited_rows BETWEEN 0 AND 9007199254740991),
  input_tokens numeric(38,0) NOT NULL CHECK (input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens numeric(38,0) NOT NULL CHECK (output_tokens BETWEEN 0 AND 9007199254740991),
  net_micros numeric(38,0) NOT NULL CHECK (net_micros BETWEEN 0 AND 9007199254740991),
  last_credited_at timestamptz NOT NULL,
  PRIMARY KEY (shared_key_id,seller_user_id)
);
CREATE INDEX summaries_by_seller ON cinatoken_shared_stats.summaries(seller_user_id,shared_key_id);
CREATE TABLE cinatoken_shared_stats.backfill_cursors (
  source_kind text PRIMARY KEY CHECK (source_kind IN ('legacy','economic_attempt')),
  last_legacy_id text,
  last_attempt_id uuid,
  complete boolean NOT NULL DEFAULT false,
  CHECK ((source_kind='legacy' AND last_attempt_id IS NULL)
    OR (source_kind='economic_attempt' AND last_legacy_id IS NULL))
);
INSERT INTO cinatoken_shared_stats.backfill_cursors(source_kind)
  VALUES ('legacy'),('economic_attempt');

CREATE FUNCTION cinatoken_shared_stats.reject_mutation()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $reject$
BEGIN
  RAISE EXCEPTION 'Credited-usage source identity and contribution are append-only'
    USING ERRCODE='23514',CONSTRAINT='shared_key_stats_append_only';
END;
$reject$;
CREATE TRIGGER request_sources_no_change BEFORE UPDATE OR DELETE
  ON cinatoken_shared_stats.request_sources FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_shared_stats.reject_mutation();
CREATE TRIGGER request_sources_no_truncate BEFORE TRUNCATE
  ON cinatoken_shared_stats.request_sources FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_shared_stats.reject_mutation();
CREATE TRIGGER contributions_no_change BEFORE UPDATE OR DELETE
  ON cinatoken_shared_stats.contributions FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_shared_stats.reject_mutation();
CREATE TRIGGER contributions_no_truncate BEFORE TRUNCATE
  ON cinatoken_shared_stats.contributions FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_shared_stats.reject_mutation();

-- Only source triggers or the migrator backfill call this private function.
-- Its return value is true exactly once per immutable source identity.
CREATE FUNCTION cinatoken_shared_stats.append_contribution(
  p_kind text,p_source_id text,p_request_log_id text,p_event_id text,
  p_shared_key_id text,p_seller_user_id text,p_input numeric,p_output numeric,
  p_net_micros numeric,p_credited_at timestamptz)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $append$
DECLARE enrolled text;
DECLARE inserted integer;
DECLARE existing cinatoken_shared_stats.contributions%ROWTYPE;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('legacy','economic_attempt')
    OR p_source_id IS NULL
    OR p_request_log_id IS NULL OR p_shared_key_id IS NULL
    OR p_seller_user_id IS NULL OR p_input IS NULL OR p_output IS NULL
    OR p_net_micros IS NULL OR p_credited_at IS NULL
    OR (p_kind='legacy') IS DISTINCT FROM (p_event_id IS NULL) THEN
    RAISE EXCEPTION 'Credited-usage source facts are invalid'
      USING ERRCODE='23514',CONSTRAINT='shared_key_stats_source_invalid';
  END IF;
  INSERT INTO cinatoken_shared_stats.request_sources(request_log_id,source_kind)
    VALUES (p_request_log_id,p_kind)
    ON CONFLICT (request_log_id) DO NOTHING;
  SELECT source_kind INTO enrolled FROM cinatoken_shared_stats.request_sources
    WHERE request_log_id=p_request_log_id FOR KEY SHARE;
  IF enrolled IS DISTINCT FROM p_kind THEN
    RAISE EXCEPTION 'Legacy and economic credit share a request log'
      USING ERRCODE='23514',CONSTRAINT='shared_key_stats_cross_source_conflict';
  END IF;
  INSERT INTO cinatoken_shared_stats.contributions
    (source_kind,source_id,request_log_id,event_id,shared_key_id,seller_user_id,
      input_tokens,output_tokens,net_micros,credited_at)
    VALUES (p_kind,p_source_id,p_request_log_id,p_event_id,p_shared_key_id,
      p_seller_user_id,p_input,p_output,p_net_micros,p_credited_at)
    ON CONFLICT (source_kind,source_id) DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  IF inserted=0 THEN
    SELECT * INTO existing FROM cinatoken_shared_stats.contributions
      WHERE source_kind=p_kind AND source_id=p_source_id;
    IF NOT FOUND OR existing.request_log_id IS DISTINCT FROM p_request_log_id
      OR existing.event_id IS DISTINCT FROM p_event_id
      OR existing.shared_key_id IS DISTINCT FROM p_shared_key_id
      OR existing.seller_user_id IS DISTINCT FROM p_seller_user_id
      OR existing.input_tokens IS DISTINCT FROM p_input
      OR existing.output_tokens IS DISTINCT FROM p_output
      OR existing.net_micros IS DISTINCT FROM p_net_micros
      OR existing.credited_at IS DISTINCT FROM p_credited_at THEN
      RAISE EXCEPTION 'Credited-usage source replay differs'
        USING ERRCODE='23514',CONSTRAINT='shared_key_stats_replay_conflict';
    END IF;
    RETURN false;
  END IF;
  INSERT INTO cinatoken_shared_stats.summaries
    (shared_key_id,seller_user_id,credited_rows,input_tokens,output_tokens,
      net_micros,last_credited_at)
    VALUES (p_shared_key_id,p_seller_user_id,1,p_input,p_output,p_net_micros,
      p_credited_at)
    ON CONFLICT (shared_key_id,seller_user_id) DO UPDATE SET
      credited_rows=cinatoken_shared_stats.summaries.credited_rows+1,
      input_tokens=cinatoken_shared_stats.summaries.input_tokens+EXCLUDED.input_tokens,
      output_tokens=cinatoken_shared_stats.summaries.output_tokens+EXCLUDED.output_tokens,
      net_micros=cinatoken_shared_stats.summaries.net_micros+EXCLUDED.net_micros,
      last_credited_at=greatest(
        cinatoken_shared_stats.summaries.last_credited_at,EXCLUDED.last_credited_at);
  RETURN true;
END;
$append$;

CREATE FUNCTION cinatoken_shared_stats.capture_legacy_credit()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $capture$
BEGIN
  IF TG_RELID<>'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
    OR TG_NAME<>'shared_key_earnings_capture_credited_usage'
    OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Legacy credited-usage trigger binding differs';
  END IF;
  PERFORM cinatoken_shared_stats.append_contribution('legacy',NEW.id,
    NEW.request_log_id,NULL,NEW.shared_key_id,NEW.seller_user_id,
    NEW.input_tokens::numeric,NEW.output_tokens::numeric,
    NEW.net_amount*1000000::numeric,NEW.created_at);
  RETURN NEW;
END;
$capture$;
CREATE TRIGGER shared_key_earnings_capture_credited_usage
  AFTER INSERT ON cinatoken_gateway.shared_key_earnings FOR EACH ROW
  EXECUTE FUNCTION cinatoken_shared_stats.capture_legacy_credit();

CREATE FUNCTION cinatoken_shared_stats.capture_economic_credit()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $capture$
BEGIN
  IF TG_RELID<>'cinatoken_economic_consumer.shared_key_attempt_consumptions'::pg_catalog.regclass
    OR TG_NAME<>'shared_key_attempt_consumptions_capture_credited_usage'
    OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Economic credited-usage trigger binding differs';
  END IF;
  IF NEW.decision='credited' THEN
    PERFORM cinatoken_shared_stats.append_contribution('economic_attempt',
      NEW.attempt_id::text,NEW.request_log_id,NEW.event_id,NEW.shared_key_id,
      NEW.seller_user_id,NEW.input_tokens::numeric,NEW.output_tokens::numeric,
      NEW.net_micros::numeric,NEW.processed_at);
  END IF;
  RETURN NEW;
END;
$capture$;
CREATE TRIGGER shared_key_attempt_consumptions_capture_credited_usage
  AFTER INSERT ON cinatoken_economic_consumer.shared_key_attempt_consumptions
  FOR EACH ROW EXECUTE FUNCTION cinatoken_shared_stats.capture_economic_credit();

-- Cursor row locks serialize workers of the same source. The source INSERT
-- triggers already cover rows committed after activation, including IDs below
-- a cursor. Each page and summary increments commit or roll back together.
CREATE FUNCTION cinatoken_shared_stats.backfill_credited_usage(
  p_kind text,p_limit integer)
RETURNS TABLE(scanned integer,appended integer,complete boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $backfill$
DECLARE cursor_row cinatoken_shared_stats.backfill_cursors%ROWTYPE;
DECLARE r record;
DECLARE n integer:=0;
DECLARE added integer:=0;
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>'cinatoken_gateway_migrator'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR pg_catalog.current_setting('cinatoken.shared_key_stats_backfill_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR p_kind IS NULL OR p_kind NOT IN ('legacy','economic_attempt')
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Credited-usage backfill protocol differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_stats_backfill_protocol';
  END IF;
  SELECT * INTO cursor_row FROM cinatoken_shared_stats.backfill_cursors
    WHERE source_kind=p_kind FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credited-usage cursor absent'; END IF;
  IF cursor_row.complete THEN
    RETURN QUERY SELECT 0,0,true; RETURN;
  END IF;
  IF p_kind='legacy' THEN
    FOR r IN SELECT * FROM cinatoken_gateway.shared_key_earnings
      WHERE cursor_row.last_legacy_id IS NULL OR id>cursor_row.last_legacy_id
      ORDER BY id LIMIT p_limit
    LOOP
      n:=n+1;
      IF cinatoken_shared_stats.append_contribution('legacy',r.id,
        r.request_log_id,NULL,r.shared_key_id,r.seller_user_id,
        r.input_tokens::numeric,r.output_tokens::numeric,
        r.net_amount*1000000::numeric,r.created_at) THEN added:=added+1; END IF;
      cursor_row.last_legacy_id:=r.id;
    END LOOP;
  ELSE
    FOR r IN SELECT * FROM cinatoken_economic_consumer.shared_key_attempt_consumptions
      WHERE decision='credited' AND (cursor_row.last_attempt_id IS NULL
        OR attempt_id>cursor_row.last_attempt_id)
      ORDER BY attempt_id LIMIT p_limit
    LOOP
      n:=n+1;
      IF cinatoken_shared_stats.append_contribution('economic_attempt',
        r.attempt_id::text,r.request_log_id,r.event_id,r.shared_key_id,
        r.seller_user_id,r.input_tokens::numeric,r.output_tokens::numeric,
        r.net_micros::numeric,r.processed_at) THEN added:=added+1; END IF;
      cursor_row.last_attempt_id:=r.attempt_id;
    END LOOP;
  END IF;
  UPDATE cinatoken_shared_stats.backfill_cursors SET
    last_legacy_id=cursor_row.last_legacy_id,
    last_attempt_id=cursor_row.last_attempt_id,
    complete=(n<p_limit)
    WHERE source_kind=p_kind;
  RETURN QUERY SELECT n,added,(n<p_limit); RETURN;
END;
$backfill$;

REVOKE ALL ON ALL TABLES IN SCHEMA cinatoken_shared_stats
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_shared_earning_consumer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cinatoken_shared_stats
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_shared_earning_consumer;

DO $postflight$
DECLARE owner_oid oid;
DECLARE runtime_oid oid;
DECLARE consumer_oid oid;
BEGIN
  SELECT oid INTO owner_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO consumer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_earning_consumer';
  IF pg_catalog.has_schema_privilege(runtime_oid,'cinatoken_shared_stats','USAGE')
    OR pg_catalog.has_schema_privilege(consumer_oid,'cinatoken_shared_stats','USAGE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n,
        LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,
          pg_catalog.acldefault('n',n.nspowner))) acl
      WHERE n.oid='cinatoken_shared_stats'::pg_catalog.regnamespace
        AND (n.nspowner<>owner_oid OR acl.grantee<>owner_oid))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
        LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
          pg_catalog.acldefault('r',c.relowner))) acl
      WHERE c.relnamespace='cinatoken_shared_stats'::pg_catalog.regnamespace
        AND c.relkind IN ('r','p','v','m','f')
        AND (c.relowner<>owner_oid OR acl.grantee<>owner_oid))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
        LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
          pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.pronamespace='cinatoken_shared_stats'::pg_catalog.regnamespace
        AND (p.proowner<>owner_oid OR acl.grantee<>owner_oid)) THEN
    RAISE EXCEPTION 'Credited-usage store ACL exceeds owner-only contract';
  END IF;
END;
$postflight$;
