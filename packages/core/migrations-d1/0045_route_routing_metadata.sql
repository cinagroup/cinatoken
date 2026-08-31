-- Endpoint capabilities used by provider preference routing. This column is
-- intentionally separate from custom_params, which is forwarded upstream.
ALTER TABLE model_routes ADD COLUMN routing_metadata TEXT;
