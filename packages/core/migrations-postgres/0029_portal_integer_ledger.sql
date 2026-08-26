-- Canonical integer-micro ledger and database-enforced withdrawal transitions.
SET search_path TO cinatoken_gateway;

ALTER TABLE user_earnings ADD COLUMN balance_micros BIGINT NOT NULL DEFAULT 0;
ALTER TABLE user_earnings ADD COLUMN locked_amount_micros BIGINT NOT NULL DEFAULT 0;
ALTER TABLE user_earnings ADD COLUMN lifetime_earned_micros BIGINT NOT NULL DEFAULT 0;
ALTER TABLE user_earnings ADD COLUMN lifetime_withdrawn_micros BIGINT NOT NULL DEFAULT 0;
ALTER TABLE user_earnings ADD COLUMN contribution_value_micros BIGINT NOT NULL DEFAULT 0;

UPDATE user_earnings SET
  balance_micros = ROUND(balance * 1000000)::BIGINT,
  locked_amount_micros = ROUND(locked_amount * 1000000)::BIGINT,
  lifetime_earned_micros = ROUND(lifetime_earned * 1000000)::BIGINT,
  lifetime_withdrawn_micros = ROUND(lifetime_withdrawn * 1000000)::BIGINT,
  contribution_value_micros = ROUND(contribution_value * 1000000)::BIGINT;

ALTER TABLE user_earnings
  ADD CONSTRAINT user_earnings_balance_micros_nonnegative CHECK (balance_micros >= 0),
  ADD CONSTRAINT user_earnings_locked_micros_nonnegative CHECK (locked_amount_micros >= 0),
  ADD CONSTRAINT user_earnings_lifetime_micros_nonnegative CHECK (
    lifetime_earned_micros >= 0 AND lifetime_withdrawn_micros >= 0
  );

ALTER TABLE withdrawals ADD COLUMN amount_micros BIGINT NOT NULL DEFAULT 0;
ALTER TABLE withdrawals ADD COLUMN fee_micros BIGINT NOT NULL DEFAULT 0;
ALTER TABLE withdrawals ADD COLUMN net_amount_micros BIGINT NOT NULL DEFAULT 0;

UPDATE withdrawals SET
  amount_micros = ROUND(amount * 1000000)::BIGINT,
  fee_micros = ROUND(fee * 1000000)::BIGINT,
  net_amount_micros = ROUND(net_amount * 1000000)::BIGINT;

ALTER TABLE withdrawals
  ADD CONSTRAINT withdrawals_amount_micros_positive CHECK (amount_micros > 0),
  ADD CONSTRAINT withdrawals_fee_micros_nonnegative CHECK (fee_micros >= 0),
  ADD CONSTRAINT withdrawals_net_micros_nonnegative CHECK (net_amount_micros >= 0);

CREATE UNIQUE INDEX idx_withdrawals_one_active_per_user
  ON withdrawals(user_id)
  WHERE status IN ('requested', 'processing', 'submitted');

CREATE TABLE portal_ledger_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  amount_micros BIGINT NOT NULL,
  balance_after_micros BIGINT NOT NULL,
  locked_after_micros BIGINT NOT NULL,
  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT portal_ledger_entries_reference_unique
    UNIQUE(reference_type, reference_id, kind)
);

CREATE INDEX idx_portal_ledger_user_created
  ON portal_ledger_entries(user_id, created_at, id);

CREATE FUNCTION shared_key_earnings_credit_after_insert_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, cinatoken_gateway
AS $ledger$
DECLARE
  credit_micros BIGINT;
  account user_earnings%ROWTYPE;
BEGIN
  credit_micros := ROUND(NEW.net_amount * 1000000)::BIGINT;

  UPDATE user_earnings
  SET balance_micros = balance_micros + credit_micros,
      lifetime_earned_micros = lifetime_earned_micros + credit_micros,
      contribution_value_micros = contribution_value_micros + credit_micros,
      balance = (balance_micros + credit_micros)::NUMERIC / 1000000,
      lifetime_earned = (lifetime_earned_micros + credit_micros)::NUMERIC / 1000000,
      contribution_value = (contribution_value_micros + credit_micros)::NUMERIC / 1000000,
      updated_at = NEW.created_at
  WHERE user_id = NEW.seller_user_id
  RETURNING * INTO account;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'missing_user_earnings'
      USING ERRCODE = '23503';
  END IF;

  INSERT INTO portal_ledger_entries
    (id, user_id, kind, amount_micros, balance_after_micros, locked_after_micros,
     reference_type, reference_id, created_at)
  VALUES
    (NEW.id || ':earning', NEW.seller_user_id, 'shared_key_earning', credit_micros,
     account.balance_micros, account.locked_amount_micros,
     'shared_key_earning', NEW.id, NEW.created_at);

  RETURN NEW;
END
$ledger$;

CREATE TRIGGER shared_key_earnings_credit_after_insert
AFTER INSERT ON shared_key_earnings
FOR EACH ROW EXECUTE FUNCTION shared_key_earnings_credit_after_insert_fn();

CREATE FUNCTION withdrawals_validate_lock_before_insert_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, cinatoken_gateway
AS $withdrawal$
DECLARE
  available_micros BIGINT;
