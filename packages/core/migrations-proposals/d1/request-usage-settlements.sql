-- LOCAL PROPOSAL ONLY. Requires request-dispatch-intents.sql; not an automatic migration.
-- Post-result accounting inputs, not a pre-dispatch quote or a new financial ledger.
CREATE TABLE request_usage_settlements (
  request_id TEXT PRIMARY KEY NOT NULL,
  attempt_index INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  api_key_id TEXT NOT NULL REFERENCES api_keys(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  operation TEXT NOT NULL CHECK(operation IN ('images.generations','images.edits')),
  context_sha256 TEXT NOT NULL,
  dispatch_claim_id TEXT NOT NULL,
  payload_version INTEGER NOT NULL CHECK(typeof(payload_version)='integer' AND payload_version=1),
  payload_json TEXT NOT NULL CHECK(typeof(payload_json)='text' AND length(CAST(payload_json AS BLOB)) BETWEEN 1 AND 262144 AND json_valid(payload_json)),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^a-f0-9]*'),
  recorded_at TEXT NOT NULL CHECK(length(recorded_at)=24),
  FOREIGN KEY(request_id,attempt_index) REFERENCES request_dispatch_intents(request_id,attempt_index),
  UNIQUE(request_id,payload_sha256,recorded_at)
);
CREATE INDEX request_usage_settlements_scope ON request_usage_settlements(user_id,workspace_id,request_id);
CREATE TRIGGER request_usage_settlements_claim BEFORE INSERT ON request_usage_settlements
WHEN NOT EXISTS (
  SELECT 1 FROM request_dispatch_intents i
  WHERE i.request_id=NEW.request_id AND i.attempt_index=NEW.attempt_index
    AND i.user_id=NEW.user_id AND i.api_key_id=NEW.api_key_id AND i.workspace_id=NEW.workspace_id
    AND i.operation=NEW.operation AND i.context_sha256=NEW.context_sha256
    AND i.dispatch_claim_id=NEW.dispatch_claim_id AND i.state IN ('dispatch_claimed','outcome_unknown')
)
BEGIN SELECT RAISE(ABORT,'Settlement dispatch identity conflict'); END;
CREATE TRIGGER request_usage_settlements_immutable BEFORE UPDATE ON request_usage_settlements
BEGIN SELECT RAISE(ABORT,'Settlement snapshot is immutable'); END;

-- Only inserted as part of the existing critical-write batch. Never infer dispatch permission.
CREATE TABLE request_usage_commit_receipts (
  request_id TEXT PRIMARY KEY NOT NULL,
  payload_sha256 TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY(request_id,payload_sha256,recorded_at)
    REFERENCES request_usage_settlements(request_id,payload_sha256,recorded_at)
);
CREATE TRIGGER request_usage_commit_receipts_immutable BEFORE UPDATE ON request_usage_commit_receipts
BEGIN SELECT RAISE(ABORT,'Settlement receipt is immutable'); END;
