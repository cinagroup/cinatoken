-- CinaToken integration: retain existing period grants, spent micros and reservations.
-- Permanent wallet credits start at zero; no legacy balance redistribution.

ALTER TABLE users ADD COLUMN wallet_granted REAL NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN wallet_spent REAL NOT NULL DEFAULT 0;

ALTER TABLE user_audit_logs ADD COLUMN dedup_key TEXT NULL;
CREATE UNIQUE INDEX ux_user_audit_dedup ON user_audit_logs(user_id, dedup_key);

ALTER TABLE api_key_request_logs ADD COLUMN charged_wallet_cost REAL NOT NULL DEFAULT 0;


ALTER TABLE user_budget_reservations ADD COLUMN settled_wallet_micros INTEGER NOT NULL DEFAULT 0 CHECK (settled_wallet_micros >= 0 AND settled_wallet_micros <= 9007199254740991);

-- Wallet shares are assigned at the same serialized write boundary as period debits.
DROP TRIGGER trg_user_budget_reservation_capacity;
CREATE TRIGGER trg_user_budget_reservation_capacity
BEFORE INSERT ON user_budget_reservations
BEGIN
  SELECT (CASE WHEN NEW.state <> 'reserved' OR NEW.settled_micros <> 0 OR NEW.settled_wallet_micros <> 0
    THEN RAISE(ABORT, 'invalid_user_budget_initial_state') END);
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
    THEN RAISE(ABORT, 'user_budget_user_missing') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM api_keys
    WHERE id = NEW.api_key_id
      AND user_id = NEW.user_id
      AND status = 'active'
  ) THEN RAISE(ABORT, 'user_budget_api_key_mismatch') END);
  SELECT (CASE WHEN (SELECT budget_epoch FROM users WHERE id = NEW.user_id) <> NEW.budget_epoch
    THEN RAISE(ABORT, 'user_budget_stale') END);
  SELECT (CASE WHEN (SELECT budget_max FROM users WHERE id = NEW.user_id) IS NULL
    THEN RAISE(ABORT, 'user_budget_unlimited') END);
  SELECT (CASE WHEN MIN(
      CAST(ROUND(MAX((SELECT budget_max + wallet_granted FROM users WHERE id = NEW.user_id), 0) * 1000000) AS INTEGER),
      9007199254740991
    ) <> NEW.limit_micros
    THEN RAISE(ABORT, 'user_budget_stale') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM users
    WHERE id = NEW.user_id
      AND budget_period <> 'none'
      AND budget_reset_at IS NOT NULL
      AND budget_reset_at <= NEW.created_at
  ) THEN RAISE(ABORT, 'user_budget_stale') END);
  SELECT (CASE WHEN (
    SELECT budget_spent_micros + CAST(ROUND(wallet_spent * 1000000) AS INTEGER) + budget_reserved_micros + NEW.reserved_micros
    FROM users WHERE id = NEW.user_id
  ) > NEW.limit_micros THEN RAISE(ABORT, 'user_budget_exceeded') END);
END;

DROP TRIGGER trg_user_budget_reservation_terminal;
CREATE TRIGGER trg_user_budget_reservation_terminal
AFTER UPDATE OF state ON user_budget_reservations
WHEN OLD.state IN ('reserved', 'dispatched') AND NEW.state IN ('settled', 'released', 'expired')
BEGIN
  UPDATE user_budget_reservations SET settled_wallet_micros = COALESCE((
    SELECT (CASE WHEN budget_max IS NULL THEN 0 ELSE MAX(0, NEW.settled_micros - MAX(0, CAST(ROUND(MAX(budget_max, 0) * 1000000) AS INTEGER) - budget_spent_micros)) END) FROM users WHERE id = OLD.user_id AND budget_epoch = OLD.budget_epoch
  ), 0) WHERE request_id = NEW.request_id;
  UPDATE users SET
    budget_reserved_micros = budget_reserved_micros - OLD.reserved_micros,
    budget_spent_micros = MIN(9007199254740991, budget_spent_micros + NEW.settled_micros - (SELECT settled_wallet_micros FROM user_budget_reservations WHERE request_id = NEW.request_id)),
    budget_spent = CAST(MIN(9007199254740991, budget_spent_micros + NEW.settled_micros - (SELECT settled_wallet_micros FROM user_budget_reservations WHERE request_id = NEW.request_id)) AS REAL) / 1000000.0,
    wallet_spent = ROUND(wallet_spent + CAST((SELECT settled_wallet_micros FROM user_budget_reservations WHERE request_id = NEW.request_id) AS REAL) / 1000000.0, 6),
    updated_at = NEW.updated_at
  WHERE id = OLD.user_id AND budget_epoch = OLD.budget_epoch;
  UPDATE api_key_request_logs SET charged_wallet_cost = CAST((SELECT settled_wallet_micros FROM user_budget_reservations WHERE request_id = NEW.request_id) AS REAL) / 1000000.0
    WHERE id = NEW.request_id;
