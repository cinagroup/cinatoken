-- Immutable, non-content metadata required by OpenRouter's Generation SDK contract.
-- Existing rows deliberately remain NULL because these facts are not safely backfillable.

ALTER TABLE api_key_request_logs
  ADD COLUMN request_origin TEXT,
  ADD COLUMN response_streamed BOOLEAN,
  ADD COLUMN data_region TEXT,
  ADD COLUMN is_byok BOOLEAN,
  ADD COLUMN charged_cost_usd NUMERIC(24, 12),
  ADD COLUMN upstream_inference_cost_usd NUMERIC(24, 12),
  ADD CONSTRAINT api_key_request_logs_request_origin_length_chk
    CHECK (request_origin IS NULL OR length(request_origin) BETWEEN 1 AND 512),
  ADD CONSTRAINT api_key_request_logs_data_region_chk
    CHECK (data_region IS NULL OR data_region IN ('global', 'europe', 'us')),
  ADD CONSTRAINT api_key_request_logs_charged_cost_usd_chk
    CHECK (charged_cost_usd IS NULL OR charged_cost_usd >= 0),
  ADD CONSTRAINT api_key_request_logs_upstream_cost_usd_chk
    CHECK (upstream_inference_cost_usd IS NULL OR upstream_inference_cost_usd >= 0);
