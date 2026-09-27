-- Expand-only recovery jobs after 0070. C03 remains disabled.
-- The migrator's transaction fails promptly on contested catalog/FK locks.
SET LOCAL lock_timeout = '2s';

-- No financial completion/receipt yet. No scheduling, grants or backfill.
-- Full dispatch identity is reached through the immutable fact; duplicate scope columns support
-- bounded tenant scans and are bound by this composite FK, never trusted independently.
ALTER TABLE cinatoken_gateway.request_usage_settlements
  ADD CONSTRAINT request_usage_settlements_job_scope UNIQUE
    (request_id, payload_sha256, created_at_ms, user_id, workspace_id);

CREATE TABLE cinatoken_gateway.request_usage_recovery_jobs (
  request_id text PRIMARY KEY,
  payload_sha256 text NOT NULL,
  fact_created_at_ms bigint NOT NULL,
  user_id text NOT NULL,
  workspace_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','blocked')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  -- Disabled-prototype policy, aligned with D1; NOT approval of C01.10 production parameters.
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  last_transition text NOT NULL DEFAULT 'enqueued' CHECK (last_transition IN ('enqueued','claimed','failed','exhausted')),
  lease_token text UNIQUE CHECK (lease_token COLLATE "C" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  lease_seconds integer CHECK (lease_seconds BETWEEN 1 AND 300),
  lease_expires_at_ms bigint CHECK (lease_expires_at_ms BETWEEN 0 AND 9007199254740991),
  available_at_ms bigint CHECK (available_at_ms BETWEEN 0 AND 9007199254740991),
  last_error text CHECK (last_error IN ('execution_error','interrupted','snapshot_invalid','settlement_conflict','retry_exhausted')),
  created_at_ms bigint NOT NULL DEFAULT 0 CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms bigint NOT NULL DEFAULT 0 CHECK (updated_at_ms BETWEEN created_at_ms AND 9007199254740991),
  FOREIGN KEY (request_id, payload_sha256, fact_created_at_ms, user_id, workspace_id)
    REFERENCES cinatoken_gateway.request_usage_settlements(request_id, payload_sha256, created_at_ms, user_id, workspace_id),
  CONSTRAINT request_usage_recovery_jobs_lifecycle_initial CHECK (
    (state='pending' AND attempts<5 AND lease_token IS NULL AND lease_seconds IS NULL AND lease_expires_at_ms IS NULL
      AND available_at_ms IS NOT NULL AND available_at_ms>=updated_at_ms
      AND ((attempts=0 AND revision=0 AND last_transition='enqueued' AND last_error IS NULL)
        OR (attempts>0 AND last_transition='failed' AND last_error IN ('execution_error','interrupted'))))
    OR (state='leased' AND attempts>0 AND revision>0 AND last_transition='claimed' AND last_error IS NULL
      AND lease_token IS NOT NULL AND lease_seconds IS NOT NULL AND lease_expires_at_ms IS NOT NULL
      AND lease_expires_at_ms=updated_at_ms+lease_seconds*1000 AND available_at_ms IS NOT NULL AND available_at_ms=lease_expires_at_ms)
    OR (state='blocked' AND attempts>0 AND revision>0 AND last_transition IN ('failed','exhausted') AND last_error IS NOT NULL
      AND lease_token IS NULL AND lease_seconds IS NULL AND lease_expires_at_ms IS NULL AND available_at_ms IS NULL)
  )
);
CREATE INDEX request_usage_recovery_due ON cinatoken_gateway.request_usage_recovery_jobs(available_at_ms,request_id)
  WHERE state IN ('pending','leased');
CREATE INDEX request_usage_recovery_tenant_due ON cinatoken_gateway.request_usage_recovery_jobs(user_id,workspace_id,available_at_ms,request_id)
  WHERE state IN ('pending','leased');

CREATE FUNCTION cinatoken_gateway.guard_usage_recovery_job() RETURNS trigger
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
    OR OLD.state='blocked' THEN RAISE EXCEPTION 'Immutable recovery identity or invalid transition'; END IF;
  -- A wall-clock regression below the last mutation never extends ownership or permits a write.
  IF checked_at_ms < OLD.updated_at_ms THEN RETURN NULL; END IF;

  IF NEW.last_transition='claimed' THEN
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
REVOKE ALL ON FUNCTION cinatoken_gateway.guard_usage_recovery_job() FROM PUBLIC;
CREATE TRIGGER request_usage_recovery_guard BEFORE INSERT OR UPDATE OR DELETE ON cinatoken_gateway.request_usage_recovery_jobs
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.guard_usage_recovery_job();

-- Missing jobs are reconstructed from the durable outbox using bounded anti-join scans, without
-- a timestamp watermark. A blocked job is never recreated. No new fact can exist without outbox
-- under the prior proposal. This step does NOT complete/charge any historical event.
-- Production roles must prohibit DDL/TRUNCATE/trigger disabling and restrict mutation access.
DO $recovery_runtime_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime') THEN
    EXECUTE 'REVOKE ALL ON TABLE cinatoken_gateway.request_usage_recovery_jobs FROM cinatoken_gateway_runtime';
  END IF;
END;
$recovery_runtime_acl$;
