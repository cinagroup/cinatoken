-- REVIEW ONLY / DEFAULT OFF. Narrow database-log projection receipt for the
-- v372 non-grant buyer branch. It does not authenticate complete Provider wire
-- bytes or the caller-supplied v378 full_request_sha256.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
LOCK TABLE cinatoken_gateway.schema_migrations IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; journal_oid oid; buyer_oid oid; reader_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO journal_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_commit_journal';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  SELECT oid INTO reader_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_terminal_reader';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting('cinatoken.legacy_buyer_request_projection_v383_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR journal_oid IS NULL OR buyer_oid IS NULL
    OR reader_oid IS NULL
    OR pg_catalog.to_regnamespace('cinatoken_buyer_request_projection') IS NOT NULL
    OR pg_catalog.to_regclass('cinatoken_buyer_commit_journal.intents_v378') IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_buyer_terminal.read_windowed_v375(text,text,text,text,bigint,bigint,bigint,bigint,bigint,text,jsonb)') IS NULL
    OR pg_catalog.to_regclass(
      'cinatoken_economic_outbox.shared_key_economic_producer_tx_markers') IS NULL
    OR pg_catalog.to_regclass(
      'cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts') IS NULL
    OR pg_catalog.has_schema_privilege(journal_oid,'cinatoken_gateway','USAGE')
    OR pg_catalog.has_schema_privilege(reader_oid,'cinatoken_gateway','USAGE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid IN (journal_oid,reader_oid,buyer_oid)
        OR member IN (journal_oid,reader_oid,buyer_oid))
  THEN RAISE EXCEPTION 'buyer request projection v383 dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE SCHEMA cinatoken_buyer_request_projection
  AUTHORIZATION cinatoken_gateway_migrator;
REVOKE ALL ON SCHEMA cinatoken_buyer_request_projection FROM PUBLIC;

-- JSONB's PostgreSQL text form is canonical only for this DB protocol. It is
-- deliberately not the complete HTTP/Provider request digest.
CREATE FUNCTION cinatoken_buyer_request_projection.digest_v383(p jsonb)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER
SET search_path TO pg_catalog,pg_temp AS $digest$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p::text,'UTF8')),'hex')
$digest$;
REVOKE ALL ON FUNCTION cinatoken_buyer_request_projection.digest_v383(jsonb)
  FROM PUBLIC;

CREATE FUNCTION cinatoken_buyer_request_projection.log_projection_v383(
  l cinatoken_gateway.api_key_request_logs)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER
SET search_path TO pg_catalog,pg_temp AS $projection$
  SELECT pg_catalog.jsonb_build_object(
    'apiKeyId',l.api_key_id,'billingKind',l.billing_kind,
    'isByok',l.is_byok,'modelId',l.model_id,
    'providerId',l.provider_id,
    'providerKeyFingerprint',l.provider_key_fingerprint,
    'requestId',l.id,'requestOperation',l.request_operation,
    'requestProtocol',l.request_protocol,'routeGroup',l.route_group,
    'routePoolId',l.route_pool_id,'routeTargetId',l.route_target_id,
    'routeTrace',l.route_trace,'status',l.status,
    'upstreamOperation',l.upstream_operation,
    'upstreamProtocol',l.upstream_protocol,
    'upstreamRequestId',l.upstream_request_id,
    'userId',l.user_id,'workspaceId',l.workspace_id)
$projection$;
REVOKE ALL ON FUNCTION cinatoken_buyer_request_projection.log_projection_v383(
  cinatoken_gateway.api_key_request_logs) FROM PUBLIC;

CREATE TABLE cinatoken_buyer_request_projection.prewrites_v383 (
  intent_id uuid PRIMARY KEY REFERENCES
    cinatoken_buyer_commit_journal.intents_v378(intent_id),
  request_id text NOT NULL UNIQUE,
  expected_projection jsonb NOT NULL,
  projection_sha256 text NOT NULL CHECK
    (projection_sha256 COLLATE "C" ~ '^[0-9a-f]{64}$'),
  prepared_at timestamptz NOT NULL,
  prepared_backend_pid integer NOT NULL,
  verified_at timestamptz,
  verified_backend_pid integer,
  UNIQUE(intent_id,request_id),
  CHECK ((verified_at IS NULL)=(verified_backend_pid IS NULL))
);
REVOKE ALL ON TABLE cinatoken_buyer_request_projection.prewrites_v383 FROM PUBLIC;

