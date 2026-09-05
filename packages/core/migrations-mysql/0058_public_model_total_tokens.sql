-- 0058: authoritative input + output token volume for weekly model popularity.

ALTER TABLE public_model_daily_stats
  ADD COLUMN total_tokens BIGINT NOT NULL DEFAULT 0 AFTER output_tokens;

SET @cinatoken_previous_time_zone = @@session.time_zone;
SET time_zone = '+00:00';

-- Rehydrate the retained window without touching request/success/latency facts.
-- Shard 0 owns the historical model/day total; live writes remain distributed.
INSERT INTO public_model_daily_stats (
  stat_date, model_id, shard, request_count, success_count, error_count,
  output_tokens, latency_total_ms, latency_sample_count, updated_at, total_tokens
)
SELECT
  DATE_FORMAT(created_at, '%Y-%m-%d'), model_id, 0, 0, 0, 0,
  0, 0, 0, CURRENT_TIMESTAMP(6), COALESCE(SUM(total_tokens), 0)
FROM api_key_request_logs
WHERE model_id IS NOT NULL
  AND created_at >= UTC_TIMESTAMP(6) - INTERVAL 90 DAY
GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d'), model_id
ON DUPLICATE KEY UPDATE
  total_tokens = VALUES(total_tokens),
  updated_at = VALUES(updated_at);

SET time_zone = @cinatoken_previous_time_zone;
