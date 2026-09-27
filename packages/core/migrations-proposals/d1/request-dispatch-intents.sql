-- LOCAL PROPOSAL ONLY. Not discovered by the production migration runner.
-- This is execution evidence, not a funds ledger or a reusable dispatch permit.
CREATE TABLE request_dispatch_intents (
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 200),
  attempt_index INTEGER NOT NULL CHECK(typeof(attempt_index) = 'integer' AND attempt_index BETWEEN 1 AND 32),
  user_id TEXT NOT NULL REFERENCES users(id),
  api_key_id TEXT NOT NULL REFERENCES api_keys(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  operation TEXT NOT NULL CHECK(operation IN ('images.generations', 'images.edits')),
  context_sha256 TEXT NOT NULL CHECK(length(context_sha256) = 64 AND context_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('prepared', 'dispatch_claimed', 'expired_before_dispatch', 'outcome_unknown')),
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991),
  dispatch_claim_id TEXT UNIQUE,
  expires_at_ms INTEGER NOT NULL CHECK(typeof(expires_at_ms) = 'integer' AND expires_at_ms BETWEEN 0 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL CHECK(typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK(typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN created_at_ms AND 9007199254740991),
  claimed_at_ms INTEGER,
  PRIMARY KEY (request_id, attempt_index),
  CHECK(expires_at_ms > created_at_ms),
  CHECK(
    (state IN ('prepared', 'expired_before_dispatch') AND dispatch_claim_id IS NULL AND claimed_at_ms IS NULL)
    OR (state IN ('dispatch_claimed', 'outcome_unknown') AND dispatch_claim_id IS NOT NULL AND length(dispatch_claim_id) = 36
      AND claimed_at_ms IS NOT NULL AND typeof(claimed_at_ms) = 'integer'
      AND claimed_at_ms >= created_at_ms AND claimed_at_ms < expires_at_ms AND claimed_at_ms <= updated_at_ms)
  ),
  CHECK(state IN ('prepared', 'dispatch_claimed') OR updated_at_ms >= expires_at_ms)
);
CREATE INDEX request_dispatch_intents_recovery
  ON request_dispatch_intents(user_id, workspace_id, state, expires_at_ms, request_id, attempt_index);

CREATE TRIGGER request_dispatch_intents_forward_only BEFORE UPDATE ON request_dispatch_intents
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.attempt_index IS NOT OLD.attempt_index
  OR NEW.user_id IS NOT OLD.user_id OR NEW.api_key_id IS NOT OLD.api_key_id
  OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.operation IS NOT OLD.operation
  OR NEW.context_sha256 IS NOT OLD.context_sha256 OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
  OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.updated_at_ms < OLD.updated_at_ms
  OR NEW.revision != OLD.revision + 1
  OR NOT ((OLD.state='prepared' AND NEW.state IN ('dispatch_claimed','expired_before_dispatch'))
    OR (OLD.state='dispatch_claimed' AND NEW.state='outcome_unknown'
      AND NEW.dispatch_claim_id IS OLD.dispatch_claim_id AND NEW.claimed_at_ms IS OLD.claimed_at_ms))
BEGIN
  SELECT RAISE(ABORT, 'Invalid dispatch intent transition');
END;
