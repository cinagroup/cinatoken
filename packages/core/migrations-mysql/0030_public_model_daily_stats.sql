-- 0030: bounded daily aggregates for unauthenticated public model statistics.
-- Sixteen shards per model/day reduce hot-row contention on the request write path.

CREATE TABLE public_model_daily_stats (
  stat_date VARCHAR(10) NOT NULL,
  model_id VARCHAR(512) NOT NULL,
  shard INT NOT NULL,
  request_count BIGINT NOT NULL DEFAULT 0,
  success_count BIGINT NOT NULL DEFAULT 0,
  error_count BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  latency_total_ms BIGINT NOT NULL DEFAULT 0,
  latency_sample_count BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT uk_public_model_daily_stats UNIQUE (stat_date, model_id, shard),
  CONSTRAINT public_model_daily_stats_shard_chk CHECK (shard >= 0 AND shard < 16)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @cinatoken_previous_time_zone = @@session.time_zone;
SET time_zone = '+00:00';

INSERT INTO public_model_daily_stats (
  stat_date, model_id, shard, request_count, success_count, error_count,
  output_tokens, latency_total_ms, latency_sample_count, updated_at
)
SELECT
	DATE_FORMAT(created_at, '%Y-%m-%d'), model_id, 0, COUNT(*),
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END),
  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END),
  COALESCE(SUM(output_tokens), 0), COALESCE(SUM(latency_ms), 0), COUNT(latency_ms), CURRENT_TIMESTAMP(6)
FROM api_key_request_logs
WHERE model_id IS NOT NULL
	AND created_at >= UTC_TIMESTAMP(6) - INTERVAL 90 DAY
GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d'), model_id;

SET time_zone = @cinatoken_previous_time_zone;
