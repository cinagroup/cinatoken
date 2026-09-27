-- REVIEW ONLY / DEFAULT OFF. Install after v375 with a separately provisioned
-- cinatoken_gateway_buyer_commit_journal NOINHERIT LOGIN. This is a durable
-- uncertainty record, not authorization to retry a buyer financial write.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
LOCK TABLE cinatoken_gateway.schema_migrations IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; journal_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO journal_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_commit_journal';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting('cinatoken.legacy_buyer_commit_journal_v378_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR journal_oid IS NULL
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
        AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
        AND NOT rolinherit FROM pg_catalog.pg_roles WHERE oid=journal_oid)
      IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
        WHERE roleid=journal_oid OR member=journal_oid)
    OR pg_catalog.to_regprocedure(
      'cinatoken_buyer_terminal.read_windowed_v375(text,text,text,text,bigint,bigint,bigint,bigint,bigint,text,jsonb)') IS NULL
    OR pg_catalog.to_regnamespace('cinatoken_buyer_commit_journal') IS NOT NULL
    OR pg_catalog.has_schema_privilege(journal_oid,'cinatoken_gateway','USAGE')
    OR pg_catalog.has_schema_privilege(journal_oid,'cinatoken_economic_outbox','USAGE')
  THEN RAISE EXCEPTION 'buyer commit journal v378 dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE SCHEMA cinatoken_buyer_commit_journal
  AUTHORIZATION cinatoken_gateway_migrator;
REVOKE ALL ON SCHEMA cinatoken_buyer_commit_journal FROM PUBLIC;

CREATE TABLE cinatoken_buyer_commit_journal.intents_v378 (
  intent_id uuid PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  -- Caller supplied. Neither this table nor v375 verifies the complete
  -- Provider request/response bytes against the committed buyer transaction.
  full_request_sha256 text NOT NULL
    CHECK (full_request_sha256 COLLATE "C" ~ '^[0-9a-f]{64}$'),
  expected_financial_facts jsonb NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  prepared_backend_pid integer NOT NULL,
  deadline_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN
    ('prepared','pending','leased','financial_facts_confirmed','quarantined')),
  first_uncertain_at timestamptz,
  next_probe_at timestamptz,
  -- Claims bound actual fresh-reader opportunities, including crashed leases.
  claim_count integer NOT NULL DEFAULT 0 CHECK (claim_count BETWEEN 0 AND 7),
  probe_count integer NOT NULL DEFAULT 0 CHECK (probe_count BETWEEN 0 AND 7),
  lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation>=0),
  lease_token uuid,
  lease_until timestamptz,
  write_ack_at timestamptz,
  last_observation text CHECK (last_observation IN
    ('confirmed','unconfirmed','conflict','reader_error')),
  last_error_class text CHECK (pg_catalog.length(last_error_class) BETWEEN 1 AND 64),
  quarantined_at timestamptz,
  quarantine_reason text CHECK (quarantine_reason IN
    ('conflict','probe_exhausted','deadline')),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK ((state='leased')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((state='quarantined')=(quarantined_at IS NOT NULL)),
  CHECK (probe_count<=claim_count),
  CHECK (deadline_at>prepared_at)
);
REVOKE ALL ON TABLE cinatoken_buyer_commit_journal.intents_v378 FROM PUBLIC;
CREATE INDEX intents_v378_due_idx ON cinatoken_buyer_commit_journal.intents_v378
  (next_probe_at,prepared_at) WHERE state IN ('prepared','pending','leased');

CREATE TABLE cinatoken_buyer_commit_journal.probes_v378 (
  intent_id uuid NOT NULL REFERENCES cinatoken_buyer_commit_journal.intents_v378(intent_id),
  probe_number integer NOT NULL CHECK (probe_number BETWEEN 1 AND 7),
  lease_generation bigint NOT NULL,
  observed_at timestamptz NOT NULL,
  observation text NOT NULL CHECK (observation IN
    ('confirmed','unconfirmed','conflict','reader_error')),
  error_class text CHECK (pg_catalog.length(error_class) BETWEEN 1 AND 64),
  PRIMARY KEY(intent_id,probe_number)
);
REVOKE ALL ON TABLE cinatoken_buyer_commit_journal.probes_v378 FROM PUBLIC;

