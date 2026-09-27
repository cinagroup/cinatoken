-- LOCAL PROPOSAL ONLY: deliberately outside migrations-postgres and production factories.
-- Execution evidence, NOT a budget ledger, authorization service or replay permission.
-- Apply once in a transaction, after the existing PostgreSQL schema. No role creation.
CREATE TABLE cinatoken_gateway.request_dispatch_intents (
  request_id text NOT NULL CHECK (request_id COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  attempt_index integer NOT NULL CHECK (attempt_index BETWEEN 1 AND 32),
  user_id text NOT NULL REFERENCES cinatoken_gateway.users(id) ON DELETE RESTRICT
    CHECK (user_id COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  api_key_id text NOT NULL REFERENCES cinatoken_gateway.api_keys(id) ON DELETE RESTRICT
    CHECK (api_key_id COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  workspace_id text NOT NULL REFERENCES cinatoken_gateway.workspaces(id) ON DELETE RESTRICT
    CHECK (workspace_id COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  operation text NOT NULL CHECK (operation IN ('images.generations', 'images.edits')),
  context_sha256 text NOT NULL CHECK (context_sha256 COLLATE "C" ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared', 'dispatch_claimed', 'expired_before_dispatch', 'outcome_unknown')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  dispatch_claim_id text UNIQUE
    CHECK (dispatch_claim_id COLLATE "C" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms BETWEEN 0 AND 9007199254740991),
  -- Written only by the guard below, using the database clock after any row-lock wait.
  created_at_ms bigint NOT NULL DEFAULT 0 CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms bigint NOT NULL DEFAULT 0 CHECK (updated_at_ms BETWEEN created_at_ms AND 9007199254740991),
  claimed_at_ms bigint,
  PRIMARY KEY (request_id, attempt_index),
  CHECK (expires_at_ms > created_at_ms),
  CHECK (
    (state IN ('prepared', 'expired_before_dispatch') AND dispatch_claim_id IS NULL AND claimed_at_ms IS NULL)
    OR (state IN ('dispatch_claimed', 'outcome_unknown') AND dispatch_claim_id IS NOT NULL
      AND claimed_at_ms IS NOT NULL AND claimed_at_ms >= created_at_ms
      AND claimed_at_ms < expires_at_ms AND claimed_at_ms <= updated_at_ms)
  ),
  CHECK (state IN ('prepared', 'dispatch_claimed') OR updated_at_ms >= expires_at_ms)
);

-- Equality scope first; deadline and deterministic key order next. Terminal rows do not grow this index.
CREATE INDEX request_dispatch_intents_recovery
  ON cinatoken_gateway.request_dispatch_intents(user_id, workspace_id, expires_at_ms, request_id, attempt_index)
  WHERE state IN ('prepared', 'dispatch_claimed');
-- FK lookups must include terminal history too; the partial recovery index cannot replace these.
CREATE INDEX request_dispatch_intents_user ON cinatoken_gateway.request_dispatch_intents(user_id);
CREATE INDEX request_dispatch_intents_api_key ON cinatoken_gateway.request_dispatch_intents(api_key_id);
CREATE INDEX request_dispatch_intents_workspace ON cinatoken_gateway.request_dispatch_intents(workspace_id);

CREATE FUNCTION cinatoken_gateway.guard_request_dispatch_intent() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $guard$
DECLARE checked_at_ms bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'prepared' OR NEW.revision IS DISTINCT FROM 0
      OR NEW.dispatch_claim_id IS NOT NULL OR NEW.claimed_at_ms IS NOT NULL
      OR NEW.created_at_ms IS DISTINCT FROM 0 OR NEW.updated_at_ms IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'Invalid initial dispatch intent';
    END IF;
    -- Freeze the association at creation, not permission to dispatch. FOR SHARE prevents
    -- a concurrent key ownership/workspace change from overtaking this check before commit.
    PERFORM 1 FROM cinatoken_gateway.api_keys
      WHERE id = NEW.api_key_id AND user_id = NEW.user_id AND workspace_id = NEW.workspace_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch intent scope mismatch'; END IF;
    checked_at_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    IF NEW.expires_at_ms <= checked_at_ms THEN RAISE EXCEPTION 'Dispatch intent deadline elapsed'; END IF;
    NEW.created_at_ms := checked_at_ms;
    NEW.updated_at_ms := checked_at_ms;
    RETURN NEW;
  END IF;

  IF ROW(NEW.request_id, NEW.attempt_index, NEW.user_id, NEW.api_key_id, NEW.workspace_id,
      NEW.operation, NEW.context_sha256, NEW.expires_at_ms, NEW.created_at_ms)
    IS DISTINCT FROM ROW(OLD.request_id, OLD.attempt_index, OLD.user_id, OLD.api_key_id, OLD.workspace_id,
      OLD.operation, OLD.context_sha256, OLD.expires_at_ms, OLD.created_at_ms)
    OR NEW.revision IS DISTINCT FROM OLD.revision + 1
    OR NEW.updated_at_ms IS DISTINCT FROM OLD.updated_at_ms
    OR NEW.claimed_at_ms IS DISTINCT FROM OLD.claimed_at_ms THEN
    RAISE EXCEPTION 'Immutable dispatch intent or invalid revision';
  END IF;
  checked_at_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  -- Clock rollback fails closed. No synthetic advancement of a dispatch deadline.
  IF checked_at_ms < OLD.updated_at_ms THEN RETURN NULL; END IF;
  IF OLD.state = 'prepared' AND NEW.state = 'dispatch_claimed' THEN
    IF checked_at_ms >= OLD.expires_at_ms THEN RETURN NULL; END IF;
    NEW.claimed_at_ms := checked_at_ms;
  ELSIF OLD.state = 'prepared' AND NEW.state = 'expired_before_dispatch' THEN
    IF checked_at_ms < OLD.expires_at_ms THEN RETURN NULL; END IF;
  ELSIF OLD.state = 'dispatch_claimed' AND NEW.state = 'outcome_unknown'
    AND NEW.dispatch_claim_id IS NOT DISTINCT FROM OLD.dispatch_claim_id THEN
    IF checked_at_ms < OLD.expires_at_ms THEN RETURN NULL; END IF;
  ELSE
    RAISE EXCEPTION 'Invalid dispatch intent transition';
  END IF;
  NEW.updated_at_ms := checked_at_ms;
  RETURN NEW;
END;
$guard$;
REVOKE ALL ON FUNCTION cinatoken_gateway.guard_request_dispatch_intent() FROM PUBLIC;
CREATE TRIGGER request_dispatch_intents_guard BEFORE INSERT OR UPDATE
  ON cinatoken_gateway.request_dispatch_intents
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.guard_request_dispatch_intent();

-- Retention, role/RLS deployment and legacy key/workspace deletion compatibility are C03 gates.
-- No runtime DELETE API; a future application role must not get DELETE/TRUNCATE/DDL privileges.
