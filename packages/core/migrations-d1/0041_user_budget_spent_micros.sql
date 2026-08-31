-- 0041: make ordinary-user spend accounting exact at one micro-unit on D1.
--
-- `budget_spent_micros` is authoritative. `budget_spent` remains a REAL
-- compatibility/display mirror for existing readers and rolling deployments.
-- A binary64 value below 2^32 units has an ULP below 0.5 micro, so an existing
-- six-decimal gateway amount in that range can be recovered unambiguously.
-- Larger legacy values are rejected instead of pretending that an already-lost
-- micro can be reconstructed. Wrangler rolls a failed migration back atomically.

ALTER TABLE users ADD COLUMN budget_spent_micros INTEGER NOT NULL DEFAULT 0
  CHECK (budget_spent_micros >= 0 AND budget_spent_micros <= 9007199254740991);

CREATE TABLE _0041_user_budget_spent_backfill_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);

INSERT INTO _0041_user_budget_spent_backfill_guard (ok)
SELECT (CASE WHEN EXISTS (
  SELECT 1
  FROM users
  WHERE budget_spent IS NULL
     OR NOT (budget_spent >= 0 AND budget_spent < 4294967296.0)
) THEN 0 ELSE 1 END);

UPDATE users
SET budget_spent_micros = CAST(ROUND(budget_spent * 1000000.0) AS INTEGER),
    budget_spent = CAST(CAST(ROUND(budget_spent * 1000000.0) AS INTEGER) AS REAL) / 1000000.0;

DROP TABLE _0041_user_budget_spent_backfill_guard;

-- Keep a legacy Worker safe during a rolling deployment. A legacy-only REAL
-- insert/update is accepted only in the range where the six-decimal value can
-- still be recovered without ambiguity. New code always writes both columns.
CREATE TRIGGER trg_users_budget_spent_legacy_insert_sync
AFTER INSERT ON users
WHEN NEW.budget_spent_micros = 0 AND NEW.budget_spent <> 0
BEGIN
  SELECT (CASE WHEN NOT (NEW.budget_spent >= 0 AND NEW.budget_spent < 4294967296.0)
    THEN RAISE(ABORT, 'unsafe_legacy_budget_spent') END);
  UPDATE users
  SET budget_spent_micros = CAST(ROUND(NEW.budget_spent * 1000000.0) AS INTEGER),
      budget_spent = CAST(CAST(ROUND(NEW.budget_spent * 1000000.0) AS INTEGER) AS REAL) / 1000000.0
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_users_budget_spent_legacy_update_sync
AFTER UPDATE OF budget_spent ON users
WHEN NEW.budget_spent_micros = OLD.budget_spent_micros
 AND NEW.budget_spent IS NOT OLD.budget_spent
 AND NEW.budget_spent IS NOT CAST(NEW.budget_spent_micros AS REAL) / 1000000.0
BEGIN
  SELECT (CASE WHEN NOT (NEW.budget_spent >= 0 AND NEW.budget_spent < 4294967296.0)
    THEN RAISE(ABORT, 'unsafe_legacy_budget_spent') END);
  UPDATE users
  SET budget_spent_micros = CAST(ROUND(NEW.budget_spent * 1000000.0) AS INTEGER),
      budget_spent = CAST(CAST(ROUND(NEW.budget_spent * 1000000.0) AS INTEGER) AS REAL) / 1000000.0
  WHERE id = NEW.id;
END;

-- Defensive compatibility for direct integer maintenance. Production code and
-- ledger triggers dual-write, so this normally only repairs an integer-only
-- operator update.
CREATE TRIGGER trg_users_budget_spent_integer_mirror
AFTER UPDATE OF budget_spent_micros ON users
WHEN NEW.budget_spent_micros <> OLD.budget_spent_micros
 AND NEW.budget_spent IS OLD.budget_spent
BEGIN
  UPDATE users
  SET budget_spent = CAST(NEW.budget_spent_micros AS REAL) / 1000000.0
  WHERE id = NEW.id;
END;

-- Rebuild the 0040 ordinary-budget triggers around the integer source of truth.
DROP TRIGGER trg_user_budget_reservation_capacity;
DROP TRIGGER trg_user_budget_reservation_terminal;
DROP TRIGGER trg_user_budget_reservation_late_actual;

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
    SELECT budget_spent_micros + budget_reserved_micros + NEW.reserved_micros
    FROM users WHERE id = NEW.user_id
  ) > NEW.limit_micros THEN RAISE(ABORT, 'user_budget_exceeded') END);
END;

CREATE TRIGGER trg_user_budget_reservation_terminal
AFTER UPDATE OF state ON user_budget_reservations
WHEN OLD.state IN ('reserved', 'dispatched')
 AND NEW.state IN ('settled', 'released', 'expired')
BEGIN
  UPDATE users
  SET budget_reserved_micros = budget_reserved_micros - OLD.reserved_micros,
      budget_spent_micros = MIN(
        budget_spent_micros + NEW.settled_micros,
        9007199254740991
      ),
      budget_spent = CAST(MIN(
        budget_spent_micros + NEW.settled_micros,
        9007199254740991
      ) AS REAL) / 1000000.0,
      updated_at = NEW.updated_at
  WHERE id = OLD.user_id AND budget_epoch = OLD.budget_epoch;
END;

-- An expired dispatched lease may have charged its ceiling before exact usage
-- arrives. Reconcile its signed delta exactly in INTEGER micros. Saturating at
-- MAX_SAFE is fail-closed for every finite ordinary-user limit.
CREATE TRIGGER trg_user_budget_reservation_late_actual
AFTER UPDATE OF settled_micros ON user_budget_reservations
WHEN OLD.state = 'expired'
 AND NEW.state = 'expired'
 AND OLD.settled_micros <> NEW.settled_micros
BEGIN
  UPDATE users
  SET budget_spent_micros = MAX(0, MIN(
        budget_spent_micros + (NEW.settled_micros - OLD.settled_micros),
        9007199254740991
      )),
      budget_spent = CAST(MAX(0, MIN(
        budget_spent_micros + (NEW.settled_micros - OLD.settled_micros),
        9007199254740991
      )) AS REAL) / 1000000.0,
      updated_at = NEW.updated_at
  WHERE id = OLD.user_id AND budget_epoch = OLD.budget_epoch;
END;