CREATE TABLE cinatoken_buyer_request_projection.receipts_v383 (
  request_id text PRIMARY KEY REFERENCES cinatoken_gateway.api_key_request_logs(id),
  intent_id uuid NOT NULL UNIQUE,
  projection_sha256 text NOT NULL,
  xact_id xid8 NOT NULL,
  inserted_backend_pid integer NOT NULL,
  FOREIGN KEY (intent_id,request_id) REFERENCES
    cinatoken_buyer_request_projection.prewrites_v383(intent_id,request_id)
);
REVOKE ALL ON TABLE cinatoken_buyer_request_projection.receipts_v383 FROM PUBLIC;

CREATE FUNCTION cinatoken_buyer_request_projection.guard_prewrites_v383()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO pg_catalog,pg_temp AS $guard$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'v383 prewrite cannot be deleted'
    USING ERRCODE='23514'; END IF;
  IF ROW(NEW.intent_id,NEW.request_id,NEW.expected_projection,
      NEW.projection_sha256,NEW.prepared_at,NEW.prepared_backend_pid)
    IS DISTINCT FROM ROW(OLD.intent_id,OLD.request_id,OLD.expected_projection,
      OLD.projection_sha256,OLD.prepared_at,OLD.prepared_backend_pid)
    OR OLD.verified_at IS NOT NULL
    OR NEW.verified_at IS NULL OR NEW.verified_backend_pid IS NULL
  THEN RAISE EXCEPTION 'v383 prewrite identity is immutable'
    USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$guard$;
REVOKE ALL ON FUNCTION cinatoken_buyer_request_projection.guard_prewrites_v383()
  FROM PUBLIC;
CREATE TRIGGER guard_prewrites_v383 BEFORE UPDATE OR DELETE
  ON cinatoken_buyer_request_projection.prewrites_v383
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_buyer_request_projection.guard_prewrites_v383();

CREATE FUNCTION cinatoken_buyer_request_projection.guard_receipts_v383()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO pg_catalog,pg_temp AS $guard$
BEGIN
  RAISE EXCEPTION 'v383 receipt is immutable' USING ERRCODE='23514';
END;
$guard$;
REVOKE ALL ON FUNCTION cinatoken_buyer_request_projection.guard_receipts_v383()
  FROM PUBLIC;
CREATE TRIGGER guard_receipts_v383 BEFORE UPDATE OR DELETE
  ON cinatoken_buyer_request_projection.receipts_v383
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_buyer_request_projection.guard_receipts_v383();

