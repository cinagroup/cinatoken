-- 0034: bounded daily aggregates for unauthenticated public model statistics.
-- Sixteen shards per model/day reduce hot-row contention on the request write path.

CREATE TABLE public_model_daily_stats (
  stat_date TEXT NOT NULL,
  model_id TEXT NOT NULL,
  shard INTEGER NOT NULL CHECK (shard >= 0 AND shard < 16),
  request_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_total_ms INTEGER NOT NULL DEFAULT 0,
  latency_sample_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_public_model_daily_stats UNIQUE (stat_date, model_id, shard)
);

INSERT INTO public_model_daily_stats (
  stat_date, model_id, shard, request_count, success_count, error_count,
  output_tokens, latency_total_ms, latency_sample_count, updated_at
)
SELECT
  substr(created_at, 1, 10), model_id, 0, COUNT(*),
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END),
  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END),
  COALESCE(SUM(output_tokens), 0), COALESCE(SUM(latency_ms), 0), COUNT(latency_ms), CURRENT_TIMESTAMP
FROM api_key_request_logs
WHERE model_id IS NOT NULL
  AND created_at >= datetime('now', '-90 days')
GROUP BY substr(created_at, 1, 10), model_id;
