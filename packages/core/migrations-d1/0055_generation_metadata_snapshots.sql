-- Immutable, non-content metadata required by OpenRouter's Generation SDK contract.
-- Existing rows deliberately remain NULL: request origin, BYOK mode, region, and
-- USD-denominated costs must never be reconstructed after the request.

ALTER TABLE api_key_request_logs ADD COLUMN request_origin TEXT
  CHECK (request_origin IS NULL OR length(request_origin) BETWEEN 1 AND 512);
ALTER TABLE api_key_request_logs ADD COLUMN response_streamed INTEGER
  CHECK (response_streamed IS NULL OR response_streamed IN (0, 1));
ALTER TABLE api_key_request_logs ADD COLUMN data_region TEXT
  CHECK (data_region IS NULL OR data_region IN ('global', 'europe', 'us'));
ALTER TABLE api_key_request_logs ADD COLUMN is_byok INTEGER
  CHECK (is_byok IS NULL OR is_byok IN (0, 1));
ALTER TABLE api_key_request_logs ADD COLUMN charged_cost_usd REAL
  CHECK (charged_cost_usd IS NULL OR charged_cost_usd >= 0);
ALTER TABLE api_key_request_logs ADD COLUMN upstream_inference_cost_usd REAL
  CHECK (upstream_inference_cost_usd IS NULL OR upstream_inference_cost_usd >= 0);
