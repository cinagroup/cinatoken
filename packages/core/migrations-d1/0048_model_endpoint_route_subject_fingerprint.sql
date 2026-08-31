-- 0048: bind each model-endpoint route link to the exact route/provider
-- subject that was verified. Existing links intentionally remain NULL and
-- therefore fail closed until an administrator explicitly re-verifies them.

ALTER TABLE model_endpoint_routes
  ADD COLUMN subject_fingerprint TEXT
  CHECK (
    subject_fingerprint IS NULL OR (
      length(subject_fingerprint) = 64
      AND subject_fingerprint NOT GLOB '*[^0-9a-f]*'
    )
  );
