-- REVIEW ONLY. No financial writer, adjustment, provider-cost inference or
-- automatic resolution of a claim without a committed economic event.
-- Install as the direct migrator LOGIN after PG73, quote/attempt and economic
-- outbox proposals, in one READ COMMITTED transaction with:
--   SET LOCAL cinatoken.shared_key_orphan_review_activation = 'reviewed-v1';
-- Pre-provision independent direct LOGIN roles:
--   cinatoken_gateway_shared_orphan_worker
--   cinatoken_gateway_shared_orphan_recovery
-- No ordinary runtime, quote producer or PUBLIC table/function access is given.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;

-- Writers that committed before this lock are included in the backfill. Later
-- writes see the triggers. A claimed_at cursor is never used for coverage.
LOCK TABLE cinatoken_economic_outbox.shared_key_economic_events,
  cinatoken_economic_quotes.shared_key_dispatch_quote_attempts
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
DECLARE worker_oid oid;
DECLARE recovery_oid oid;
DECLARE runtime_oid oid;
DECLARE producer_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO worker_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_orphan_worker';
  SELECT oid INTO recovery_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_orphan_recovery';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO producer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_quote_attempt_producer';
  IF pg_catalog.current_setting('cinatoken.shared_key_orphan_review_activation',true)
       IS DISTINCT FROM 'reviewed-v1'
    OR SESSION_USER<>'cinatoken_gateway_migrator' OR CURRENT_USER<>SESSION_USER
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR migrator_oid IS NULL OR worker_oid IS NULL OR recovery_oid IS NULL
    OR runtime_oid IS NULL OR producer_oid IS NULL OR worker_oid=recovery_oid
    OR pg_catalog.to_regnamespace('cinatoken_economic_orphan_review') IS NOT NULL
    OR (SELECT relowner FROM pg_catalog.pg_class WHERE
      oid='cinatoken_economic_quotes.shared_key_dispatch_quote_attempts'::pg_catalog.regclass)
      IS DISTINCT FROM migrator_oid
    OR (SELECT relowner FROM pg_catalog.pg_class WHERE
      oid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass)
      IS DISTINCT FROM migrator_oid
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid IN (worker_oid,recovery_oid)
      AND (NOT rolcanlogin OR rolinherit OR rolsuper OR rolcreaterole
        OR rolcreatedb OR rolbypassrls))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid IN (worker_oid,recovery_oid)
        OR member IN (worker_oid,recovery_oid))
    OR pg_catalog.pg_has_role(runtime_oid,worker_oid,'MEMBER')
    OR pg_catalog.pg_has_role(runtime_oid,recovery_oid,'MEMBER')
    OR pg_catalog.pg_has_role(runtime_oid,migrator_oid,'MEMBER')
    OR pg_catalog.pg_has_role(producer_oid,migrator_oid,'MEMBER')
    OR pg_catalog.pg_has_role(worker_oid,migrator_oid,'MEMBER')
    OR pg_catalog.pg_has_role(recovery_oid,migrator_oid,'MEMBER')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
      WHERE r.oid IN (runtime_oid,producer_oid,worker_oid,recovery_oid)
      AND (r.rolsuper OR r.rolbypassrls
        OR pg_catalog.pg_has_role(r.oid,'pg_read_all_data'::pg_catalog.regrole,'MEMBER')
        OR pg_catalog.pg_has_role(r.oid,'pg_write_all_data'::pg_catalog.regrole,'MEMBER')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE
      tgrelid='cinatoken_economic_quotes.shared_key_dispatch_quote_attempts'::pg_catalog.regclass
      AND tgname IN ('shared_quote_attempts_no_change','shared_quote_attempts_no_truncate')
      AND tgenabled<>'O')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger WHERE
      tgrelid='cinatoken_economic_quotes.shared_key_dispatch_quote_attempts'::pg_catalog.regclass
      AND tgname IN ('shared_quote_attempts_no_change','shared_quote_attempts_no_truncate')
      AND tgenabled='O')<>2
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger WHERE
      tgrelid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
      AND tgname IN ('shared_key_economic_events_guard_insert','shared_key_economic_events_verify',
        'shared_key_economic_events_no_change','shared_key_economic_events_no_truncate')
      AND tgenabled='O')<>4
  THEN
    RAISE EXCEPTION 'Orphan review activation, source guard or role contract differs';
  END IF;