-- v378 intent must already be visible from another backend. The request lock
-- makes a prior log insertion win over a late journal prewrite, and makes a
-- prior prewrite visible to a subsequent buyer INSERT trigger.
CREATE FUNCTION cinatoken_buyer_request_projection.prepare_v383(
  p_intent_id uuid,p_expected_projection jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $prepare$
DECLARE j record; digest text;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_buyer_commit_journal'
    OR p_intent_id IS NULL OR p_expected_projection IS NULL
    OR pg_catalog.jsonb_typeof(p_expected_projection)<>'object'
    OR pg_catalog.octet_length(p_expected_projection::text)>65536
    OR ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(p_expected_projection)
      AS x(k) ORDER BY k COLLATE "C") IS DISTINCT FROM ARRAY[
        'apiKeyId','billingKind','isByok','modelId','providerId',
        'providerKeyFingerprint','requestId','requestOperation',
        'requestProtocol','routeGroup','routePoolId','routeTargetId',
        'routeTrace','status','upstreamOperation','upstreamProtocol',
        'upstreamRequestId','userId','workspaceId']::text[]
    OR pg_catalog.jsonb_typeof(p_expected_projection->'requestId')<>'string'
    OR pg_catalog.jsonb_typeof(p_expected_projection->'userId')<>'string'
    OR pg_catalog.jsonb_typeof(p_expected_projection->'apiKeyId')<>'string'
    OR pg_catalog.jsonb_typeof(p_expected_projection->'workspaceId')<>'string'
    OR pg_catalog.jsonb_typeof(p_expected_projection->'routeGroup')<>'string'
    OR pg_catalog.jsonb_typeof(p_expected_projection->'status')<>'string'
    OR pg_catalog.jsonb_typeof(p_expected_projection->'upstreamProtocol')<>'string'
    OR pg_catalog.jsonb_typeof(p_expected_projection->'isByok')<>'boolean'
    OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_each(p_expected_projection)
      AS x(k,v) WHERE k NOT IN ('requestId','userId','apiKeyId',
        'workspaceId','routeGroup','status','upstreamProtocol','isByok')
        AND pg_catalog.jsonb_typeof(v) NOT IN ('string','null'))
  THEN RAISE EXCEPTION 'invalid v383 log projection'
    USING ERRCODE='23514',CONSTRAINT='buyer_log_projection_input_v383'; END IF;
  SELECT request_id INTO j
    FROM cinatoken_buyer_commit_journal.intents_v378
    WHERE intent_id=p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'v383 projection lacks a v378 intent'
      USING ERRCODE='23514',CONSTRAINT='buyer_projection_intent_v383';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(746923554,
    pg_catalog.hashtext(j.request_id));
  -- Re-read after any lock wait. A stale state or expired prepare must not
  -- become a newly authorized prewrite on the strength of an old snapshot.
  SELECT intent_id,request_id,expected_financial_facts,state,
      prepared_backend_pid,prepared_at INTO j
    FROM cinatoken_buyer_commit_journal.intents_v378
    WHERE intent_id=p_intent_id;
  IF NOT FOUND OR j.state IS DISTINCT FROM 'prepared'
    OR j.prepared_backend_pid=pg_catalog.pg_backend_pid()
    OR j.prepared_at+INTERVAL '30 seconds'<=pg_catalog.clock_timestamp()
    OR p_expected_projection->>'requestId' IS DISTINCT FROM j.request_id
    OR p_expected_projection->>'userId'
      IS DISTINCT FROM j.expected_financial_facts->>'userId'
    OR p_expected_projection->>'apiKeyId'
      IS DISTINCT FROM j.expected_financial_facts->>'apiKeyId'
    OR p_expected_projection->>'workspaceId'
      IS DISTINCT FROM j.expected_financial_facts->>'workspaceId'
    OR p_expected_projection->>'status' IS DISTINCT FROM 'success'
    OR p_expected_projection->'isByok' IS DISTINCT FROM 'false'::jsonb
  THEN RAISE EXCEPTION 'v383 projection lacks a live committed v378 intent'
    USING ERRCODE='23514',CONSTRAINT='buyer_projection_intent_v383'; END IF;
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.api_key_request_logs
      WHERE id=j.request_id) THEN
    RAISE EXCEPTION 'v383 projection cannot adopt an existing buyer log'
      USING ERRCODE='23514',CONSTRAINT='buyer_projection_late_v383';
  END IF;
  digest:=cinatoken_buyer_request_projection.digest_v383(p_expected_projection);
  INSERT INTO cinatoken_buyer_request_projection.prewrites_v383
    (intent_id,request_id,expected_projection,projection_sha256,
      prepared_at,prepared_backend_pid)
    VALUES(p_intent_id,j.request_id,p_expected_projection,digest,
      pg_catalog.clock_timestamp(),pg_catalog.pg_backend_pid());
  RETURN digest;
END;
$prepare$;
REVOKE ALL ON FUNCTION cinatoken_buyer_request_projection.prepare_v383(uuid,jsonb)
  FROM PUBLIC;
GRANT USAGE ON SCHEMA cinatoken_buyer_request_projection
  TO cinatoken_gateway_buyer_commit_journal;
GRANT EXECUTE ON FUNCTION cinatoken_buyer_request_projection.prepare_v383(uuid,jsonb)
  TO cinatoken_gateway_buyer_commit_journal;

CREATE FUNCTION cinatoken_buyer_request_projection.verify_v383(
  p_intent_id uuid,p_projection_sha256 text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $verify$
DECLARE p record;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_buyer_commit_journal'
    OR p_intent_id IS NULL OR p_projection_sha256 IS NULL THEN
    RAISE EXCEPTION 'invalid v383 verification' USING ERRCODE='23514'; END IF;
  -- Follow the same lock order as the buyer INSERT trigger: advisory request
  -- lock, then prewrite row lock. Taking FOR UPDATE first can deadlock a
  -- concurrent writer holding the advisory lock and waiting on FOR SHARE.
  SELECT request_id INTO p
    FROM cinatoken_buyer_request_projection.prewrites_v383
    WHERE intent_id=p_intent_id;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(746923554,
    pg_catalog.hashtext(p.request_id));
  SELECT intent_id,request_id,projection_sha256,prepared_backend_pid,
      prepared_at,verified_at INTO p
    FROM cinatoken_buyer_request_projection.prewrites_v383
    WHERE intent_id=p_intent_id FOR UPDATE;
  IF NOT FOUND OR p.projection_sha256 IS DISTINCT FROM p_projection_sha256
    OR p.prepared_backend_pid=pg_catalog.pg_backend_pid()
    OR p.verified_at IS NOT NULL
    OR p.prepared_at+INTERVAL '30 seconds'<=pg_catalog.clock_timestamp()
  THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM cinatoken_gateway.api_key_request_logs
      WHERE id=p.request_id) THEN RETURN false; END IF;
  UPDATE cinatoken_buyer_request_projection.prewrites_v383
    SET verified_at=pg_catalog.clock_timestamp(),
      verified_backend_pid=pg_catalog.pg_backend_pid()
    WHERE intent_id=p_intent_id;
  RETURN true;