END;

DROP TRIGGER trg_user_budget_reservation_late_actual;
CREATE TRIGGER trg_user_budget_reservation_late_actual
AFTER UPDATE OF settled_micros ON user_budget_reservations
WHEN OLD.state = 'expired' AND NEW.state = 'expired' AND OLD.settled_micros <> NEW.settled_micros
BEGIN
  UPDATE user_budget_reservations SET settled_wallet_micros = OLD.settled_wallet_micros + COALESCE((SELECT (CASE WHEN (NEW.settled_micros - OLD.settled_micros) < 0 THEN -MIN(-(NEW.settled_micros - OLD.settled_micros), OLD.settled_wallet_micros) WHEN budget_epoch <> OLD.budget_epoch OR budget_max IS NULL THEN 0 ELSE MAX(0, (NEW.settled_micros - OLD.settled_micros) - MAX(0, CAST(ROUND(MAX(budget_max, 0) * 1000000) AS INTEGER) - budget_spent_micros)) END) FROM users WHERE id = OLD.user_id), 0)
    WHERE request_id = NEW.request_id;
  UPDATE users SET
    budget_spent_micros = CASE WHEN budget_epoch = OLD.budget_epoch THEN MAX(0, MIN(9007199254740991, budget_spent_micros + (NEW.settled_micros - OLD.settled_micros) - ((SELECT settled_wallet_micros FROM user_budget_reservations WHERE request_id = NEW.request_id) - OLD.settled_wallet_micros))) ELSE budget_spent_micros END,
    budget_spent = CASE WHEN budget_epoch = OLD.budget_epoch THEN CAST(MAX(0, MIN(9007199254740991, budget_spent_micros + (NEW.settled_micros - OLD.settled_micros) - ((SELECT settled_wallet_micros FROM user_budget_reservations WHERE request_id = NEW.request_id) - OLD.settled_wallet_micros))) AS REAL) / 1000000.0 ELSE budget_spent END,
    wallet_spent = ROUND(MAX(0, wallet_spent + CAST(((SELECT settled_wallet_micros FROM user_budget_reservations WHERE request_id = NEW.request_id) - OLD.settled_wallet_micros) AS REAL) / 1000000.0), 6),
    updated_at = NEW.updated_at
  WHERE id = OLD.user_id;
  UPDATE api_key_request_logs SET charged_wallet_cost = CAST((SELECT settled_wallet_micros FROM user_budget_reservations WHERE request_id = NEW.request_id) AS REAL) / 1000000.0
    WHERE id = NEW.request_id;
END;

-- The accounting batch inserts its log before applying the debit. Capture the split
-- from the current account; reservation transitions override it with their actual share.
CREATE TRIGGER trg_request_log_wallet_share
AFTER INSERT ON api_key_request_logs
BEGIN
  UPDATE api_key_request_logs SET charged_wallet_cost = CASE
    WHEN EXISTS (SELECT 1 FROM user_budget_reservations WHERE request_id = NEW.id AND state IN ('settled', 'expired'))
      THEN COALESCE((SELECT CAST(settled_wallet_micros AS REAL) / 1000000.0 FROM user_budget_reservations WHERE request_id = NEW.id), 0)
    WHEN NEW.budget_charged_micros > 0 THEN COALESCE((SELECT (CASE WHEN budget_max IS NULL THEN 0 ELSE CAST(MAX(0, NEW.budget_charged_micros - MAX(0, CAST(ROUND(MAX(budget_max, 0) * 1000000) AS INTEGER) - budget_spent_micros)) AS REAL) / 1000000.0 END) FROM users WHERE id = NEW.user_id), 0)
    ELSE 0 END WHERE id = NEW.id;
END;
