-- Canonical integer-micro ledger and atomic withdrawal state transitions for D1.

ALTER TABLE user_earnings ADD COLUMN balance_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_earnings ADD COLUMN locked_amount_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_earnings ADD COLUMN lifetime_earned_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_earnings ADD COLUMN lifetime_withdrawn_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_earnings ADD COLUMN contribution_value_micros INTEGER NOT NULL DEFAULT 0;

UPDATE user_earnings SET
  balance_micros = CAST(ROUND(balance * 1000000) AS INTEGER),
  locked_amount_micros = CAST(ROUND(locked_amount * 1000000) AS INTEGER),
  lifetime_earned_micros = CAST(ROUND(lifetime_earned * 1000000) AS INTEGER),
  lifetime_withdrawn_micros = CAST(ROUND(lifetime_withdrawn * 1000000) AS INTEGER),
  contribution_value_micros = CAST(ROUND(contribution_value * 1000000) AS INTEGER);

ALTER TABLE withdrawals ADD COLUMN amount_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE withdrawals ADD COLUMN fee_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE withdrawals ADD COLUMN net_amount_micros INTEGER NOT NULL DEFAULT 0;

UPDATE withdrawals SET
  amount_micros = CAST(ROUND(amount * 1000000) AS INTEGER),
  fee_micros = CAST(ROUND(fee * 1000000) AS INTEGER),
  net_amount_micros = CAST(ROUND(net_amount * 1000000) AS INTEGER);

CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawals_one_active_per_user
  ON withdrawals(user_id)
  WHERE status IN ('requested', 'processing', 'submitted');

CREATE TABLE IF NOT EXISTS portal_ledger_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  balance_after_micros INTEGER NOT NULL,
  locked_after_micros INTEGER NOT NULL,
  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(reference_type, reference_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_portal_ledger_user_created
  ON portal_ledger_entries(user_id, created_at, id);

CREATE TRIGGER shared_key_earnings_credit_after_insert
AFTER INSERT ON shared_key_earnings
BEGIN
  UPDATE user_earnings
  SET balance_micros = balance_micros + CAST(ROUND(NEW.net_amount * 1000000) AS INTEGER),
      lifetime_earned_micros = lifetime_earned_micros + CAST(ROUND(NEW.net_amount * 1000000) AS INTEGER),
      contribution_value_micros = contribution_value_micros + CAST(ROUND(NEW.net_amount * 1000000) AS INTEGER),
      balance = CAST(balance_micros + CAST(ROUND(NEW.net_amount * 1000000) AS INTEGER) AS REAL) / 1000000.0,
      lifetime_earned = CAST(lifetime_earned_micros + CAST(ROUND(NEW.net_amount * 1000000) AS INTEGER) AS REAL) / 1000000.0,
      contribution_value = CAST(contribution_value_micros + CAST(ROUND(NEW.net_amount * 1000000) AS INTEGER) AS REAL) / 1000000.0,
      updated_at = NEW.created_at
  WHERE user_id = NEW.seller_user_id;

  INSERT INTO portal_ledger_entries
    (id, user_id, kind, amount_micros, balance_after_micros, locked_after_micros,
     reference_type, reference_id, created_at)
  SELECT NEW.id || ':earning', NEW.seller_user_id, 'shared_key_earning',
         CAST(ROUND(NEW.net_amount * 1000000) AS INTEGER),
         balance_micros, locked_amount_micros, 'shared_key_earning', NEW.id, NEW.created_at
  FROM user_earnings WHERE user_id = NEW.seller_user_id;
END;

CREATE TRIGGER withdrawals_validate_lock_before_insert
BEFORE INSERT ON withdrawals
WHEN NEW.status = 'requested'
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM withdrawals
      WHERE user_id = NEW.user_id
        AND status IN ('requested', 'processing', 'submitted')
    ) THEN RAISE(ABORT, 'active_withdrawal_exists')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM user_earnings
      WHERE user_id = NEW.user_id
        AND balance_micros >= NEW.amount_micros
        AND NEW.amount_micros > 0
    ) THEN RAISE(ABORT, 'insufficient_balance')
  END;
END;

CREATE TRIGGER withdrawals_lock_after_insert
AFTER INSERT ON withdrawals
WHEN NEW.status = 'requested'
BEGIN
  UPDATE user_earnings
  SET balance_micros = balance_micros - NEW.amount_micros,
      locked_amount_micros = locked_amount_micros + NEW.amount_micros,
      balance = CAST(balance_micros - NEW.amount_micros AS REAL) / 1000000.0,
      locked_amount = CAST(locked_amount_micros + NEW.amount_micros AS REAL) / 1000000.0,
      updated_at = NEW.created_at
  WHERE user_id = NEW.user_id;

  INSERT INTO portal_ledger_entries
    (id, user_id, kind, amount_micros, balance_after_micros, locked_after_micros,
     reference_type, reference_id, created_at)
  SELECT NEW.id || ':lock', NEW.user_id, 'withdrawal_lock', -NEW.amount_micros,
         balance_micros, locked_amount_micros, 'withdrawal', NEW.id, NEW.created_at
  FROM user_earnings WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER withdrawals_confirm_after_status_update
AFTER UPDATE OF status ON withdrawals
WHEN OLD.status IN ('requested', 'processing', 'submitted') AND NEW.status = 'confirmed'
BEGIN
  UPDATE user_earnings
  SET locked_amount_micros = locked_amount_micros - OLD.amount_micros,
      lifetime_withdrawn_micros = lifetime_withdrawn_micros + OLD.amount_micros,
      locked_amount = CAST(locked_amount_micros - OLD.amount_micros AS REAL) / 1000000.0,
      lifetime_withdrawn = CAST(lifetime_withdrawn_micros + OLD.amount_micros AS REAL) / 1000000.0,
      updated_at = NEW.updated_at
  WHERE user_id = OLD.user_id AND locked_amount_micros >= OLD.amount_micros;

  INSERT INTO portal_ledger_entries
    (id, user_id, kind, amount_micros, balance_after_micros, locked_after_micros,
     reference_type, reference_id, created_at)
  SELECT NEW.id || ':settle', NEW.user_id, 'withdrawal_settle', -NEW.amount_micros,
         balance_micros, locked_amount_micros, 'withdrawal', NEW.id, NEW.updated_at
  FROM user_earnings WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER withdrawals_refund_after_status_update
AFTER UPDATE OF status ON withdrawals
WHEN OLD.status IN ('requested', 'processing', 'submitted') AND NEW.status = 'failed'
BEGIN
  UPDATE user_earnings
  SET locked_amount_micros = locked_amount_micros - OLD.amount_micros,
      balance_micros = balance_micros + OLD.amount_micros,
      locked_amount = CAST(locked_amount_micros - OLD.amount_micros AS REAL) / 1000000.0,
      balance = CAST(balance_micros + OLD.amount_micros AS REAL) / 1000000.0,
      updated_at = NEW.updated_at
  WHERE user_id = OLD.user_id AND locked_amount_micros >= OLD.amount_micros;

  INSERT INTO portal_ledger_entries
    (id, user_id, kind, amount_micros, balance_after_micros, locked_after_micros,
     reference_type, reference_id, created_at)
  SELECT NEW.id || ':refund', NEW.user_id, 'withdrawal_refund', NEW.amount_micros,
         balance_micros, locked_amount_micros, 'withdrawal', NEW.id, NEW.updated_at
  FROM user_earnings WHERE user_id = NEW.user_id;
END;
