-- REVIEW ONLY. Run only after inspecting the target D1 table/index catalogue,
-- row count, backup and a measured maintenance window. D1/SQLite CREATE INDEX
-- scans existing rows and writes the complete index; do not assume an online
-- concurrent build. A same-name index must fail instead of silently no-oping.
-- The leading key supports the four shared_key_id-scoped SUM/MAX rebuilds;
-- remaining columns make those aggregate reads covering in SQLite.

CREATE INDEX idx_shared_key_earnings_key_projection
  ON shared_key_earnings
    (shared_key_id, input_tokens, output_tokens, net_amount, created_at);