END;
$verify$;
REVOKE ALL ON FUNCTION cinatoken_buyer_request_projection.verify_v383(uuid,text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cinatoken_buyer_request_projection.verify_v383(uuid,text)
  TO cinatoken_gateway_buyer_commit_journal;

-- The buyer LOGIN can only obtain this receipt by inserting the actual log.
-- Without a prior verified prewrite, A's callback cannot debit B: B's log
-- insertion raises and the v372 financial transaction rolls back.
CREATE FUNCTION cinatoken_buyer_request_projection.write_receipt_v383()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $write$
DECLARE p record; actual jsonb; checked_at timestamptz;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(746923554,
    pg_catalog.hashtext(NEW.id));
  SELECT w.intent_id,w.request_id,w.expected_projection,w.projection_sha256,
      w.verified_at,j.state AS journal_state,j.prepared_at AS journal_prepared_at,
      j.deadline_at INTO p
    FROM cinatoken_buyer_request_projection.prewrites_v383 w
    JOIN cinatoken_buyer_commit_journal.intents_v378 j
      ON j.intent_id=w.intent_id AND j.request_id=w.request_id
    WHERE w.request_id=NEW.id FOR SHARE OF w;
  IF SESSION_USER<>'cinatoken_gateway_buyer_settlement' THEN
    IF FOUND THEN RAISE EXCEPTION
      'non-buyer log cannot consume a verified v383 prewrite'
      USING ERRCODE='23514',CONSTRAINT='buyer_projection_wrong_writer_v383';
    END IF;
    RETURN NEW;
  END IF;
  checked_at:=pg_catalog.clock_timestamp();
  IF NOT FOUND OR p.verified_at IS NULL
    OR p.journal_state IS DISTINCT FROM 'prepared'
    OR checked_at>=p.verified_at+INTERVAL '30 seconds'
    OR checked_at>=p.journal_prepared_at+INTERVAL '30 seconds'
    OR checked_at>=p.deadline_at THEN
    RAISE EXCEPTION 'buyer log requires prior verified v383 prewrite'
      USING ERRCODE='23514',CONSTRAINT='buyer_projection_required_v383';
  END IF;
  actual:=cinatoken_buyer_request_projection.log_projection_v383(NEW);
  IF actual IS DISTINCT FROM p.expected_projection
    OR cinatoken_buyer_request_projection.digest_v383(actual)
      IS DISTINCT FROM p.projection_sha256 THEN
    RAISE EXCEPTION 'buyer log differs from prewritten v383 projection'
      USING ERRCODE='23514',CONSTRAINT='buyer_projection_mismatch_v383';
  END IF;
  INSERT INTO cinatoken_buyer_request_projection.receipts_v383
    (request_id,intent_id,projection_sha256,xact_id,inserted_backend_pid)
    VALUES(NEW.id,p.intent_id,p.projection_sha256,
      pg_catalog.pg_current_xact_id(),pg_catalog.pg_backend_pid());
  RETURN NEW;
END;
$write$;
REVOKE ALL ON FUNCTION cinatoken_buyer_request_projection.write_receipt_v383()
  FROM PUBLIC;
CREATE TRIGGER write_receipt_v383 AFTER INSERT
  ON cinatoken_gateway.api_key_request_logs
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_buyer_request_projection.write_receipt_v383();

-- Event and budget receipt are inserted after the request log in v372. A
-- deferred check prevents a stand-alone buyer log from manufacturing a
-- durable request-side receipt without matching financial xact markers.
CREATE FUNCTION cinatoken_buyer_request_projection.check_receipt_v383()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $check$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM cinatoken_buyer_commit_journal.intents_v378 j
      JOIN cinatoken_buyer_request_projection.prewrites_v383 p
        ON p.intent_id=j.intent_id AND p.request_id=j.request_id
      JOIN cinatoken_gateway.api_key_request_logs l
        ON l.id=p.request_id
      JOIN cinatoken_economic_outbox.shared_key_economic_producer_tx_markers m
        ON m.request_log_id=l.id AND m.log_xact_id=NEW.xact_id
      JOIN cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts b
        ON b.xact_id=NEW.xact_id AND b.user_id=l.user_id
      WHERE j.intent_id=NEW.intent_id AND p.request_id=NEW.request_id
        AND p.projection_sha256=NEW.projection_sha256
        AND cinatoken_buyer_request_projection.log_projection_v383(l)
          =p.expected_projection
        AND cinatoken_buyer_request_projection.digest_v383(p.expected_projection)
          =p.projection_sha256
  ) THEN RAISE EXCEPTION 'v383 request receipt lacks same-xact financial facts'
    USING ERRCODE='23514',CONSTRAINT='buyer_projection_financial_xact_v383';
  END IF;
  RETURN NULL;
