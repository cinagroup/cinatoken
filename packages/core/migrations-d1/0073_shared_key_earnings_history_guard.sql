-- Credited earnings are append-only financial facts. This migration does not
-- replay credits, alter balances/journal entries, or change usage repair.
-- Rolling old applications can still INSERT OR IGNORE and update shared-key
-- status/prices/statistics. History deletion now fails atomically; disable a
-- used key instead. Corrections require new reviewed financial facts.
-- Apply through the transactional D1 migration runner. On application rollback
-- retain these guards; never remove them to let an old cleanup job succeed.

-- Adopt the review-only guard with its original names, without editing 0027.
DROP TRIGGER IF EXISTS shared_key_earnings_history_no_update;
DROP TRIGGER IF EXISTS shared_key_earnings_history_no_delete;

CREATE TRIGGER shared_key_earnings_history_no_update
BEFORE UPDATE ON shared_key_earnings
BEGIN
  SELECT RAISE(ABORT, 'credited_shared_key_earning_history_immutable');
END;

CREATE TRIGGER shared_key_earnings_history_no_delete
BEFORE DELETE ON shared_key_earnings
BEGIN
  SELECT RAISE(ABORT, 'credited_shared_key_earning_history_immutable');
END;

-- A child RESTRICT reference also protects implicit REPLACE deletions when
-- recursive_triggers is OFF. It contains only a derived earning identity;
-- backfill must not run the existing earning INSERT/credit trigger again.
CREATE TABLE shared_key_earning_history_anchors (
  earning_id TEXT PRIMARY KEY NOT NULL
    REFERENCES shared_key_earnings(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

INSERT INTO shared_key_earning_history_anchors(earning_id)
SELECT id FROM shared_key_earnings;

CREATE TRIGGER shared_key_earnings_history_anchor_after_insert
AFTER INSERT ON shared_key_earnings
BEGIN
  INSERT INTO shared_key_earning_history_anchors(earning_id) VALUES (NEW.id);
END;

CREATE TRIGGER shared_key_earning_history_anchors_no_update
BEFORE UPDATE ON shared_key_earning_history_anchors
BEGIN
  SELECT RAISE(ABORT, 'credited_shared_key_earning_history_immutable');
END;

CREATE TRIGGER shared_key_earning_history_anchors_no_delete
BEFORE DELETE ON shared_key_earning_history_anchors
BEGIN
  SELECT RAISE(ABORT, 'credited_shared_key_earning_history_immutable');
END;

CREATE INDEX idx_shared_key_earnings_history_key
ON shared_key_earnings(shared_key_id);

-- SQLite cannot ALTER the original CASCADE foreign keys without rebuilding a
-- live financial table. Parent guards plus the child guards enforce retention
-- without rebuilding it or relying on application-side deletion prechecks.
CREATE TRIGGER shared_keys_earning_history_no_delete
BEFORE DELETE ON shared_keys
WHEN EXISTS (SELECT 1 FROM shared_key_earnings WHERE shared_key_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'credited_shared_key_earning_history_immutable');
END;

CREATE TRIGGER shared_key_logs_earning_history_no_delete
BEFORE DELETE ON api_key_request_logs
WHEN EXISTS (SELECT 1 FROM shared_key_earnings WHERE request_log_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'credited_shared_key_earning_history_immutable');
END;

CREATE TRIGGER shared_key_sellers_earning_history_no_delete
BEFORE DELETE ON users
WHEN EXISTS (SELECT 1 FROM shared_key_earnings WHERE seller_user_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'credited_shared_key_earning_history_immutable');
END;