-- Even the owning migrator cannot accidentally edit a pinned financial
-- expectation with ordinary UPDATE. DDL/superuser authority is outside this
-- review-only boundary.
CREATE FUNCTION cinatoken_buyer_commit_journal.keep_intent_v378()
RETURNS trigger LANGUAGE plpgsql SET search_path TO pg_catalog, pg_temp AS $keep$
BEGIN
  IF NEW.intent_id IS DISTINCT FROM OLD.intent_id
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.full_request_sha256 IS DISTINCT FROM OLD.full_request_sha256
    OR NEW.expected_financial_facts IS DISTINCT FROM OLD.expected_financial_facts
    OR NEW.prepared_at IS DISTINCT FROM OLD.prepared_at
    OR NEW.prepared_backend_pid IS DISTINCT FROM OLD.prepared_backend_pid
    OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
  THEN RAISE EXCEPTION 'buyer commit intent is immutable'
    USING ERRCODE='23514',CONSTRAINT='buyer_commit_intent_immutable_v378'; END IF;
  RETURN NEW;
END;
$keep$;
CREATE TRIGGER keep_intent_v378 BEFORE UPDATE
  ON cinatoken_buyer_commit_journal.intents_v378
  FOR EACH ROW EXECUTE FUNCTION cinatoken_buyer_commit_journal.keep_intent_v378();

