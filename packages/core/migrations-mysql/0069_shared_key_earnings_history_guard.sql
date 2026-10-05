-- Credited earnings are append-only financial facts. Normal INSERT/INSERT IGNORE
-- settlement and shared-key statistics repair remain unchanged; no credit is
-- replayed and no earning/balance is rewritten by this migration.
-- MySQL DDL implicitly commits: quiesce marketplace writers/cleanup for this
-- migration and resume only after the complete file and migration ledger succeed.
-- On partial failure keep writes stopped and repair forward from inspected DDL;
-- do not drop guards or restore CASCADE. Old application rollback retains this
-- schema: used-key/log/seller deletion now fails; disabling still works.
-- Runtime must not have ALTER/DROP/TRIGGER privileges or disable enforcement for
-- maintenance. MySQL cannot intercept TRUNCATE in a DELETE trigger; the internal
-- RESTRICT child below blocks earning TRUNCATE with foreign_key_checks enabled.

-- InnoDB CASCADE does NOT fire child DELETE triggers. Change all three edges in
-- one ALTER rather than trusting an application precheck or a child trigger.
ALTER TABLE shared_key_earnings
  DROP FOREIGN KEY fk_shared_key_earnings_log,
  DROP FOREIGN KEY fk_shared_key_earnings_key,
  DROP FOREIGN KEY fk_shared_key_earnings_user,
  ADD CONSTRAINT fk_shared_key_earnings_log
    FOREIGN KEY (request_log_id) REFERENCES api_key_request_logs(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT fk_shared_key_earnings_key
    FOREIGN KEY (shared_key_id) REFERENCES shared_keys(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT fk_shared_key_earnings_user
    FOREIGN KEY (seller_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE TRIGGER shared_key_earnings_history_no_update
BEFORE UPDATE ON shared_key_earnings FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'credited_shared_key_earning_history_immutable';

CREATE TRIGGER shared_key_earnings_history_no_delete
BEFORE DELETE ON shared_key_earnings FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'credited_shared_key_earning_history_immutable';

CREATE TABLE shared_key_earning_history_anchors (
  earning_id VARCHAR(128) NOT NULL PRIMARY KEY,
  CONSTRAINT fk_shared_key_earning_history_anchor
    FOREIGN KEY (earning_id) REFERENCES shared_key_earnings(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO shared_key_earning_history_anchors(earning_id)
SELECT id FROM shared_key_earnings;

CREATE TRIGGER shared_key_earnings_history_anchor_after_insert
AFTER INSERT ON shared_key_earnings FOR EACH ROW
INSERT INTO shared_key_earning_history_anchors(earning_id) VALUES (NEW.id);

CREATE TRIGGER shared_key_earning_history_anchors_no_update
BEFORE UPDATE ON shared_key_earning_history_anchors FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'credited_shared_key_earning_history_immutable';

CREATE TRIGGER shared_key_earning_history_anchors_no_delete
BEFORE DELETE ON shared_key_earning_history_anchors FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'credited_shared_key_earning_history_immutable';