END;
$preflight$;

CREATE SCHEMA cinatoken_economic_orphan_review AUTHORIZATION cinatoken_gateway_migrator;
REVOKE ALL ON SCHEMA cinatoken_economic_orphan_review FROM PUBLIC,
  cinatoken_gateway_runtime,cinatoken_gateway_shared_quote_attempt_producer,
  cinatoken_gateway_shared_orphan_worker,cinatoken_gateway_shared_orphan_recovery;

-- A work item is an investigation pointer. Its count is maintained by the
-- same transaction that appends a quote claim; it is not a usage or price fact.
CREATE TABLE cinatoken_economic_orphan_review.jobs (
  request_log_id text PRIMARY KEY,
  claim_count integer NOT NULL CHECK (claim_count BETWEEN 1 AND 1000),
  first_claimed_at timestamptz NOT NULL,
  latest_claimed_at timestamptz NOT NULL,
  status text NOT NULL CHECK
    (status IN ('pending','leased','dead_letter','resolved_event')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0),
  lease_attempt_count integer NOT NULL DEFAULT 0
    CHECK (lease_attempt_count BETWEEN 0 AND 8),
  recovery_count integer NOT NULL DEFAULT 0
    CHECK (recovery_count BETWEEN 0 AND 1000),
  next_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  lease_token uuid,
  leased_at timestamptz,
  lease_until timestamptz,
  dead_at timestamptz,
  resolved_at timestamptz,
  last_failure_code text,
  last_action text NOT NULL,
  last_operation_token uuid,
  last_reason_code text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT orphan_review_claim_time CHECK (latest_claimed_at>=first_claimed_at),
  CONSTRAINT orphan_review_failure_code CHECK (last_failure_code IS NULL OR
    last_failure_code COLLATE "C" ~ '^[a-z0-9_]{3,64}$'),
  CONSTRAINT orphan_review_reason_code CHECK (last_reason_code IS NULL OR
    last_reason_code COLLATE "C" ~ '^[a-z0-9_]{3,64}$'),
  CONSTRAINT orphan_review_state_shape CHECK (
    (status='pending' AND lease_token IS NULL AND leased_at IS NULL
      AND lease_until IS NULL AND dead_at IS NULL AND resolved_at IS NULL)
    OR (status='leased' AND lease_token IS NOT NULL AND leased_at IS NOT NULL
      AND lease_until>leased_at AND dead_at IS NULL AND resolved_at IS NULL)
    OR (status='dead_letter' AND lease_token IS NULL AND leased_at IS NULL
      AND lease_until IS NULL AND dead_at IS NOT NULL AND resolved_at IS NULL)
    OR (status='resolved_event' AND lease_token IS NULL AND leased_at IS NULL
      AND lease_until IS NULL AND dead_at IS NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX orphan_review_pending_due
  ON cinatoken_economic_orphan_review.jobs(next_attempt_at,request_log_id)
  WHERE status='pending';
CREATE INDEX orphan_review_expired_lease
  ON cinatoken_economic_orphan_review.jobs(lease_until,request_log_id)
  WHERE status='leased';

CREATE TABLE cinatoken_economic_orphan_review.job_audit (
  request_log_id text NOT NULL REFERENCES cinatoken_economic_orphan_review.jobs(request_log_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  revision bigint NOT NULL,
  action text NOT NULL,
  actor text NOT NULL,
  status text NOT NULL,
  claim_count integer NOT NULL,
  lease_attempt_count integer NOT NULL,
  recovery_count integer NOT NULL,
  operation_token uuid,
  reason_code text,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(request_log_id,revision)
);
CREATE UNIQUE INDEX orphan_review_recovery_token_once
  ON cinatoken_economic_orphan_review.job_audit(request_log_id,operation_token)
  WHERE action='dead_letter_requeued';

CREATE FUNCTION cinatoken_economic_orphan_review.reject_audit_mutation()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $reject$
BEGIN
  RAISE EXCEPTION 'Orphan review audit is append-only'
    USING ERRCODE='23514',CONSTRAINT='orphan_review_audit_append_only';
END;
$reject$;
CREATE TRIGGER orphan_review_audit_no_change BEFORE UPDATE OR DELETE
  ON cinatoken_economic_orphan_review.job_audit FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_economic_orphan_review.reject_audit_mutation();
CREATE TRIGGER orphan_review_audit_no_truncate BEFORE TRUNCATE
  ON cinatoken_economic_orphan_review.job_audit FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_economic_orphan_review.reject_audit_mutation();

CREATE FUNCTION cinatoken_economic_orphan_review.guard_job_update()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $guard$
BEGIN
  IF TG_RELID<>'cinatoken_economic_orphan_review.jobs'::pg_catalog.regclass
    OR TG_NAME<>'orphan_review_jobs_guard_update' OR TG_OP<>'UPDATE'
    OR NEW.request_log_id IS DISTINCT FROM OLD.request_log_id
    OR NEW.revision IS DISTINCT FROM OLD.revision+1
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.first_claimed_at IS DISTINCT FROM OLD.first_claimed_at
    OR NEW.latest_claimed_at<OLD.latest_claimed_at
    OR NEW.claim_count<OLD.claim_count
    OR NEW.recovery_count<OLD.recovery_count
    OR OLD.status='resolved_event'
  THEN
    RAISE EXCEPTION 'Orphan review transition contract differs'
      USING ERRCODE='23514',CONSTRAINT='orphan_review_transition';
  END IF;
  IF NEW.status='resolved_event' AND NOT EXISTS
    (SELECT 1 FROM cinatoken_economic_outbox.shared_key_economic_events
      WHERE request_log_id=NEW.request_log_id) THEN
    RAISE EXCEPTION 'Orphan review resolution requires committed event'
      USING ERRCODE='23514',CONSTRAINT='orphan_review_event_required';
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER orphan_review_jobs_guard_update BEFORE UPDATE
  ON cinatoken_economic_orphan_review.jobs FOR EACH ROW
  EXECUTE FUNCTION cinatoken_economic_orphan_review.guard_job_update();

CREATE FUNCTION cinatoken_economic_orphan_review.audit_job_transition()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $audit$
BEGIN
  IF TG_RELID<>'cinatoken_economic_orphan_review.jobs'::pg_catalog.regclass
    OR TG_NAME<>'orphan_review_jobs_audit' OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'Orphan review audit binding differs';
  END IF;
  INSERT INTO cinatoken_economic_orphan_review.job_audit
    (request_log_id,revision,action,actor,status,claim_count,
      lease_attempt_count,recovery_count,operation_token,reason_code)
  VALUES (NEW.request_log_id,NEW.revision,NEW.last_action,SESSION_USER,
    NEW.status,NEW.claim_count,NEW.lease_attempt_count,NEW.recovery_count,
    NEW.last_operation_token,NEW.last_reason_code);
  RETURN NULL;
END;
$audit$;
CREATE TRIGGER orphan_review_jobs_audit AFTER INSERT OR UPDATE
  ON cinatoken_economic_orphan_review.jobs FOR EACH ROW
  EXECUTE FUNCTION cinatoken_economic_orphan_review.audit_job_transition();

CREATE FUNCTION cinatoken_economic_orphan_review.enqueue_claim()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $enqueue$
DECLARE has_event boolean;
BEGIN
  IF TG_RELID<>'cinatoken_economic_quotes.shared_key_dispatch_quote_attempts'::pg_catalog.regclass
    OR TG_NAME<>'shared_quote_attempts_enqueue_orphan_review'
    OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'Orphan review claim trigger or isolation differs';
  END IF;
  -- The approved claim function already owns this lock. Reacquiring it also
  -- covers owner-operated insertion and keeps event/job order uniform.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('shared_quote_attempt:'||NEW.request_log_id,0));
  SELECT EXISTS (SELECT 1 FROM cinatoken_economic_outbox.shared_key_economic_events
    WHERE request_log_id=NEW.request_log_id) INTO has_event;
  INSERT INTO cinatoken_economic_orphan_review.jobs
    (request_log_id,claim_count,first_claimed_at,latest_claimed_at,status,
      resolved_at,last_action)
  VALUES (NEW.request_log_id,1,NEW.claimed_at,NEW.claimed_at,
    CASE WHEN has_event THEN 'resolved_event' ELSE 'pending' END,
    CASE WHEN has_event THEN pg_catalog.clock_timestamp() ELSE NULL END,
    'claim_created')
  ON CONFLICT (request_log_id) DO UPDATE SET
    claim_count=cinatoken_economic_orphan_review.jobs.claim_count+1,
    latest_claimed_at=greatest(
      cinatoken_economic_orphan_review.jobs.latest_claimed_at,EXCLUDED.latest_claimed_at),
    revision=cinatoken_economic_orphan_review.jobs.revision+1,
    last_action='claim_added',last_operation_token=NULL,last_reason_code=NULL
    WHERE cinatoken_economic_orphan_review.jobs.status<>'resolved_event';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim after resolved economic event cannot be enrolled'
      USING ERRCODE='23514',CONSTRAINT='orphan_review_claim_after_event';
  END IF;
  RETURN NULL;
END;
$enqueue$;
CREATE TRIGGER shared_quote_attempts_enqueue_orphan_review AFTER INSERT
  ON cinatoken_economic_quotes.shared_key_dispatch_quote_attempts FOR EACH ROW
  EXECUTE FUNCTION cinatoken_economic_orphan_review.enqueue_claim();

CREATE FUNCTION cinatoken_economic_orphan_review.resolve_event()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $resolve$
BEGIN
  IF TG_RELID<>'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
    OR TG_NAME<>'shared_key_economic_events_resolve_orphan_review'
    OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'Orphan review event trigger or isolation differs';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('shared_quote_attempt:'||NEW.request_log_id,0));
  UPDATE cinatoken_economic_orphan_review.jobs SET
    status='resolved_event',revision=revision+1,
    lease_token=NULL,leased_at=NULL,lease_until=NULL,dead_at=NULL,
    resolved_at=pg_catalog.clock_timestamp(),last_action='event_resolved',
    last_operation_token=NULL,last_reason_code=NULL
    WHERE request_log_id=NEW.request_log_id AND status<>'resolved_event';
  RETURN NULL;
END;
$resolve$;
CREATE TRIGGER shared_key_economic_events_resolve_orphan_review AFTER INSERT
  ON cinatoken_economic_outbox.shared_key_economic_events FOR EACH ROW
  EXECUTE FUNCTION cinatoken_economic_orphan_review.resolve_event();

-- Backfill while both source writers remain blocked. The deferred event guard
-- has committed before its row is visible here. No timestamp high-water mark.
INSERT INTO cinatoken_economic_orphan_review.jobs
  (request_log_id,claim_count,first_claimed_at,latest_claimed_at,status,
    resolved_at,last_action)
SELECT a.request_log_id,pg_catalog.count(*)::integer,
  pg_catalog.min(a.claimed_at),pg_catalog.max(a.claimed_at),
  CASE WHEN e.request_log_id IS NULL THEN 'pending' ELSE 'resolved_event' END,
  CASE WHEN e.request_log_id IS NULL THEN NULL ELSE pg_catalog.clock_timestamp() END,
  'install_backfill'
FROM cinatoken_economic_quotes.shared_key_dispatch_quote_attempts a
LEFT JOIN cinatoken_economic_outbox.shared_key_economic_events e
  ON e.request_log_id=a.request_log_id
GROUP BY a.request_log_id,e.request_log_id;

-- This is a read-only, repeatedly restarted due-list. Its pagination key is
-- not a durable discovery watermark; every claim was already enqueued by its
-- own COMMIT, including a claim committed after any earlier page was read.
CREATE FUNCTION cinatoken_economic_orphan_review.list_due(
  p_after_due timestamptz,p_after_request text,p_limit integer,p_min_age_seconds integer)
RETURNS TABLE(request_log_id text,due_at timestamptz,claim_count integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $list$
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>'cinatoken_gateway_shared_orphan_worker'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_limit NOT BETWEEN 1 AND 1000
    OR p_min_age_seconds NOT BETWEEN 0 AND 86400
    OR (p_after_due IS NULL) IS DISTINCT FROM (p_after_request IS NULL)
  THEN
    RAISE EXCEPTION 'Orphan review due-list caller or argument differs';
  END IF;
  RETURN QUERY SELECT j.request_log_id,
    CASE WHEN j.status='leased' THEN j.lease_until ELSE j.next_attempt_at END,
    j.claim_count
  FROM cinatoken_economic_orphan_review.jobs j
  WHERE j.status IN ('pending','leased')
    AND j.latest_claimed_at<=pg_catalog.clock_timestamp()
      -pg_catalog.make_interval(secs=>p_min_age_seconds)
    AND CASE WHEN j.status='leased' THEN j.lease_until ELSE j.next_attempt_at END
      <=pg_catalog.clock_timestamp()
    AND (p_after_due IS NULL OR
      (CASE WHEN j.status='leased' THEN j.lease_until ELSE j.next_attempt_at END,
        j.request_log_id)>(p_after_due,p_after_request))
  ORDER BY 2,1 LIMIT p_limit;
END;
$list$;

-- Caller-generated UUID makes a lost lease ACK identifiable. Take the request
-- advisory lock before the row lock; SKIP LOCKED can return zero while due
-- work exists, so callers must retry a fresh full due-list pass.
CREATE FUNCTION cinatoken_economic_orphan_review.claim_job(
  p_request_log_id text,p_lease_token uuid,p_lease_seconds integer,
  p_min_age_seconds integer)
RETURNS TABLE(request_log_id text,lease_token uuid,claim_count integer,
  lease_attempt_count integer,lease_until timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $claim$
DECLARE current_job cinatoken_economic_orphan_review.jobs%ROWTYPE;
DECLARE now_at timestamptz;
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>'cinatoken_gateway_shared_orphan_worker'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_log_id IS NULL OR p_request_log_id<>pg_catalog.btrim(p_request_log_id)
    OR pg_catalog.length(p_request_log_id) NOT BETWEEN 1 AND 128
    OR p_lease_token IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 3600
    OR p_min_age_seconds NOT BETWEEN 0 AND 86400
  THEN
    RAISE EXCEPTION 'Orphan review claim caller or argument differs';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('shared_quote_attempt:'||p_request_log_id,0)) THEN
    RETURN;
  END IF;
  SELECT * INTO current_job FROM cinatoken_economic_orphan_review.jobs j
    WHERE j.request_log_id=p_request_log_id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  now_at:=pg_catalog.clock_timestamp();
  IF current_job.status='leased' AND current_job.lease_token=p_lease_token
    AND current_job.lease_until>now_at THEN
    RETURN QUERY SELECT current_job.request_log_id,current_job.lease_token,
      current_job.claim_count,current_job.lease_attempt_count,current_job.lease_until;
    RETURN;
  END IF;
  IF current_job.status NOT IN ('pending','leased')
    OR current_job.latest_claimed_at>now_at-pg_catalog.make_interval(secs=>p_min_age_seconds)
    OR (current_job.status='pending' AND current_job.next_attempt_at>now_at)
    OR (current_job.status='leased' AND current_job.lease_until>now_at)
    OR EXISTS (SELECT 1 FROM cinatoken_economic_orphan_review.job_audit a
      WHERE a.request_log_id=p_request_log_id AND a.operation_token=p_lease_token
        AND a.action IN ('lease_claimed','lease_reclaimed','review_retry',
          'review_dead_letter','lease_expired_dead_letter'))
  THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM cinatoken_economic_outbox.shared_key_economic_events e
      WHERE e.request_log_id=p_request_log_id) THEN
    UPDATE cinatoken_economic_orphan_review.jobs SET
      status='resolved_event',revision=revision+1,
      lease_token=NULL,leased_at=NULL,lease_until=NULL,dead_at=NULL,
      resolved_at=now_at,last_action='event_resolved',
      last_operation_token=NULL,last_reason_code=NULL
      WHERE jobs.request_log_id=p_request_log_id;
    RETURN;
  END IF;
  IF current_job.lease_attempt_count>=8 THEN
    UPDATE cinatoken_economic_orphan_review.jobs SET
      status='dead_letter',revision=revision+1,
      lease_token=NULL,leased_at=NULL,lease_until=NULL,dead_at=now_at,
      last_failure_code='lease_expired',last_action='lease_expired_dead_letter',
      last_operation_token=NULL,last_reason_code='lease_expired'
      WHERE jobs.request_log_id=p_request_log_id;
    RETURN;
  END IF;
  UPDATE cinatoken_economic_orphan_review.jobs SET
    status='leased',revision=revision+1,
    lease_attempt_count=jobs.lease_attempt_count+1,lease_token=p_lease_token,
    leased_at=now_at,lease_until=now_at+pg_catalog.make_interval(secs=>p_lease_seconds),
    last_action=CASE WHEN current_job.status='leased'
      THEN 'lease_reclaimed' ELSE 'lease_claimed' END,
    last_operation_token=p_lease_token,last_reason_code=NULL
    WHERE jobs.request_log_id=p_request_log_id;
  RETURN QUERY SELECT j.request_log_id,j.lease_token,j.claim_count,
    j.lease_attempt_count,j.lease_until
    FROM cinatoken_economic_orphan_review.jobs j
    WHERE j.request_log_id=p_request_log_id;
END;
$claim$;

CREATE FUNCTION cinatoken_economic_orphan_review.fail_job(
  p_request_log_id text,p_lease_token uuid,p_reason_code text,p_retry_seconds integer)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $fail$
DECLARE current_job cinatoken_economic_orphan_review.jobs%ROWTYPE;
DECLARE now_at timestamptz;
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>'cinatoken_gateway_shared_orphan_worker'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_log_id IS NULL OR p_request_log_id<>pg_catalog.btrim(p_request_log_id)
    OR pg_catalog.length(p_request_log_id) NOT BETWEEN 1 AND 128
    OR p_lease_token IS NULL OR p_reason_code IS NULL
    OR p_reason_code COLLATE "C" !~ '^[a-z0-9_]{3,64}$'
    OR p_retry_seconds NOT BETWEEN 5 AND 86400
  THEN
    RAISE EXCEPTION 'Orphan review failure caller or argument differs';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('shared_quote_attempt:'||p_request_log_id,0));
  SELECT * INTO current_job FROM cinatoken_economic_orphan_review.jobs
    WHERE jobs.request_log_id=p_request_log_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM cinatoken_economic_orphan_review.job_audit a
      WHERE a.request_log_id=p_request_log_id AND a.operation_token=p_lease_token
        AND a.action IN ('review_retry','review_dead_letter')) THEN
    RETURN 'already_recorded';
  END IF;
  IF current_job.request_log_id IS NULL OR current_job.status<>'leased'
    OR current_job.lease_token IS DISTINCT FROM p_lease_token THEN
    RETURN 'stale';
  END IF;
  now_at:=pg_catalog.clock_timestamp();
  IF current_job.lease_attempt_count>=8 THEN
    UPDATE cinatoken_economic_orphan_review.jobs SET
      status='dead_letter',revision=revision+1,
      lease_token=NULL,leased_at=NULL,lease_until=NULL,dead_at=now_at,
      last_failure_code=p_reason_code,last_action='review_dead_letter',
      last_operation_token=p_lease_token,last_reason_code=p_reason_code
      WHERE jobs.request_log_id=p_request_log_id;
    RETURN 'dead_letter';
  END IF;
  UPDATE cinatoken_economic_orphan_review.jobs SET
    status='pending',revision=revision+1,
    lease_token=NULL,leased_at=NULL,lease_until=NULL,
    next_attempt_at=now_at+pg_catalog.make_interval(secs=>p_retry_seconds),
    last_failure_code=p_reason_code,last_action='review_retry',
    last_operation_token=p_lease_token,last_reason_code=p_reason_code
    WHERE jobs.request_log_id=p_request_log_id;
  RETURN 'retry_scheduled';
