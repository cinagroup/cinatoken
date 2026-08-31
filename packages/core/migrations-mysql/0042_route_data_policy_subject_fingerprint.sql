-- Bind every data-policy assertion to the exact route/provider configuration it verified.
ALTER TABLE route_data_policies
  ADD COLUMN subject_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN invalidated_at TIMESTAMP(6) NULL,
  ADD COLUMN invalidation_reason VARCHAR(128) NULL;

-- Existing verified assertions did not bind a subject and must fail closed until re-verified.
INSERT INTO route_data_policy_audit (id, route_target_id, snapshot_json, actor_id, created_at)
SELECT
  CONCAT('migration-0042-', UUID()),
  route_target_id,
  CAST(JSON_OBJECT(
    'v', 2,
    'event', 'invalidated',
    'reason', 'subject_fingerprint_backfill_required',
    'previous_status', status
  ) AS CHAR),
  'system:migration',
  CURRENT_TIMESTAMP(6)
FROM route_data_policies
WHERE status = 'verified';

UPDATE route_data_policies
SET status = 'unknown',
    invalidated_at = CURRENT_TIMESTAMP(6),
    invalidation_reason = 'subject_fingerprint_backfill_required',
    updated_at = CURRENT_TIMESTAMP(6)
WHERE status = 'verified';

ALTER TABLE route_data_policies
  ADD CONSTRAINT route_data_policies_subject_fingerprint_chk
  CHECK (subject_fingerprint IS NULL OR subject_fingerprint REGEXP '^[0-9a-f]{64}$');
