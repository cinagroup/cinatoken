-- 0062: authoritative input + output token volume for weekly model popularity.

ALTER TABLE public_model_daily_stats
  ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;

-- Rehydrate the retained window without touching request/success/latency facts.
-- Shard 0 owns the historical model/day total; live writes remain distributed.
INSERT INTO public_model_daily_stats (
  stat_date, model_id, shard, request_count, success_count, error_count,
  output_tokens, latency_total_ms, latency_sample_count, updated_at, total_tokens
)
SELECT
  substr(created_at, 1, 10), model_id, 0, 0, 0, 0,
  0, 0, 0, CURRENT_TIMESTAMP, COALESCE(SUM(total_tokens), 0)
FROM api_key_request_logs
WHERE model_id IS NOT NULL
  AND created_at >= datetime('now', '-90 days')
GROUP BY substr(created_at, 1, 10), model_id
ON CONFLICT(stat_date, model_id, shard) DO UPDATE SET
  total_tokens = excluded.total_tokens,
  updated_at = excluded.updated_at;
