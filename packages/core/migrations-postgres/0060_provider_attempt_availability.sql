-- 0060: credential-free, per-upstream-attempt availability facts for Endpoint uptime.

SET search_path TO cinatoken_gateway;

CREATE TABLE provider_attempt_availability (
  request_log_id TEXT NOT NULL
    REFERENCES api_key_request_logs(id) ON DELETE CASCADE,
  attempt_index INTEGER NOT NULL
    CHECK (attempt_index BETWEEN 1 AND 128),
  route_target_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  outcome TEXT NOT NULL
    CHECK (outcome IN ('available', 'unavailable', 'excluded')),
  reason TEXT NOT NULL
    CHECK (reason IN (
      'accepted', 'provider_http_error', 'rate_limited', 'network_error', 'invalid_response',
      'client_error', 'client_cancelled', 'unknown'
    )),
  http_status INTEGER
    CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  observed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (request_log_id, attempt_index)
);

CREATE INDEX idx_provider_attempt_availability_route_observed
  ON provider_attempt_availability(route_target_id, observed_at DESC);

CREATE INDEX idx_provider_attempt_availability_observed
  ON provider_attempt_availability(observed_at);

-- Runtime receives EXECUTE but no table DELETE privilege. The definer function
-- is the only PostgreSQL retention path and enforces both batch and recency
-- boundaries inside the database.
CREATE FUNCTION delete_provider_attempt_availability_before(
  p_cutoff TIMESTAMPTZ,
  p_limit INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, cinatoken_gateway
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  IF p_cutoff IS NULL
    OR p_limit IS NULL
    OR p_limit < 1
    OR p_limit > 5000
    OR p_cutoff > statement_timestamp() - INTERVAL '25 hours'
  THEN
    RAISE EXCEPTION 'provider attempt retention parameters are outside the safe boundary';
  END IF;

  WITH retention_batch AS (
    SELECT ctid
    FROM cinatoken_gateway.provider_attempt_availability
    WHERE observed_at < p_cutoff
    ORDER BY observed_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM cinatoken_gateway.provider_attempt_availability AS facts
  USING retention_batch
  WHERE facts.ctid = retention_batch.ctid;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION delete_provider_attempt_availability_before(TIMESTAMPTZ, INTEGER)
  FROM PUBLIC;
