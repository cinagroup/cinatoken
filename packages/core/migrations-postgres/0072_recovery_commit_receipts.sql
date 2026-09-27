-- Expand-only fenced receipts after 0071. C03 remains disabled.
-- The migrator's transaction fails promptly on contested catalog/FK locks.
SET LOCAL lock_timeout = '2s';

-- Atomic receipt for the existing critical writer, NOT a new funds/price policy.
CREATE TABLE cinatoken_gateway.request_usage_commit_receipts (
  request_id text PRIMARY KEY REFERENCES cinatoken_gateway.request_usage_recovery_jobs(request_id),
  payload_sha256 text NOT NULL,
  user_id text NOT NULL,
  workspace_id text NOT NULL,
  fact_created_at_ms bigint NOT NULL DEFAULT 0,
  recorded_at text NOT NULL,
  lease_token text NOT NULL CHECK (lease_token COLLATE "C" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  lease_revision bigint NOT NULL CHECK (lease_revision BETWEEN 1 AND 9007199254740990),
  lease_attempts integer NOT NULL DEFAULT 0 CHECK (lease_attempts BETWEEN 1 AND 5),
  lease_expires_at_ms bigint NOT NULL DEFAULT 0 CHECK (lease_expires_at_ms BETWEEN 0 AND 9007199254740991),
  created_at_ms bigint NOT NULL DEFAULT 0 CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (request_id,payload_sha256,fact_created_at_ms,user_id,workspace_id)
    REFERENCES cinatoken_gateway.request_usage_settlements(request_id,payload_sha256,created_at_ms,user_id,workspace_id),
  -- Receipt is inserted BEFORE the log; both must exist by COMMIT.
  FOREIGN KEY (request_id) REFERENCES cinatoken_gateway.api_key_request_logs(id) DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE cinatoken_gateway.request_usage_recovery_jobs
  DROP CONSTRAINT request_usage_recovery_jobs_state_check,
  DROP CONSTRAINT request_usage_recovery_jobs_last_transition_check,
  DROP CONSTRAINT request_usage_recovery_jobs_lifecycle_initial,
  ADD CONSTRAINT request_usage_recovery_jobs_state_check CHECK(state IN ('pending','leased','blocked','committed')),
  ADD CONSTRAINT request_usage_recovery_jobs_last_transition_check CHECK(last_transition IN ('enqueued','claimed','failed','exhausted','committed')),
  ADD CONSTRAINT request_usage_recovery_jobs_lifecycle CHECK (
    (state='pending' AND attempts<5 AND lease_token IS NULL AND lease_seconds IS NULL AND lease_expires_at_ms IS NULL
      AND available_at_ms IS NOT NULL AND available_at_ms>=updated_at_ms
      AND ((attempts=0 AND revision=0 AND last_transition='enqueued' AND last_error IS NULL)
        OR (attempts>0 AND last_transition='failed' AND last_error IN ('execution_error','interrupted'))))
    OR (state='leased' AND attempts>0 AND revision>0 AND last_transition='claimed' AND last_error IS NULL
      AND lease_token IS NOT NULL AND lease_seconds IS NOT NULL AND lease_expires_at_ms IS NOT NULL
      AND lease_expires_at_ms=updated_at_ms+lease_seconds*1000 AND available_at_ms IS NOT NULL AND available_at_ms=lease_expires_at_ms)
    OR (state='blocked' AND attempts>0 AND revision>0 AND last_transition IN ('failed','exhausted') AND last_error IS NOT NULL
      AND lease_token IS NULL AND lease_seconds IS NULL AND lease_expires_at_ms IS NULL AND available_at_ms IS NULL)
    OR (state='committed' AND attempts>0 AND revision>0 AND last_transition='committed' AND last_error IS NULL
      AND lease_token IS NULL AND lease_seconds IS NULL AND lease_expires_at_ms IS NULL AND available_at_ms IS NULL)
  );

CREATE FUNCTION cinatoken_gateway.guard_usage_commit_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $receipt$
DECLARE job record; checked_at_ms bigint;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Settlement receipt is immutable'; END IF;
  IF NEW.fact_created_at_ms IS DISTINCT FROM 0 OR NEW.lease_attempts IS DISTINCT FROM 0
    OR NEW.lease_expires_at_ms IS DISTINCT FROM 0 OR NEW.created_at_ms IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Receipt accounting metadata is database-owned';
  END IF;
  SELECT j.*,s.recorded_at INTO job FROM cinatoken_gateway.request_usage_recovery_jobs j
    JOIN cinatoken_gateway.request_usage_settlements s ON s.request_id=j.request_id AND s.payload_sha256=j.payload_sha256
    WHERE j.request_id=NEW.request_id AND j.payload_sha256=NEW.payload_sha256
      AND j.user_id=NEW.user_id AND j.workspace_id=NEW.workspace_id FOR UPDATE OF j;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt recovery identity missing'; END IF;
  -- Sample AFTER the potentially blocking row lock, never transaction_timestamp().
  checked_at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF job.state IS DISTINCT FROM 'leased' OR job.revision IS DISTINCT FROM NEW.lease_revision
    OR job.lease_token IS DISTINCT FROM NEW.lease_token OR job.lease_expires_at_ms<=checked_at_ms
    OR checked_at_ms<job.updated_at_ms OR job.recorded_at IS DISTINCT FROM NEW.recorded_at THEN
    RAISE EXCEPTION 'Settlement recovery lease invalid';
  END IF;
  IF EXISTS(SELECT 1 FROM cinatoken_gateway.api_key_request_logs WHERE id=NEW.request_id) THEN
    RAISE EXCEPTION 'Legacy log cannot be adopted as a settlement receipt';
  END IF;
  NEW.fact_created_at_ms:=job.fact_created_at_ms; NEW.lease_attempts:=job.attempts;
  NEW.lease_expires_at_ms:=job.lease_expires_at_ms; NEW.created_at_ms:=checked_at_ms;
  RETURN NEW;
END;
$receipt$;
REVOKE ALL ON FUNCTION cinatoken_gateway.guard_usage_commit_receipt() FROM PUBLIC;
CREATE TRIGGER request_usage_commit_receipts_guard BEFORE INSERT OR UPDATE OR DELETE
  ON cinatoken_gateway.request_usage_commit_receipts FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.guard_usage_commit_receipt();

CREATE OR REPLACE FUNCTION cinatoken_gateway.guard_usage_recovery_job() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $guard$
DECLARE checked_at_ms bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Recovery job deletion is forbidden'; END IF;
  checked_at_ms := floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF TG_OP='INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'pending' OR NEW.revision IS DISTINCT FROM 0 OR NEW.attempts IS DISTINCT FROM 0
      OR NEW.last_transition IS DISTINCT FROM 'enqueued' OR NEW.last_error IS NOT NULL OR NEW.lease_token IS NOT NULL
      OR NEW.lease_seconds IS NOT NULL OR NEW.lease_expires_at_ms IS NOT NULL OR NEW.available_at_ms IS NOT NULL
      OR NEW.created_at_ms IS DISTINCT FROM 0 OR NEW.updated_at_ms IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'Invalid initial recovery job';
    END IF;
    NEW.created_at_ms:=checked_at_ms; NEW.updated_at_ms:=checked_at_ms; NEW.available_at_ms:=checked_at_ms;
    RETURN NEW;
  END IF;
  IF ROW(NEW.request_id,NEW.payload_sha256,NEW.fact_created_at_ms,NEW.user_id,NEW.workspace_id,NEW.created_at_ms)
      IS DISTINCT FROM ROW(OLD.request_id,OLD.payload_sha256,OLD.fact_created_at_ms,OLD.user_id,OLD.workspace_id,OLD.created_at_ms)
    OR NEW.revision IS DISTINCT FROM OLD.revision+1
    OR NEW.updated_at_ms IS DISTINCT FROM OLD.updated_at_ms
    OR NEW.available_at_ms IS DISTINCT FROM OLD.available_at_ms
    OR NEW.lease_expires_at_ms IS DISTINCT FROM OLD.lease_expires_at_ms
    OR OLD.state IN ('blocked','committed') THEN RAISE EXCEPTION 'Immutable recovery identity or invalid transition'; END IF;
  -- A wall-clock regression below the last mutation never extends ownership or permits a write.
  IF checked_at_ms < OLD.updated_at_ms THEN RETURN NULL; END IF;

  IF NEW.last_transition='committed' THEN
    IF OLD.state IS DISTINCT FROM 'leased' OR NEW.state IS DISTINCT FROM 'committed'
      OR NEW.attempts IS DISTINCT FROM OLD.attempts OR NEW.lease_token IS NOT NULL OR NEW.lease_seconds IS NOT NULL
      OR NEW.last_error IS NOT NULL THEN RAISE EXCEPTION 'Invalid recovery completion'; END IF;
    IF OLD.lease_expires_at_ms<=checked_at_ms THEN RETURN NULL; END IF;
    IF NOT EXISTS (SELECT 1 FROM cinatoken_gateway.request_usage_commit_receipts r
      WHERE r.request_id=OLD.request_id AND r.payload_sha256=OLD.payload_sha256
        AND r.lease_token=OLD.lease_token AND r.lease_revision=OLD.revision
        AND r.lease_expires_at_ms=OLD.lease_expires_at_ms AND r.lease_attempts=OLD.attempts) THEN
      RAISE EXCEPTION 'Recovery completion requires the same fenced receipt';
    END IF;
    NEW.lease_expires_at_ms:=NULL; NEW.available_at_ms:=NULL;
  ELSIF NEW.last_transition='claimed' THEN
    IF OLD.state NOT IN ('pending','leased') OR OLD.attempts>=5 OR NEW.state IS DISTINCT FROM 'leased'
      OR NEW.attempts IS DISTINCT FROM OLD.attempts+1 OR NEW.lease_token IS NULL OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
      OR NEW.lease_seconds IS NULL OR NEW.lease_seconds NOT BETWEEN 1 AND 300 OR NEW.last_error IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid recovery claim';
    END IF;
    IF OLD.available_at_ms>checked_at_ms THEN RETURN NULL; END IF;
    NEW.lease_expires_at_ms:=checked_at_ms+NEW.lease_seconds*1000;
    NEW.available_at_ms:=NEW.lease_expires_at_ms;
  ELSIF NEW.last_transition='exhausted' THEN
    IF OLD.state IS DISTINCT FROM 'leased' OR OLD.attempts IS DISTINCT FROM 5 OR NEW.attempts IS DISTINCT FROM 5
      OR NEW.state IS DISTINCT FROM 'blocked' OR NEW.last_error IS DISTINCT FROM 'retry_exhausted'
      OR NEW.lease_token IS NOT NULL OR NEW.lease_seconds IS NOT NULL THEN RAISE EXCEPTION 'Invalid recovery exhaustion'; END IF;
    IF OLD.available_at_ms>checked_at_ms THEN RETURN NULL; END IF;
    NEW.lease_expires_at_ms:=NULL; NEW.available_at_ms:=NULL;
  ELSIF NEW.last_transition='failed' THEN
    IF OLD.state IS DISTINCT FROM 'leased' OR NEW.attempts IS DISTINCT FROM OLD.attempts
      OR NEW.lease_token IS NOT NULL OR NEW.lease_seconds IS NOT NULL THEN RAISE EXCEPTION 'Invalid recovery failure'; END IF;
    -- Distinct from exhausted: an expired old worker cannot report failure, even on its fifth
    -- claim and even before another owner takes over. The caller also binds the OLD token/revision.
    IF OLD.lease_expires_at_ms<=checked_at_ms THEN RETURN NULL; END IF;
    IF NEW.state='pending' AND OLD.attempts<5 AND NEW.last_error IN ('execution_error','interrupted') THEN
      NEW.available_at_ms:=checked_at_ms+5000*(1 << (OLD.attempts-1));
    ELSIF NEW.state='blocked' AND (NEW.last_error IN ('snapshot_invalid','settlement_conflict')
      OR (OLD.attempts=5 AND NEW.last_error='retry_exhausted')) THEN
      NEW.available_at_ms:=NULL;
    ELSE RAISE EXCEPTION 'Invalid recovery failure policy'; END IF;
    NEW.lease_expires_at_ms:=NULL;
  ELSE RAISE EXCEPTION 'Unsupported recovery transition'; END IF;
  NEW.updated_at_ms:=checked_at_ms;
  RETURN NEW;
END;
$guard$;

-- Verification-only compatibility with the existing JS money writer. Numeric round(raw,6)
-- is NOT equivalent to Math.round(raw*1e6)/1e6 at binary half boundaries. Do not change the
-- historical amount to make receipt verification pass. Scope is nonnegative v1 DTO amounts.
CREATE FUNCTION cinatoken_gateway.usage_round_nonnegative_v1(v double precision) RETURNS double precision
LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $round$
DECLARE whole double precision;
BEGIN
  IF v NOT BETWEEN 0 AND 9007199254740992::double precision THEN RAISE EXCEPTION 'Invalid v1 money magnitude'; END IF;
  whole:=floor(v);
  -- floor(v+0.5) is also wrong near the safe-integer boundary; inspect the fraction instead.
  IF v-whole>=0.5 THEN whole:=whole+1; END IF;
  RETURN whole;
END;
$round$;
REVOKE ALL ON FUNCTION cinatoken_gateway.usage_round_nonnegative_v1(double precision) FROM PUBLIC;
CREATE FUNCTION cinatoken_gateway.usage_money_v1(v text) RETURNS numeric
LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog,pg_temp SET extra_float_digits=3 AS $money$
  SELECT round(((cinatoken_gateway.usage_round_nonnegative_v1(v::double precision*1000000::double precision)
    /1000000::double precision)::text)::numeric,6)
$money$;
REVOKE ALL ON FUNCTION cinatoken_gateway.usage_money_v1(text) FROM PUBLIC;
CREATE FUNCTION cinatoken_gateway.usage_budget_units_v1(v text) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $units$
DECLARE scaled double precision;
BEGIN
  scaled:=(cinatoken_gateway.usage_round_nonnegative_v1(v::double precision*1000000::double precision)/1000000::double precision)*1000000::double precision;
  IF scaled>=9007199254740991::double precision THEN RETURN 9007199254740991; END IF;
  RETURN cinatoken_gateway.usage_round_nonnegative_v1(scaled)::bigint;
END;
$units$;
REVOKE ALL ON FUNCTION cinatoken_gateway.usage_budget_units_v1(text) FROM PUBLIC;

CREATE FUNCTION cinatoken_gateway.usage_commit_matches(request_ref text, digest_ref text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $match$
  SELECT EXISTS(
    SELECT 1 FROM cinatoken_gateway.request_usage_commit_receipts r
    JOIN cinatoken_gateway.request_usage_settlements s ON s.request_id=r.request_id AND s.payload_sha256=r.payload_sha256
    JOIN cinatoken_gateway.request_usage_recovery_jobs j ON j.request_id=r.request_id AND j.payload_sha256=r.payload_sha256
    JOIN cinatoken_gateway.api_key_request_logs l ON l.id=r.request_id
    CROSS JOIN LATERAL (SELECT s.payload_json::json->'params' AS p) snapshot
    WHERE r.request_id=request_ref AND r.payload_sha256=digest_ref
      AND r.user_id=s.user_id AND r.workspace_id=s.workspace_id AND r.fact_created_at_ms=s.created_at_ms
      AND r.recorded_at=s.recorded_at AND j.state='committed' AND j.last_transition='committed'
      AND j.revision=r.lease_revision+1 AND j.attempts=r.lease_attempts
      AND l.user_id=s.user_id AND l.api_key_id=s.api_key_id AND l.workspace_id=s.workspace_id
      AND l.request_operation=s.operation AND l.created_at=s.recorded_at::timestamptz
      AND l.model_id=snapshot.p->'requestLog'->>'modelId' AND l.provider_id=snapshot.p->'requestLog'->>'providerId'
      AND l.status=snapshot.p->'requestLog'->>'status'
      AND l.charged_cost=cinatoken_gateway.usage_money_v1(snapshot.p->>'chargedCost')
      AND l.standard_cost=cinatoken_gateway.usage_money_v1(snapshot.p->'requestLog'->>'standardCost')
      AND l.metered_cost=cinatoken_gateway.usage_money_v1(snapshot.p->'requestLog'->>'meteredCost')
      AND l.budget_charged_micros=CASE WHEN (snapshot.p->>'shouldChargeBudget')::boolean
        THEN cinatoken_gateway.usage_budget_units_v1(snapshot.p->>'chargedCost') ELSE 0 END
      AND l.input_tokens=(snapshot.p->'requestLog'->>'inputTokens')::bigint
      AND l.output_tokens=(snapshot.p->'requestLog'->>'outputTokens')::bigint
      AND l.total_tokens=(snapshot.p->'requestLog'->>'totalTokens')::bigint
  )
$match$;
REVOKE ALL ON FUNCTION cinatoken_gateway.usage_commit_matches(text,text) FROM PUBLIC;

CREATE FUNCTION cinatoken_gateway.check_usage_commit_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $check$
DECLARE checked_at_ms bigint;
BEGIN
  checked_at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF checked_at_ms>=NEW.lease_expires_at_ms OR checked_at_ms<NEW.created_at_ms THEN
    RAISE EXCEPTION 'Settlement lease expired before deferred transaction validation';
  END IF;
  IF NOT cinatoken_gateway.usage_commit_matches(NEW.request_id,NEW.payload_sha256) THEN
    RAISE EXCEPTION 'Settlement receipt, log and job are not one confirmed transaction';
  END IF;
  RETURN NULL;
END;
$check$;
REVOKE ALL ON FUNCTION cinatoken_gateway.check_usage_commit_transaction() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER request_usage_commit_transaction_check AFTER INSERT ON cinatoken_gateway.request_usage_commit_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.check_usage_commit_transaction();

-- The legacy api_key_request_logs INSERT guard remains outside automatic migrations.
-- C03 recovery readiness stays closed until an explicit controlled activation supplies it.
-- No backfill, grants, external queue, scheduler or new financial policy.
DO $recovery_runtime_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime') THEN
    EXECUTE 'REVOKE ALL ON TABLE cinatoken_gateway.request_usage_commit_receipts FROM cinatoken_gateway_runtime';
  END IF;
END;
$recovery_runtime_acl$;
