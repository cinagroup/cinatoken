-- Append-only correction for 0031: the post-update balance cannot reveal
-- whether its guarded UPDATE matched. A large remaining lock falsely aborted,
-- while insufficient/missing earnings silently admitted a terminal status.
-- SQLite saves/restores changes() around nested triggers. Read it immediately
-- after each guarded UPDATE, before the journal INSERT changes that value.

DROP TRIGGER IF EXISTS withdrawals_confirm_after_status_update;

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

  SELECT RAISE(ABORT, 'insufficient_locked_balance') WHERE changes() <> 1;

  INSERT INTO portal_ledger_entries
    (id, user_id, kind, amount_micros, balance_after_micros, locked_after_micros,
     reference_type, reference_id, created_at)
  SELECT NEW.id || ':settle', NEW.user_id, 'withdrawal_settle', -OLD.amount_micros,
         balance_micros, locked_amount_micros, 'withdrawal', OLD.id, NEW.updated_at
  FROM user_earnings WHERE user_id = OLD.user_id;
END;

DROP TRIGGER IF EXISTS withdrawals_refund_after_status_update;

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

  SELECT RAISE(ABORT, 'insufficient_locked_balance') WHERE changes() <> 1;

  INSERT INTO portal_ledger_entries
    (id, user_id, kind, amount_micros, balance_after_micros, locked_after_micros,
     reference_type, reference_id, created_at)
  SELECT NEW.id || ':refund', NEW.user_id, 'withdrawal_refund', OLD.amount_micros,
         balance_micros, locked_amount_micros, 'withdrawal', OLD.id, NEW.updated_at
  FROM user_earnings WHERE user_id = OLD.user_id;
END;