CREATE FUNCTION cinatoken_buyer_commit_journal.prepare_v378(
  p_intent_id uuid,p_request_id text,p_full_request_sha256 text,
  p_expected jsonb,p_deadline_at timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $prepare$
DECLARE now_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_buyer_commit_journal'
    OR p_intent_id IS NULL
    OR p_request_id IS NULL OR pg_catalog.length(p_request_id) NOT BETWEEN 1 AND 128
    OR p_request_id<>pg_catalog.btrim(p_request_id)
    OR p_full_request_sha256 IS NULL
    OR p_full_request_sha256 COLLATE "C" !~ '^[0-9a-f]{64}$'
    OR p_deadline_at IS NULL
    OR p_deadline_at<now_at+INTERVAL '20 minutes'
    OR p_deadline_at>now_at+INTERVAL '7 days'
    OR p_expected IS NULL OR pg_catalog.jsonb_typeof(p_expected)<>'object'
    OR pg_catalog.octet_length(p_expected::text)>4194304
    OR p_expected->>'requestId' IS DISTINCT FROM p_request_id
    OR ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(p_expected) AS x(k)
        ORDER BY k COLLATE "C") IS DISTINCT FROM ARRAY[
      'apiKeyId','cacheReadTokens','cacheWriteTokens','chargeMicros',
      'inputTokens','outcomes','outputTokens','reason','requestId',
      'userId','workspaceId']::text[]
    OR pg_catalog.jsonb_typeof(p_expected->'requestId')<>'string'
    OR pg_catalog.jsonb_typeof(p_expected->'userId')<>'string'
    OR pg_catalog.jsonb_typeof(p_expected->'apiKeyId')<>'string'
    OR pg_catalog.jsonb_typeof(p_expected->'workspaceId')<>'string'
    OR pg_catalog.jsonb_typeof(p_expected->'reason')<>'string'
    OR pg_catalog.jsonb_typeof(p_expected->'chargeMicros')<>'number'
    OR pg_catalog.jsonb_typeof(p_expected->'inputTokens')<>'number'
    OR pg_catalog.jsonb_typeof(p_expected->'outputTokens')<>'number'
    OR pg_catalog.jsonb_typeof(p_expected->'cacheReadTokens')<>'number'
    OR pg_catalog.jsonb_typeof(p_expected->'cacheWriteTokens')<>'number'
    OR pg_catalog.jsonb_typeof(p_expected->'outcomes')<>'array'
    OR pg_catalog.jsonb_array_length(p_expected->'outcomes') NOT BETWEEN 1 AND 1000
    OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_expected->'outcomes')
      AS o(item) WHERE pg_catalog.jsonb_typeof(o.item)<>'object'
        OR ARRAY(SELECT k FROM pg_catalog.jsonb_object_keys(o.item) AS x(k)
          ORDER BY k COLLATE "C") IS DISTINCT FROM ARRAY[
          'attempt_id','attempt_index','cache_read_tokens',
          'cache_write_tokens','evidence_kind','evidence_sha256',
          'input_tokens','observed_at','output_tokens',
          'provider_cost_certainty','provider_cost_micros',
          'quote_version_id','shared_key_id','transition_id',
          'usage_certainty']::text[]
        OR pg_catalog.jsonb_typeof(o.item->'attempt_id')<>'string'
        OR pg_catalog.jsonb_typeof(o.item->'attempt_index')<>'number'
        OR pg_catalog.jsonb_typeof(o.item->'shared_key_id')<>'string'
        OR pg_catalog.jsonb_typeof(o.item->'transition_id')<>'string'
        OR pg_catalog.jsonb_typeof(o.item->'quote_version_id')<>'string'
        OR pg_catalog.jsonb_typeof(o.item->'usage_certainty')<>'string'
        OR pg_catalog.jsonb_typeof(o.item->'provider_cost_certainty')<>'string'
        OR pg_catalog.jsonb_typeof(o.item->'evidence_kind')<>'string'
        OR pg_catalog.jsonb_typeof(o.item->'observed_at')<>'string'
        OR pg_catalog.jsonb_typeof(o.item->'input_tokens') NOT IN ('number','null')
        OR pg_catalog.jsonb_typeof(o.item->'output_tokens') NOT IN ('number','null')
        OR pg_catalog.jsonb_typeof(o.item->'cache_read_tokens') NOT IN ('number','null')
        OR pg_catalog.jsonb_typeof(o.item->'cache_write_tokens') NOT IN ('number','null')
        OR pg_catalog.jsonb_typeof(o.item->'provider_cost_micros') NOT IN ('number','null')
        OR pg_catalog.jsonb_typeof(o.item->'evidence_sha256') NOT IN ('string','null'))
  THEN RAISE EXCEPTION 'invalid buyer commit intent'
    USING ERRCODE='23514',CONSTRAINT='buyer_commit_intent_input_v378'; END IF;
  -- Check raw JSON numbers as numeric before converting to integer. A
  -- fractional input must never be rounded into a different pinned target.
  IF (p_expected->>'chargeMicros')::numeric NOT BETWEEN 0 AND 9007199254740991
    OR (p_expected->>'chargeMicros')::numeric <>
      pg_catalog.trunc((p_expected->>'chargeMicros')::numeric)
    OR (p_expected->>'inputTokens')::numeric NOT BETWEEN 0 AND 9007199254740991
    OR (p_expected->>'inputTokens')::numeric <>
      pg_catalog.trunc((p_expected->>'inputTokens')::numeric)
    OR (p_expected->>'outputTokens')::numeric NOT BETWEEN 0 AND 9007199254740991
    OR (p_expected->>'outputTokens')::numeric <>
      pg_catalog.trunc((p_expected->>'outputTokens')::numeric)
    OR (p_expected->>'cacheReadTokens')::numeric NOT BETWEEN 0 AND 9007199254740991
    OR (p_expected->>'cacheReadTokens')::numeric <>
      pg_catalog.trunc((p_expected->>'cacheReadTokens')::numeric)
    OR (p_expected->>'cacheWriteTokens')::numeric NOT BETWEEN 0 AND 9007199254740991
    OR (p_expected->>'cacheWriteTokens')::numeric <>
      pg_catalog.trunc((p_expected->>'cacheWriteTokens')::numeric)
    OR pg_catalog.length(p_expected->>'userId') NOT BETWEEN 1 AND 128
    OR pg_catalog.length(p_expected->>'apiKeyId') NOT BETWEEN 1 AND 128
    OR pg_catalog.length(p_expected->>'workspaceId') NOT BETWEEN 1 AND 128
    OR pg_catalog.length(p_expected->>'reason') NOT BETWEEN 1 AND 128
  THEN RAISE EXCEPTION 'invalid buyer commit financial facts'
    USING ERRCODE='23514',CONSTRAINT='buyer_commit_financial_input_v378'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_to_recordset(p_expected->'outcomes')
      AS x(attempt_index numeric,input_tokens numeric,output_tokens numeric,
        cache_read_tokens numeric,cache_write_tokens numeric,
        provider_cost_micros numeric)
      WHERE x.attempt_index IS NULL OR x.attempt_index NOT BETWEEN 1 AND 1000
        OR x.attempt_index<>pg_catalog.trunc(x.attempt_index)
        OR (x.input_tokens IS NOT NULL AND
          (x.input_tokens NOT BETWEEN 0 AND 9007199254740991
            OR x.input_tokens<>pg_catalog.trunc(x.input_tokens)))
        OR (x.output_tokens IS NOT NULL AND
          (x.output_tokens NOT BETWEEN 0 AND 9007199254740991
            OR x.output_tokens<>pg_catalog.trunc(x.output_tokens)))
        OR (x.cache_read_tokens IS NOT NULL AND
          (x.cache_read_tokens NOT BETWEEN 0 AND 9007199254740991
            OR x.cache_read_tokens<>pg_catalog.trunc(x.cache_read_tokens)))
        OR (x.cache_write_tokens IS NOT NULL AND
          (x.cache_write_tokens NOT BETWEEN 0 AND 9007199254740991
            OR x.cache_write_tokens<>pg_catalog.trunc(x.cache_write_tokens)))
        OR (x.provider_cost_micros IS NOT NULL AND
          (x.provider_cost_micros NOT BETWEEN 0 AND 9007199254740991
            OR x.provider_cost_micros<>pg_catalog.trunc(x.provider_cost_micros))))
  THEN RAISE EXCEPTION 'invalid buyer commit outcome number'
    USING ERRCODE='23514',CONSTRAINT='buyer_commit_outcome_number_v378'; END IF;
  -- Match v375's typed record projection before any writer is allowed to
  -- start. Type and range failures abort prepare; NULL optional values stay.
  PERFORM x.attempt_id,x.attempt_index,x.input_tokens,x.output_tokens,
      x.cache_read_tokens,x.cache_write_tokens,x.provider_cost_micros,
      x.observed_at
    FROM pg_catalog.jsonb_to_recordset(p_expected->'outcomes')
      AS x(attempt_id uuid,attempt_index integer,shared_key_id text,
        transition_id text,quote_version_id text,usage_certainty text,
        input_tokens bigint,output_tokens bigint,cache_read_tokens bigint,
        cache_write_tokens bigint,provider_cost_certainty text,
        provider_cost_micros bigint,evidence_kind text,
        evidence_sha256 text,observed_at timestamptz);
  INSERT INTO cinatoken_buyer_commit_journal.intents_v378
    (intent_id,request_id,full_request_sha256,expected_financial_facts,
     prepared_at,prepared_backend_pid,deadline_at)
  VALUES(p_intent_id,p_request_id,p_full_request_sha256,p_expected,
    now_at,pg_catalog.pg_backend_pid(),p_deadline_at);
  RETURN pg_catalog.pg_backend_pid();
