-- REVIEW ONLY. Install explicitly after the D1 portal integer ledger migration.
-- A credited earning is a historical financial fact. The original 0027 foreign
-- keys cascade from request logs, shared keys and seller users; deleting any of
-- those parents must not remove the earning while its balance/journal survive.
-- SQLite executes child DELETE triggers for foreign-key cascade actions. This
-- guard also forbids direct UPDATE/DELETE; adjustments must be appended as new
-- financial facts, never by rewriting an existing credited earning.

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
