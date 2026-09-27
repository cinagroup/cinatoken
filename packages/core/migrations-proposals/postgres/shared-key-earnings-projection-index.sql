-- REVIEW ONLY. Do not add to the transactional formal migration runner.
-- Run on a separately reviewed target through a single-use migrator connection,
-- outside BEGIN/COMMIT. Confirm the table/index catalogue and measured build
-- window first. CREATE INDEX CONCURRENTLY permits normal earning writes but
-- waits for old writers/snapshots; a failed build can leave an INVALID index.
-- Do not use IF NOT EXISTS: a wrong or INVALID same-name index must fail closed.
-- On failure, inspect pg_index.indisvalid/indisready and explicitly decide
-- whether to DROP INDEX CONCURRENTLY before a separately approved retry.

SET lock_timeout = '2s';
SET statement_timeout = '15min';
CREATE INDEX CONCURRENTLY idx_shared_key_earnings_key_projection
  ON cinatoken_gateway.shared_key_earnings (shared_key_id)
  INCLUDE (input_tokens, output_tokens, net_amount, created_at);
RESET statement_timeout;
RESET lock_timeout;