BEGIN
  IF NEW.status <> 'requested' THEN
    RETURN NEW;
  END IF;

  IF NEW.amount_micros <= 0 THEN
    RAISE EXCEPTION 'insufficient_balance' USING ERRCODE = 'P0001';
  END IF;

  SELECT balance_micros
  INTO available_micros
  FROM user_earnings
  WHERE user_id = NEW.user_id
  FOR UPDATE;

  IF NOT FOUND OR available_micros < NEW.amount_micros THEN
    RAISE EXCEPTION 'insufficient_balance' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM withdrawals
    WHERE user_id = NEW.user_id
      AND status IN ('requested', 'processing', 'submitted')
  ) THEN
    RAISE EXCEPTION 'active_withdrawal_exists' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END
$withdrawal$;

CREATE TRIGGER withdrawals_validate_lock_before_insert
BEFORE INSERT ON withdrawals
FOR EACH ROW EXECUTE FUNCTION withdrawals_validate_lock_before_insert_fn();

CREATE FUNCTION withdrawals_lock_after_insert_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, cinatoken_gateway
AS $withdrawal$
DECLARE
  account user_earnings%ROWTYPE;
BEGIN
  IF NEW.status <> 'requested' THEN
    RETURN NEW;
  END IF;

  UPDATE user_earnings
  SET balance_micros = balance_micros - NEW.amount_micros,
      locked_amount_micros = locked_amount_micros + NEW.amount_micros,
      balance = (balance_micros - NEW.amount_micros)::NUMERIC / 1000000,
      locked_amount = (locked_amount_micros + NEW.amount_micros)::NUMERIC / 1000000,
      updated_at = NEW.created_at
  WHERE user_id = NEW.user_id
    AND balance_micros >= NEW.amount_micros
  RETURNING * INTO account;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'insufficient_balance' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO portal_ledger_entries
    (id, user_id, kind, amount_micros, balance_after_micros, locked_after_micros,
     reference_type, reference_id, created_at)
  VALUES
    (NEW.id || ':lock', NEW.user_id, 'withdrawal_lock', -NEW.amount_micros,
     account.balance_micros, account.locked_amount_micros,
     'withdrawal', NEW.id, NEW.created_at);

  RETURN NEW;
END
$withdrawal$;

CREATE TRIGGER withdrawals_lock_after_insert
AFTER INSERT ON withdrawals
FOR EACH ROW EXECUTE FUNCTION withdrawals_lock_after_insert_fn();

CREATE FUNCTION withdrawals_confirm_after_status_update_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, cinatoken_gateway
AS $withdrawal$
DECLARE
  account user_earnings%ROWTYPE;
BEGIN
  IF OLD.status NOT IN ('requested', 'processing', 'submitted') OR NEW.status <> 'confirmed' THEN
    RETURN NEW;
  END IF;

  UPDATE user_earnings
  SET locked_amount_micros = locked_amount_micros - OLD.amount_micros,
      lifetime_withdrawn_micros = lifetime_withdrawn_micros + OLD.amount_micros,
      locked_amount = (locked_amount_micros - OLD.amount_micros)::NUMERIC / 1000000,
      lifetime_withdrawn = (lifetime_withdrawn_micros + OLD.amount_micros)::NUMERIC / 1000000,
      updated_at = NEW.updated_at
  WHERE user_id = OLD.user_id
    AND locked_amount_micros >= OLD.amount_micros
  RETURNING * INTO account;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'insufficient_locked_balance' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO portal_ledger_entries
    (id, user_id, kind, amount_micros, balance_after_micros, locked_after_micros,
     reference_type, reference_id, created_at)
  VALUES
    (NEW.id || ':settle', NEW.user_id, 'withdrawal_settle', -NEW.amount_micros,
     account.balance_micros, account.locked_amount_micros,
     'withdrawal', NEW.id, NEW.updated_at);

  RETURN NEW;
END
$withdrawal$;

CREATE TRIGGER withdrawals_confirm_after_status_update
AFTER UPDATE OF status ON withdrawals
FOR EACH ROW EXECUTE FUNCTION withdrawals_confirm_after_status_update_fn();

CREATE FUNCTION withdrawals_refund_after_status_update_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, cinatoken_gateway
AS $withdrawal$
DECLARE
  account user_earnings%ROWTYPE;
BEGIN
  IF OLD.status NOT IN ('requested', 'processing', 'submitted') OR NEW.status <> 'failed' THEN
    RETURN NEW;
  END IF;

  UPDATE user_earnings
  SET locked_amount_micros = locked_amount_micros - OLD.amount_micros,
      balance_micros = balance_micros + OLD.amount_micros,
      locked_amount = (locked_amount_micros - OLD.amount_micros)::NUMERIC / 1000000,
      balance = (balance_micros + OLD.amount_micros)::NUMERIC / 1000000,
      updated_at = NEW.updated_at
  WHERE user_id = OLD.user_id
    AND locked_amount_micros >= OLD.amount_micros
  RETURNING * INTO account;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'insufficient_locked_balance' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO portal_ledger_entries
    (id, user_id, kind, amount_micros, balance_after_micros, locked_after_micros,
     reference_type, reference_id, created_at)
  VALUES
    (NEW.id || ':refund', NEW.user_id, 'withdrawal_refund', NEW.amount_micros,
     account.balance_micros, account.locked_amount_micros,
     'withdrawal', NEW.id, NEW.updated_at);

  RETURN NEW;
END
$withdrawal$;

CREATE TRIGGER withdrawals_refund_after_status_update
AFTER UPDATE OF status ON withdrawals
FOR EACH ROW EXECUTE FUNCTION withdrawals_refund_after_status_update_fn();
