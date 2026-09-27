-- LOCAL PROPOSAL ONLY. Apply after both earlier recovery proposals; no automatic migrations.
-- Database UTC seconds govern leases, including the check INSIDE the final critical batch.
ALTER TABLE request_usage_commit_receipts ADD COLUMN lease_token TEXT;
ALTER TABLE request_usage_commit_receipts ADD COLUMN lease_revision INTEGER;

CREATE TABLE request_usage_recovery_jobs (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES request_usage_settlements(request_id),
  user_id TEXT NOT NULL, api_key_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','leased','committed','blocked')),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
  attempts INTEGER NOT NULL CHECK(typeof(attempts)='integer' AND attempts BETWEEN 0 AND 5),
  lease_token TEXT UNIQUE,
  lease_expires_at INTEGER,
  available_at INTEGER,
  last_error TEXT CHECK(last_error IN ('execution_error','interrupted','snapshot_invalid','settlement_conflict','retry_exhausted')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK(typeof(created_at)='integer' AND typeof(updated_at)='integer' AND updated_at>=created_at),
  CHECK((state='pending' AND attempts<5 AND lease_token IS NULL AND lease_expires_at IS NULL AND available_at IS NOT NULL AND typeof(available_at)='integer')
     OR (state='leased' AND attempts>0 AND lease_token IS NOT NULL AND length(lease_token)=36
         AND lease_expires_at IS NOT NULL AND typeof(lease_expires_at)='integer' AND lease_expires_at>updated_at
         AND available_at IS NOT NULL AND available_at=lease_expires_at)
     OR (state IN ('committed','blocked') AND lease_token IS NULL AND lease_expires_at IS NULL AND available_at IS NULL)),
  CHECK(state!='blocked' OR last_error IS NOT NULL)
);
CREATE INDEX request_usage_recovery_due ON request_usage_recovery_jobs(available_at,request_id) WHERE state IN ('pending','leased');
CREATE INDEX request_usage_recovery_tenant_due ON request_usage_recovery_jobs(user_id,workspace_id,available_at,request_id) WHERE state IN ('pending','leased');

CREATE TRIGGER request_usage_recovery_identity BEFORE INSERT ON request_usage_recovery_jobs
WHEN NOT EXISTS (SELECT 1 FROM request_usage_settlements s WHERE s.request_id=NEW.request_id
  AND s.user_id=NEW.user_id AND s.api_key_id=NEW.api_key_id AND s.workspace_id=NEW.workspace_id AND s.payload_sha256=NEW.payload_sha256)
BEGIN SELECT RAISE(ABORT,'Recovery job identity conflict'); END;

-- Atomic snapshot -> pending job; no DB/queue dual write or best-effort enqueue.
CREATE TRIGGER request_usage_recovery_enqueue AFTER INSERT ON request_usage_settlements
BEGIN
  INSERT INTO request_usage_recovery_jobs(request_id,user_id,api_key_id,workspace_id,payload_sha256,state,revision,attempts,available_at,created_at,updated_at)
  VALUES(NEW.request_id,NEW.user_id,NEW.api_key_id,NEW.workspace_id,NEW.payload_sha256,'pending',0,0,unixepoch('now'),unixepoch('now'),unixepoch('now'));
END;

-- Expand already accepted local-proposal rows without replaying old economic writes.
-- A receipt without a corresponding identity/amount-matching log is not backfilled as completed.
INSERT INTO request_usage_recovery_jobs(request_id,user_id,api_key_id,workspace_id,payload_sha256,state,revision,attempts,available_at,created_at,updated_at)
SELECT s.request_id,s.user_id,s.api_key_id,s.workspace_id,s.payload_sha256,
  CASE WHEN r.request_id IS NOT NULL AND l.id IS NOT NULL THEN 'committed' ELSE 'pending' END,0,0,
  CASE WHEN r.request_id IS NOT NULL AND l.id IS NOT NULL THEN NULL ELSE unixepoch('now') END,unixepoch('now'),unixepoch('now')
FROM request_usage_settlements s
LEFT JOIN request_usage_commit_receipts r ON r.request_id=s.request_id AND r.payload_sha256=s.payload_sha256 AND r.recorded_at=s.recorded_at
LEFT JOIN api_key_request_logs l ON l.id=r.request_id AND l.user_id=s.user_id AND l.api_key_id=s.api_key_id AND l.workspace_id=s.workspace_id
  AND l.created_at=s.recorded_at AND l.request_operation=s.operation
  AND l.model_id=json_extract(s.payload_json,'$.params.requestLog.modelId') AND l.provider_id=json_extract(s.payload_json,'$.params.requestLog.providerId')
  AND ROUND(l.charged_cost,6)=ROUND(json_extract(s.payload_json,'$.params.chargedCost'),6)
  AND l.budget_charged_micros=CASE WHEN json_extract(s.payload_json,'$.params.shouldChargeBudget')=1
    THEN ROUND(ROUND(json_extract(s.payload_json,'$.params.chargedCost'),6)*1000000) ELSE 0 END;

CREATE TRIGGER request_usage_recovery_transition BEFORE UPDATE ON request_usage_recovery_jobs
WHEN NEW.request_id!=OLD.request_id OR NEW.user_id!=OLD.user_id OR NEW.api_key_id!=OLD.api_key_id
  OR NEW.workspace_id!=OLD.workspace_id OR NEW.payload_sha256!=OLD.payload_sha256 OR NEW.created_at!=OLD.created_at
  OR NEW.revision!=OLD.revision+1 OR NEW.updated_at<OLD.updated_at OR OLD.state IN ('committed','blocked')
  OR NOT COALESCE((
    (NEW.state='leased' AND OLD.state IN ('pending','leased') AND OLD.available_at<=unixepoch('now')
      AND NEW.attempts=OLD.attempts+1 AND NEW.lease_token IS NOT OLD.lease_token AND NEW.last_error IS NULL)
    OR (NEW.state='pending' AND OLD.state='leased' AND OLD.lease_expires_at>unixepoch('now')
      AND NEW.attempts=OLD.attempts AND NEW.available_at>unixepoch('now') AND NEW.last_error IN ('execution_error','interrupted'))
    OR (NEW.state='blocked' AND NEW.attempts=OLD.attempts AND (
      (OLD.state='leased' AND OLD.lease_expires_at>unixepoch('now'))
      OR (OLD.attempts=5 AND OLD.available_at<=unixepoch('now') AND NEW.last_error='retry_exhausted')))
    OR (NEW.state='committed' AND OLD.state='leased' AND OLD.lease_expires_at>unixepoch('now') AND NEW.attempts=OLD.attempts
      AND EXISTS(SELECT 1 FROM request_usage_commit_receipts r WHERE r.request_id=OLD.request_id
        AND r.payload_sha256=OLD.payload_sha256 AND r.lease_token=OLD.lease_token AND r.lease_revision=OLD.revision))
  ),0)
BEGIN SELECT RAISE(ABORT,'Invalid recovery job transition'); END;

-- No unfenced legacy caller may bypass a queued job. This runs inside the SAME atomic accounting batch.
CREATE TRIGGER request_usage_recovery_fence BEFORE INSERT ON request_usage_commit_receipts
WHEN NOT EXISTS(SELECT 1 FROM request_usage_recovery_jobs j WHERE j.request_id=NEW.request_id
  AND j.payload_sha256=NEW.payload_sha256 AND j.state='leased' AND j.lease_token=NEW.lease_token
  AND j.revision=NEW.lease_revision AND j.lease_expires_at>unixepoch('now'))
BEGIN SELECT RAISE(ABORT,'Settlement recovery lease invalid'); END;
CREATE TRIGGER request_usage_recovery_complete AFTER INSERT ON request_usage_commit_receipts
BEGIN
  UPDATE request_usage_recovery_jobs SET state='committed',revision=revision+1,lease_token=NULL,lease_expires_at=NULL,
    available_at=NULL,last_error=NULL,updated_at=unixepoch('now') WHERE request_id=NEW.request_id;
END;