END;
$prepare$;

-- A different backend seeing the receipt proves prepare committed before the
-- caller is allowed to invoke the financial writer.
CREATE FUNCTION cinatoken_buyer_commit_journal.verify_prepared_v378(
  p_intent_id uuid,p_full_request_sha256 text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $verify$
DECLARE item record;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_buyer_commit_journal'
    OR p_intent_id IS NULL OR p_full_request_sha256 IS NULL THEN
    RAISE EXCEPTION 'invalid buyer commit verification' USING ERRCODE='23514';
  END IF;
  SELECT j.state,j.full_request_sha256,j.prepared_backend_pid,j.prepared_at
    INTO item FROM cinatoken_buyer_commit_journal.intents_v378 j
    WHERE j.intent_id=p_intent_id;
  RETURN FOUND AND item.state='prepared'
    AND item.full_request_sha256=p_full_request_sha256
    AND item.prepared_backend_pid<>pg_catalog.pg_backend_pid()
    AND item.prepared_at+INTERVAL '30 seconds'>pg_catalog.clock_timestamp();
END;
$verify$;

CREATE FUNCTION cinatoken_buyer_commit_journal.mark_write_v378(
  p_intent_id uuid,p_outcome text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $mark$
DECLARE item record; now_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_buyer_commit_journal'
    OR p_intent_id IS NULL OR p_outcome IS NULL
    OR p_outcome NOT IN ('acknowledged','uncertain') THEN
    RAISE EXCEPTION 'invalid buyer write observation' USING ERRCODE='23514';
  END IF;
  SELECT * INTO item FROM cinatoken_buyer_commit_journal.intents_v378 j
    WHERE j.intent_id=p_intent_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_outcome='acknowledged' AND item.state IN ('prepared','pending','leased') THEN
    -- A caller-reported ACK is advisory: a false ACK must never suppress the
    -- separate authenticated terminal read. It simply makes this row due.
    UPDATE cinatoken_buyer_commit_journal.intents_v378 j SET
      state='pending',
      first_uncertain_at=COALESCE(j.first_uncertain_at,now_at),
      write_ack_at=COALESCE(j.write_ack_at,now_at),
      lease_token=NULL,lease_until=NULL,next_probe_at=now_at,
      updated_at=now_at WHERE j.intent_id=p_intent_id;
  ELSIF p_outcome='acknowledged' THEN
    UPDATE cinatoken_buyer_commit_journal.intents_v378 j SET
      write_ack_at=COALESCE(j.write_ack_at,now_at),updated_at=now_at
      WHERE j.intent_id=p_intent_id;
  ELSIF item.state='prepared' THEN
    UPDATE cinatoken_buyer_commit_journal.intents_v378 j SET
      state='pending',first_uncertain_at=now_at,next_probe_at=now_at,
      updated_at=now_at WHERE j.intent_id=p_intent_id;
  END IF;
  SELECT j.state INTO item FROM cinatoken_buyer_commit_journal.intents_v378 j
    WHERE j.intent_id=p_intent_id;
  RETURN item.state;
END;
$mark$;

CREATE FUNCTION cinatoken_buyer_commit_journal.claim_due_v378(p_lease_seconds integer)
RETURNS TABLE(intent_id uuid,lease_token uuid,probe_number integer,
  lease_until timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $claim$
DECLARE item record; now_at timestamptz := pg_catalog.clock_timestamp();
DECLARE new_token uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_buyer_commit_journal'
    OR p_lease_seconds NOT BETWEEN 5 AND 60 THEN
    RAISE EXCEPTION 'invalid buyer commit claim' USING ERRCODE='23514';
  END IF;
  -- Sweep a bounded unlocked batch. An unrelated locked expired row cannot
  -- stall all due probes; the next worker pass can pick it up later.
  WITH overdue AS (
    SELECT j.intent_id FROM cinatoken_buyer_commit_journal.intents_v378 j
      WHERE j.state IN ('prepared','pending','leased')
        AND j.deadline_at<=now_at
      ORDER BY j.deadline_at,j.intent_id
      LIMIT 16 FOR UPDATE OF j SKIP LOCKED
  )
  UPDATE cinatoken_buyer_commit_journal.intents_v378 j SET
    state='quarantined',quarantined_at=now_at,
    quarantine_reason='deadline',lease_token=NULL,lease_until=NULL,
    next_probe_at=NULL,updated_at=now_at
    FROM overdue WHERE j.intent_id=overdue.intent_id;
  WITH exhausted AS (
    SELECT j.intent_id FROM cinatoken_buyer_commit_journal.intents_v378 j
      WHERE j.claim_count=7 AND (j.state='pending'
        OR (j.state='leased' AND j.lease_until<=now_at))
      ORDER BY j.lease_until NULLS FIRST,j.intent_id
      LIMIT 16 FOR UPDATE OF j SKIP LOCKED
  )
  UPDATE cinatoken_buyer_commit_journal.intents_v378 j SET
    state='quarantined',quarantined_at=now_at,
    quarantine_reason='probe_exhausted',lease_token=NULL,
    lease_until=NULL,next_probe_at=NULL,updated_at=now_at
    FROM exhausted WHERE j.intent_id=exhausted.intent_id;
  now_at := pg_catalog.clock_timestamp();
  SELECT j.intent_id,j.claim_count,j.first_uncertain_at
    INTO item FROM cinatoken_buyer_commit_journal.intents_v378 j
    WHERE j.deadline_at>now_at AND j.claim_count<7 AND (
      (j.state='prepared' AND j.prepared_at+INTERVAL '30 seconds'<=now_at)
      OR (j.state='pending' AND j.next_probe_at<=now_at)
      OR (j.state='leased' AND j.lease_until<=now_at))
    ORDER BY COALESCE(j.next_probe_at,j.prepared_at),j.intent_id
    LIMIT 1 FOR UPDATE OF j SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE cinatoken_buyer_commit_journal.intents_v378 j SET
    state='leased',first_uncertain_at=COALESCE(j.first_uncertain_at,now_at),
    claim_count=j.claim_count+1,lease_generation=j.lease_generation+1,
    lease_token=new_token,
    lease_until=now_at+pg_catalog.make_interval(secs=>p_lease_seconds),
    next_probe_at=NULL,updated_at=now_at
    WHERE j.intent_id=item.intent_id;
  RETURN QUERY SELECT j.intent_id,j.lease_token,j.claim_count,j.lease_until
    FROM cinatoken_buyer_commit_journal.intents_v378 j
    WHERE j.intent_id=item.intent_id;
END;
$claim$;

-- Only SECURITY DEFINER wrappers below invoke this internal state machine.
-- It receives no authority from the journal LOGIN directly.
CREATE FUNCTION cinatoken_buyer_commit_journal.apply_probe_v378(
  p_intent_id uuid,p_lease_token uuid,p_observation text,p_error_class text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $complete$
DECLARE item record; now_at timestamptz := pg_catalog.clock_timestamp();
DECLARE next_count integer; next_state text; next_due timestamptz;
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR p_intent_id IS NULL OR p_lease_token IS NULL
    OR p_observation NOT IN ('confirmed','unconfirmed','conflict','reader_error')
    OR (p_observation='reader_error') IS DISTINCT FROM (p_error_class IS NOT NULL)
    OR (p_error_class IS NOT NULL AND
      (pg_catalog.length(p_error_class) NOT BETWEEN 1 AND 64
       OR p_error_class COLLATE "C" !~ '^[a-z0-9_]+$')) THEN
    RAISE EXCEPTION 'invalid buyer terminal observation' USING ERRCODE='23514';
  END IF;
  SELECT * INTO item FROM cinatoken_buyer_commit_journal.intents_v378 j
    WHERE j.intent_id=p_intent_id FOR UPDATE;
  now_at := pg_catalog.clock_timestamp();
  IF NOT FOUND OR item.state<>'leased'
    OR item.lease_token IS DISTINCT FROM p_lease_token
    OR item.lease_until<=now_at OR item.deadline_at<=now_at THEN
    RETURN NULL;
  END IF;
  next_count := item.probe_count+1;
  IF p_observation='confirmed' THEN
    next_state := 'financial_facts_confirmed';
  ELSIF p_observation='conflict' OR item.claim_count=7 THEN
    next_state := 'quarantined';
  ELSE
    next_state := 'pending';
    -- Preserve the absolute 0/1/5/20/60/180/600 second schedule when the
    -- worker is timely. After downtime, space catch-up probes rather than
    -- exhaust all seven in one burst.
    next_due := GREATEST(item.first_uncertain_at+CASE item.claim_count
      WHEN 1 THEN INTERVAL '1 second'
      WHEN 2 THEN INTERVAL '5 seconds'
      WHEN 3 THEN INTERVAL '20 seconds'
      WHEN 4 THEN INTERVAL '60 seconds'
      WHEN 5 THEN INTERVAL '180 seconds'
      WHEN 6 THEN INTERVAL '600 seconds' END,
      now_at+CASE item.claim_count
      WHEN 1 THEN INTERVAL '1 second'
      WHEN 2 THEN INTERVAL '4 seconds'
      WHEN 3 THEN INTERVAL '15 seconds'
      WHEN 4 THEN INTERVAL '40 seconds'
      WHEN 5 THEN INTERVAL '120 seconds'
      WHEN 6 THEN INTERVAL '420 seconds' END);
  END IF;
  INSERT INTO cinatoken_buyer_commit_journal.probes_v378
    (intent_id,probe_number,lease_generation,observed_at,observation,error_class)
  VALUES(p_intent_id,item.claim_count,item.lease_generation,now_at,
    p_observation,p_error_class);
  UPDATE cinatoken_buyer_commit_journal.intents_v378 j SET
    state=next_state,probe_count=next_count,lease_token=NULL,
    lease_until=NULL,next_probe_at=next_due,
    last_observation=p_observation,last_error_class=p_error_class,
    quarantined_at=CASE WHEN next_state='quarantined' THEN now_at ELSE NULL END,
    quarantine_reason=CASE WHEN p_observation='conflict' THEN 'conflict'
      WHEN next_state='quarantined' THEN 'probe_exhausted' ELSE NULL END,
    updated_at=now_at WHERE j.intent_id=p_intent_id;
  RETURN next_state;
END;
$complete$;

-- The v375 reader LOGIN supplies no claimed status or expected facts. This
-- function reads the pinned receipt, invokes the real v375 reader as that
-- SESSION_USER, then atomically records the returned financial-only result.
CREATE FUNCTION cinatoken_buyer_commit_journal.complete_from_reader_v378(
  p_intent_id uuid,p_lease_token uuid)
RETURNS TABLE(financial_facts text,journal_state text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $read_complete$
DECLARE pinned jsonb; fact text; lease_end timestamptz; review_end timestamptz;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_buyer_terminal_reader'
    OR p_intent_id IS NULL OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'dedicated buyer terminal reader required'
      USING ERRCODE='42501';
  END IF;
  -- The row lock serializes repeated calls with the same token so one claim
  -- can invoke v375 at most once, even across concurrent reader sessions.
  SELECT j.expected_financial_facts,j.lease_until,j.deadline_at
    INTO pinned,lease_end,review_end
    FROM cinatoken_buyer_commit_journal.intents_v378 j
    WHERE j.intent_id=p_intent_id AND j.state='leased'
      AND j.lease_token=p_lease_token
    FOR UPDATE OF j;
  IF NOT FOUND OR lease_end<=pg_catalog.clock_timestamp()
    OR review_end<=pg_catalog.clock_timestamp() THEN RETURN; END IF;
  SELECT cinatoken_buyer_terminal.read_windowed_v375(
      pinned->>'requestId',pinned->>'userId',pinned->>'apiKeyId',
      pinned->>'workspaceId',(pinned->>'chargeMicros')::bigint,
      (pinned->>'inputTokens')::bigint,(pinned->>'outputTokens')::bigint,
      (pinned->>'cacheReadTokens')::bigint,
      (pinned->>'cacheWriteTokens')::bigint,pinned->>'reason',
      pinned->'outcomes') INTO fact;
  financial_facts := fact;
  journal_state := cinatoken_buyer_commit_journal.apply_probe_v378(
    p_intent_id,p_lease_token,fact,NULL);
  RETURN NEXT;
END;
$read_complete$;

-- A journal worker can report only that its reader failed; it cannot submit
-- `confirmed`, `unconfirmed`, or `conflict` on the reader's behalf.
CREATE FUNCTION cinatoken_buyer_commit_journal.record_reader_error_v378(
  p_intent_id uuid,p_lease_token uuid,p_error_class text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $reader_error$
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_buyer_commit_journal' THEN
    RAISE EXCEPTION 'dedicated buyer journal required' USING ERRCODE='42501';
  END IF;
  RETURN cinatoken_buyer_commit_journal.apply_probe_v378(
    p_intent_id,p_lease_token,'reader_error',p_error_class);
END;
$reader_error$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cinatoken_buyer_commit_journal FROM PUBLIC;
GRANT USAGE ON SCHEMA cinatoken_buyer_commit_journal
  TO cinatoken_gateway_buyer_commit_journal,
     cinatoken_gateway_buyer_terminal_reader;
GRANT EXECUTE ON FUNCTION cinatoken_buyer_commit_journal.prepare_v378(
    uuid,text,text,jsonb,timestamptz),
  cinatoken_buyer_commit_journal.verify_prepared_v378(uuid,text),
  cinatoken_buyer_commit_journal.mark_write_v378(uuid,text),
  cinatoken_buyer_commit_journal.claim_due_v378(integer),
  cinatoken_buyer_commit_journal.record_reader_error_v378(uuid,uuid,text)
  TO cinatoken_gateway_buyer_commit_journal;
GRANT EXECUTE ON FUNCTION
  cinatoken_buyer_commit_journal.complete_from_reader_v378(uuid,uuid)
  TO cinatoken_gateway_buyer_terminal_reader;
