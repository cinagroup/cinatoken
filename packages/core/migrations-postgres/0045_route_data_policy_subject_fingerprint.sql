-- Bind every data-policy assertion to the exact route/provider configuration it verified.
ALTER TABLE route_data_policies ADD COLUMN subject_fingerprint TEXT;
ALTER TABLE route_data_policies ADD COLUMN invalidated_at TIMESTAMPTZ;
ALTER TABLE route_data_policies ADD COLUMN invalidation_reason TEXT;

-- Existing verified assertions did not bind a subject and must fail closed until re-verified.
INSERT INTO route_data_policy_audit (id, route_target_id, snapshot_json, actor_id, created_at)
SELECT
  'migration-0045-' || md5(route_target_id || clock_timestamp()::text || random()::text),
  route_target_id,
  json_build_object(
    'v', 2,
    'event', 'invalidated',
    'reason', 'subject_fingerprint_backfill_required',
    'previous_status', status
  )::text,
  'system:migration',
  CURRENT_TIMESTAMP
FROM route_data_policies
WHERE status = 'verified';

UPDATE route_data_policies
SET status = 'unknown',
    invalidated_at = CURRENT_TIMESTAMP,
    invalidation_reason = 'subject_fingerprint_backfill_required',
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'verified';

ALTER TABLE route_data_policies
  ADD CONSTRAINT route_data_policies_subject_fingerprint_chk
  CHECK (subject_fingerprint IS NULL OR subject_fingerprint ~ '^[0-9a-f]{64}$');