END;
$check$;
REVOKE ALL ON FUNCTION cinatoken_buyer_request_projection.check_receipt_v383()
  FROM PUBLIC;
CREATE CONSTRAINT TRIGGER check_receipt_v383 AFTER INSERT
  ON cinatoken_buyer_request_projection.receipts_v383
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION
    cinatoken_buyer_request_projection.check_receipt_v383();

CREATE FUNCTION cinatoken_buyer_request_projection.read_v383(p_intent_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $read$
DECLARE r record; v375 text;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_buyer_terminal_reader'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_intent_id IS NULL THEN
    RAISE EXCEPTION 'invalid v383 reader' USING ERRCODE='23514'; END IF;
  SELECT j.request_id,j.expected_financial_facts,p.expected_projection,
      p.projection_sha256,p.verified_at,
      x.intent_id AS receipt_intent_id,x.projection_sha256 AS receipt_digest,
      x.xact_id AS receipt_xact_id,l.id AS log_id,
      cinatoken_buyer_request_projection.log_projection_v383(l)
        AS actual_projection,
      m.log_xact_id,b.xact_id AS budget_xact_id
    INTO r FROM cinatoken_buyer_commit_journal.intents_v378 j
    JOIN cinatoken_buyer_request_projection.prewrites_v383 p
      ON p.intent_id=j.intent_id AND p.request_id=j.request_id
    LEFT JOIN cinatoken_buyer_request_projection.receipts_v383 x
      ON x.request_id=p.request_id
    LEFT JOIN cinatoken_gateway.api_key_request_logs l
      ON l.id=p.request_id
    LEFT JOIN cinatoken_economic_outbox.shared_key_economic_producer_tx_markers m
      ON m.request_log_id=p.request_id
    LEFT JOIN cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts b
      ON b.xact_id=m.log_xact_id AND b.user_id=l.user_id
    WHERE j.intent_id=p_intent_id;
  IF NOT FOUND OR r.log_id IS NULL THEN RETURN 'unconfirmed'; END IF;
  IF r.receipt_intent_id IS DISTINCT FROM p_intent_id
    OR r.verified_at IS NULL
    OR r.receipt_digest IS DISTINCT FROM r.projection_sha256
    OR r.actual_projection IS DISTINCT FROM r.expected_projection
    OR cinatoken_buyer_request_projection.digest_v383(r.actual_projection)
      IS DISTINCT FROM r.projection_sha256
  THEN RETURN 'conflict'; END IF;
  IF r.receipt_xact_id IS NULL OR r.log_xact_id IS NULL
    OR r.budget_xact_id IS NULL THEN RETURN 'unconfirmed'; END IF;
  IF r.receipt_xact_id IS DISTINCT FROM r.log_xact_id
    OR r.receipt_xact_id IS DISTINCT FROM r.budget_xact_id
  THEN RETURN 'conflict'; END IF;
  SELECT cinatoken_buyer_terminal.read_windowed_v375(
    r.request_id,r.expected_financial_facts->>'userId',
    r.expected_financial_facts->>'apiKeyId',
    r.expected_financial_facts->>'workspaceId',
    (r.expected_financial_facts->>'chargeMicros')::bigint,
    (r.expected_financial_facts->>'inputTokens')::bigint,
    (r.expected_financial_facts->>'outputTokens')::bigint,
    (r.expected_financial_facts->>'cacheReadTokens')::bigint,
    (r.expected_financial_facts->>'cacheWriteTokens')::bigint,
    r.expected_financial_facts->>'reason',
    r.expected_financial_facts->'outcomes') INTO v375;
  IF v375='confirmed' THEN RETURN 'db_log_projection_confirmed'; END IF;
  RETURN v375;
END;
$read$;
REVOKE ALL ON FUNCTION cinatoken_buyer_request_projection.read_v383(uuid)
  FROM PUBLIC;
GRANT USAGE ON SCHEMA cinatoken_buyer_request_projection
  TO cinatoken_gateway_buyer_terminal_reader;
GRANT EXECUTE ON FUNCTION cinatoken_buyer_request_projection.read_v383(uuid)
  TO cinatoken_gateway_buyer_terminal_reader;
