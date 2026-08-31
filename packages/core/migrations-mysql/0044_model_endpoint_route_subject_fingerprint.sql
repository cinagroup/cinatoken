-- 0044: bind each model-endpoint route link to the exact route/provider
-- subject that was verified. Existing links intentionally remain NULL and
-- therefore fail closed until an administrator explicitly re-verifies them.

ALTER TABLE model_endpoint_routes
  ADD COLUMN subject_fingerprint CHAR(64)
    CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD CONSTRAINT model_endpoint_routes_subject_fingerprint_chk
    CHECK (
      subject_fingerprint IS NULL
      OR subject_fingerprint REGEXP '^[0-9a-f]{64}$'
    );
