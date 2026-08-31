-- 0040: atomic ordinary-user budget reservation ledger.
-- Guardrail policy rows remain physically and semantically independent.

ALTER TABLE users ADD COLUMN budget_epoch INTEGER NOT NULL DEFAULT 0
  CHECK (budget_epoch >= 0 AND budget_epoch <= 9007199254740991);
ALTER TABLE users ADD COLUMN budget_reserved_micros INTEGER NOT NULL DEFAULT 0
  CHECK (budget_reserved_micros >= 0 AND budget_reserved_micros <= 9007199254740991);

CREATE TABLE user_budget_reservations (
  request_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  budget_epoch INTEGER NOT NULL CHECK (budget_epoch >= 0 AND budget_epoch <= 9007199254740991),
  limit_micros INTEGER NOT NULL CHECK (limit_micros >= 0 AND limit_micros <= 9007199254740991),
  reserved_micros INTEGER NOT NULL CHECK (reserved_micros > 0 AND reserved_micros <= 9007199254740991),
  settled_micros INTEGER NOT NULL DEFAULT 0 CHECK (settled_micros >= 0 AND settled_micros <= 9007199254740991),
  state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved', 'dispatched', 'settled', 'released', 'expired')),
  expires_at TEXT NOT NULL,
  dispatched_at TEXT,
  terminal_at TEXT,
  terminal_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(request_id) BETWEEN 1 AND 128),
  CHECK (length(user_id) BETWEEN 1 AND 512),
  CHECK (length(api_key_id) BETWEEN 1 AND 512),
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_user_budget_reservations_expiry
  ON user_budget_reservations(state, expires_at);
CREATE INDEX idx_user_budget_reservations_user_epoch
  ON user_budget_reservations(user_id, budget_epoch, state);
CREATE INDEX idx_user_budget_reservations_api_key
  ON user_budget_reservations(api_key_id, created_at);

-- D1 has no row locks. Admission and its current-epoch reservation counter are
-- therefore enforced inside the INSERT statement with triggers.
CREATE TRIGGER trg_user_budget_reservation_capacity
BEFORE INSERT ON user_budget_reservations
BEGIN
  SELECT (CASE WHEN NEW.state <> 'reserved' OR NEW.settled_micros <> 0
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
      CAST(ROUND(MAX((SELECT budget_max FROM users WHERE id = NEW.user_id), 0) * 1000000) AS INTEGER),
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
    SELECT MIN(CAST(ROUND(MAX(budget_spent, 0) * 1000000) AS INTEGER), 9007199254740991)
      + budget_reserved_micros + NEW.reserved_micros
    FROM users WHERE id = NEW.user_id
  ) > NEW.limit_micros THEN RAISE(ABORT, 'user_budget_exceeded') END);
END;

CREATE TRIGGER trg_user_budget_reservation_insert_counter
AFTER INSERT ON user_budget_reservations
BEGIN
  UPDATE users
  SET budget_reserved_micros = budget_reserved_micros + NEW.reserved_micros,
      updated_at = NEW.updated_at
  WHERE id = NEW.user_id AND budget_epoch = NEW.budget_epoch;
END;

CREATE TRIGGER trg_user_budget_reservation_transition
BEFORE UPDATE OF state ON user_budget_reservations
WHEN OLD.state <> NEW.state
BEGIN
  SELECT (CASE
    WHEN OLD.state = 'reserved' AND NEW.state IN ('dispatched', 'settled', 'released', 'expired') THEN NULL
    WHEN OLD.state = 'dispatched' AND NEW.state IN ('settled', 'expired') THEN NULL
    ELSE RAISE(ABORT, 'invalid_user_budget_transition')
  END);
  SELECT (CASE WHEN NEW.state IN ('settled', 'released', 'expired')
    AND EXISTS (
      SELECT 1 FROM users
      WHERE id = OLD.user_id
        AND budget_epoch = OLD.budget_epoch
        AND budget_reserved_micros < OLD.reserved_micros
    ) THEN RAISE(ABORT, 'user_budget_reserved_counter_invariant') END);
END;

CREATE TRIGGER trg_user_budget_reservation_terminal
AFTER UPDATE OF state ON user_budget_reservations
WHEN OLD.state IN ('reserved', 'dispatched')
 AND NEW.state IN ('settled', 'released', 'expired')
BEGIN
  UPDATE users
  SET budget_reserved_micros = budget_reserved_micros - OLD.reserved_micros,
      budget_spent = ROUND(MAX(budget_spent + (CAST(NEW.settled_micros AS REAL) / 1000000.0), 0), 6),
      updated_at = NEW.updated_at
  WHERE id = OLD.user_id AND budget_epoch = OLD.budget_epoch;
END;

-- An expired dispatched lease may have charged its ceiling before exact usage
-- arrives. Reconcile only the delta and never debit a newer budget epoch.
CREATE TRIGGER trg_user_budget_reservation_late_actual
AFTER UPDATE OF settled_micros ON user_budget_reservations
WHEN OLD.state = 'expired'
 AND NEW.state = 'expired'
 AND OLD.settled_micros <> NEW.settled_micros
BEGIN
  UPDATE users
  SET budget_spent = ROUND(MAX(
        budget_spent + (CAST(NEW.settled_micros - OLD.settled_micros AS REAL) / 1000000.0),
        0
      ), 6),
      updated_at = NEW.updated_at
  WHERE id = OLD.user_id AND budget_epoch = OLD.budget_epoch;
END;
