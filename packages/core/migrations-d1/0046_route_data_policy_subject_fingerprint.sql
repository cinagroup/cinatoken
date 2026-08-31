-- Bind every data-policy assertion to the exact route/provider configuration it verified.
ALTER TABLE route_data_policies ADD COLUMN subject_fingerprint TEXT;
ALTER TABLE route_data_policies ADD COLUMN invalidated_at TEXT;
ALTER TABLE route_data_policies ADD COLUMN invalidation_reason TEXT;

-- Pre-binding assertions cannot safely survive this migration. Keep their evidence for review,
-- but make the runtime and admin surfaces treat them as unverified until explicitly re-verified.
INSERT INTO route_data_policy_audit (id, route_target_id, snapshot_json, actor_id, created_at)
SELECT
  'migration-0046-' || lower(hex(randomblob(16))),
  route_target_id,
  json_object(
    'v', 2,
    'event', 'invalidated',
    'reason', 'subject_fingerprint_backfill_required',
    'previous_status', status
  ),
  'system:migration',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM route_data_policies
WHERE status = 'verified';

UPDATE route_data_policies
SET status = 'unknown',
    invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    invalidation_reason = 'subject_fingerprint_backfill_required',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'verified';