END;
$fail$;

CREATE FUNCTION cinatoken_economic_orphan_review.requeue_dead_letter(
  p_request_log_id text,p_recovery_token uuid,p_reason_code text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $requeue$
DECLARE current_job cinatoken_economic_orphan_review.jobs%ROWTYPE;
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>'cinatoken_gateway_shared_orphan_recovery'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_log_id IS NULL OR p_request_log_id<>pg_catalog.btrim(p_request_log_id)
    OR pg_catalog.length(p_request_log_id) NOT BETWEEN 1 AND 128
    OR p_recovery_token IS NULL OR p_reason_code IS NULL
    OR p_reason_code COLLATE "C" !~ '^[a-z0-9_]{3,64}$'
  THEN
    RAISE EXCEPTION 'Orphan review recovery caller or argument differs';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('shared_quote_attempt:'||p_request_log_id,0));
  SELECT * INTO current_job FROM cinatoken_economic_orphan_review.jobs
    WHERE jobs.request_log_id=p_request_log_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM cinatoken_economic_orphan_review.job_audit a
      WHERE a.request_log_id=p_request_log_id AND a.operation_token=p_recovery_token
        AND a.action='dead_letter_requeued') THEN
    RETURN 'already_requeued';
  END IF;
  IF current_job.request_log_id IS NULL OR current_job.status<>'dead_letter'
    THEN RETURN 'stale'; END IF;
  IF current_job.recovery_count>=1000 THEN
    RAISE EXCEPTION 'Orphan review recovery limit reached'
      USING ERRCODE='23514',CONSTRAINT='orphan_review_recovery_limit';
  END IF;
  IF EXISTS (SELECT 1 FROM cinatoken_economic_outbox.shared_key_economic_events
      WHERE request_log_id=p_request_log_id) THEN
    UPDATE cinatoken_economic_orphan_review.jobs SET
      status='resolved_event',revision=revision+1,dead_at=NULL,
      resolved_at=pg_catalog.clock_timestamp(),last_action='event_resolved',
      last_operation_token=NULL,last_reason_code=NULL
      WHERE jobs.request_log_id=p_request_log_id;
    RETURN 'resolved_event';
  END IF;
  UPDATE cinatoken_economic_orphan_review.jobs SET
    status='pending',revision=revision+1,lease_attempt_count=0,
    recovery_count=recovery_count+1,dead_at=NULL,
    next_attempt_at=pg_catalog.clock_timestamp(),
    last_action='dead_letter_requeued',
    last_operation_token=p_recovery_token,last_reason_code=p_reason_code
    WHERE jobs.request_log_id=p_request_log_id;
  RETURN 'requeued';
