-- Credited earnings are append-only financial facts, including retention jobs
-- and parent cascades. Normal INSERT/ON CONFLICT DO NOTHING crediting and
-- shared-key statistics repair remain unchanged. No credit/balance is replayed.
-- Old applications may continue ordinary inserts/updates but used-key/log/seller
-- deletion fails and rolls back. Disable keys instead; append reviewed facts for
-- corrections. Keep these guards when rolling an application back.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;

LOCK TABLE cinatoken_gateway.shared_key_earnings IN SHARE ROW EXCLUSIVE MODE;

-- 0031 already restricted the log; make all three parent edges explicit.
ALTER TABLE cinatoken_gateway.shared_key_earnings
  DROP CONSTRAINT shared_key_earnings_request_log_id_fkey,
  DROP CONSTRAINT shared_key_earnings_shared_key_id_fkey,
  DROP CONSTRAINT shared_key_earnings_seller_user_id_fkey,
  ADD CONSTRAINT shared_key_earnings_request_log_id_fkey
    FOREIGN KEY (request_log_id) REFERENCES cinatoken_gateway.api_key_request_logs(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT shared_key_earnings_shared_key_id_fkey
    FOREIGN KEY (shared_key_id) REFERENCES cinatoken_gateway.shared_keys(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT shared_key_earnings_seller_user_id_fkey
    FOREIGN KEY (seller_user_id) REFERENCES cinatoken_gateway.users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT;

-- Replace the review-only proposal's exact binding atomically, if installed.
CREATE OR REPLACE FUNCTION cinatoken_gateway.reject_shared_key_earnings_history_mutation()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp AS $reject$
BEGIN
  IF TG_RELID <> 'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
    OR (TG_NAME = 'shared_key_earnings_history_immutable'
      AND TG_OP NOT IN ('UPDATE','DELETE'))
    OR (TG_NAME = 'shared_key_earnings_history_no_truncate'
      AND TG_OP <> 'TRUNCATE')
    OR TG_NAME NOT IN ('shared_key_earnings_history_immutable',
      'shared_key_earnings_history_no_truncate') THEN
    RAISE EXCEPTION 'Shared-key earning history trigger binding differs';
  END IF;
  -- Empty tables contain no historical fact to erase. Permit pristine-target
  -- cutover/reset while the TRUNCATE table lock excludes concurrent inserts.
  IF TG_OP = 'TRUNCATE'
    AND NOT EXISTS (SELECT 1 FROM cinatoken_gateway.shared_key_earnings) THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'Credited shared-key earning history is immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'shared_key_earnings_history_immutable';
END;
$reject$;

DROP TRIGGER IF EXISTS shared_key_earnings_history_immutable
  ON cinatoken_gateway.shared_key_earnings;
DROP TRIGGER IF EXISTS shared_key_earnings_history_no_truncate
  ON cinatoken_gateway.shared_key_earnings;
CREATE TRIGGER shared_key_earnings_history_immutable
  BEFORE UPDATE OR DELETE ON cinatoken_gateway.shared_key_earnings
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.reject_shared_key_earnings_history_mutation();
CREATE TRIGGER shared_key_earnings_history_no_truncate
  BEFORE TRUNCATE ON cinatoken_gateway.shared_key_earnings
  FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_gateway.reject_shared_key_earnings_history_mutation();

REVOKE ALL ON FUNCTION cinatoken_gateway.reject_shared_key_earnings_history_mutation()
  FROM PUBLIC;
