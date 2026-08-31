-- 0047: bind each model-endpoint route link to the exact route/provider
-- subject that was verified. Existing links intentionally remain NULL and
-- therefore fail closed until an administrator explicitly re-verifies them.

ALTER TABLE model_endpoint_routes
  ADD COLUMN subject_fingerprint TEXT;

ALTER TABLE model_endpoint_routes
  ADD CONSTRAINT model_endpoint_routes_subject_fingerprint_chk
  CHECK (
    subject_fingerprint IS NULL
    OR subject_fingerprint ~ '^[0-9a-f]{64}$'
  );