END;
$requeue$;

REVOKE ALL ON ALL TABLES IN SCHEMA cinatoken_economic_orphan_review
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_shared_quote_attempt_producer,
    cinatoken_gateway_shared_orphan_worker,
    cinatoken_gateway_shared_orphan_recovery;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cinatoken_economic_orphan_review
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_shared_quote_attempt_producer,
    cinatoken_gateway_shared_orphan_worker,
    cinatoken_gateway_shared_orphan_recovery;
GRANT USAGE ON SCHEMA cinatoken_economic_orphan_review
  TO cinatoken_gateway_shared_orphan_worker,
    cinatoken_gateway_shared_orphan_recovery;
GRANT EXECUTE ON FUNCTION
  cinatoken_economic_orphan_review.list_due(timestamptz,text,integer,integer),
  cinatoken_economic_orphan_review.claim_job(text,uuid,integer,integer),
  cinatoken_economic_orphan_review.fail_job(text,uuid,text,integer)
  TO cinatoken_gateway_shared_orphan_worker;
GRANT EXECUTE ON FUNCTION
  cinatoken_economic_orphan_review.requeue_dead_letter(text,uuid,text)
  TO cinatoken_gateway_shared_orphan_recovery;

DO $postflight$
DECLARE migrator_oid oid;
DECLARE worker_oid oid;
DECLARE recovery_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO worker_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_orphan_worker';
  SELECT oid INTO recovery_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_orphan_recovery';
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger WHERE
      (tgrelid='cinatoken_economic_quotes.shared_key_dispatch_quote_attempts'::pg_catalog.regclass
        AND tgname='shared_quote_attempts_enqueue_orphan_review'
        AND tgfoid='cinatoken_economic_orphan_review.enqueue_claim()'::pg_catalog.regprocedure)
      OR (tgrelid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
        AND tgname='shared_key_economic_events_resolve_orphan_review'
        AND tgfoid='cinatoken_economic_orphan_review.resolve_event()'::pg_catalog.regprocedure))<>2
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE
      tgname IN ('shared_quote_attempts_enqueue_orphan_review',
        'shared_key_economic_events_resolve_orphan_review') AND tgenabled<>'O')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger WHERE
      tgrelid IN ('cinatoken_economic_orphan_review.jobs'::pg_catalog.regclass,
        'cinatoken_economic_orphan_review.job_audit'::pg_catalog.regclass)
      AND tgname IN ('orphan_review_jobs_guard_update','orphan_review_jobs_audit',
        'orphan_review_audit_no_change','orphan_review_audit_no_truncate')
      AND tgenabled='O')<>4
    OR EXISTS (SELECT 1 FROM cinatoken_economic_quotes.shared_key_dispatch_quote_attempts a
      LEFT JOIN cinatoken_economic_orphan_review.jobs j
        ON j.request_log_id=a.request_log_id
      WHERE j.request_log_id IS NULL)
    OR EXISTS (SELECT 1 FROM cinatoken_economic_orphan_review.jobs j
      WHERE j.claim_count<>(SELECT pg_catalog.count(*) FROM
        cinatoken_economic_quotes.shared_key_dispatch_quote_attempts a
        WHERE a.request_log_id=j.request_log_id))
    OR pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      'cinatoken_economic_orphan_review.jobs','SELECT')
    OR pg_catalog.has_table_privilege('cinatoken_gateway_shared_orphan_worker',
      'cinatoken_economic_orphan_review.jobs','UPDATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) acl
      WHERE n.nspname='cinatoken_economic_orphan_review'
        AND acl.grantee NOT IN (migrator_oid,worker_oid,recovery_oid))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
      WHERE c.relnamespace='cinatoken_economic_orphan_review'::pg_catalog.regnamespace
        AND acl.grantee<>migrator_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.pronamespace='cinatoken_economic_orphan_review'::pg_catalog.regnamespace
        AND acl.grantee NOT IN (migrator_oid,worker_oid,recovery_oid))
  THEN
    RAISE EXCEPTION 'Orphan review trigger, coverage or ACL differs';
  END IF;
END;
$postflight$;
