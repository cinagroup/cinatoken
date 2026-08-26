-- 0031（D1）：提现 settle/refund 触发器守卫对齐（审计 M6）
--
-- 0029 的 confirm/refund 触发器：余额 UPDATE 带 locked_amount >= amount 守卫，
-- 但其后的 portal_ledger_entries INSERT 无条件执行 —— 守卫失败时提现仍被置为
-- 终态、账本行以未变更的余额写入、锁定的资金永不释放。Postgres 版 0029 在同
-- 位置 RAISE（整笔回滚）；本迁移把 D1 对齐到同一语义：守卫未生效即 ABORT，
-- 回滚对 withdrawals 的状态更新。
--
-- 判定逻辑：守卫 UPDATE 命中后条件必然不再成立；若更新后条件仍成立，说明
-- UPDATE 未命中（余额不足/行缺失）→ RAISE。

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

  SELECT RAISE(ABORT, 'insufficient_locked_balance')
  WHERE EXISTS (
    SELECT 1 FROM user_earnings
    WHERE user_id = OLD.user_id AND locked_amount_micros >= OLD.amount_micros
  );

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

  SELECT RAISE(ABORT, 'insufficient_locked_balance')
  WHERE EXISTS (
    SELECT 1 FROM user_earnings
    WHERE user_id = OLD.user_id AND locked_amount_micros >= OLD.amount_micros
  );

  INSERT INTO portal_ledger_entries
    (id, user_id, kind, amount_micros, balance_after_micros, locked_after_micros,
     reference_type, reference_id, created_at)
  SELECT NEW.id || ':refund', NEW.user_id, 'withdrawal_refund', OLD.amount_micros,
         balance_micros, locked_amount_micros, 'withdrawal', OLD.id, NEW.updated_at
  FROM user_earnings WHERE user_id = OLD.user_id;
END;
