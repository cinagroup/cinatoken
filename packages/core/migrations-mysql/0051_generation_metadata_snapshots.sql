-- Immutable, non-content metadata required by OpenRouter's Generation SDK contract.
-- Existing rows deliberately remain NULL because these facts are not safely backfillable.

ALTER TABLE api_key_request_logs
  ADD COLUMN request_origin VARCHAR(512) NULL,
  ADD COLUMN response_streamed TINYINT NULL,
  ADD COLUMN data_region VARCHAR(16) NULL,
  ADD COLUMN is_byok TINYINT NULL,
  ADD COLUMN charged_cost_usd DECIMAL(24, 12) NULL,
  ADD COLUMN upstream_inference_cost_usd DECIMAL(24, 12) NULL,
  ADD CONSTRAINT api_key_request_logs_response_streamed_chk
    CHECK (response_streamed IS NULL OR response_streamed IN (0, 1)),
  ADD CONSTRAINT api_key_request_logs_data_region_chk
    CHECK (data_region IS NULL OR data_region IN ('global', 'europe', 'us')),
  ADD CONSTRAINT api_key_request_logs_is_byok_chk
    CHECK (is_byok IS NULL OR is_byok IN (0, 1)),
  ADD CONSTRAINT api_key_request_logs_charged_cost_usd_chk
    CHECK (charged_cost_usd IS NULL OR charged_cost_usd >= 0),
  ADD CONSTRAINT api_key_request_logs_upstream_cost_usd_chk
    CHECK (upstream_inference_cost_usd IS NULL OR upstream_inference_cost_usd >= 0);
