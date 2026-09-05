-- 0061: credential-free, per-upstream-attempt availability facts for Endpoint uptime.

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
  observed_at TEXT NOT NULL,
  PRIMARY KEY (request_log_id, attempt_index)
);

CREATE INDEX idx_provider_attempt_availability_route_observed
  ON provider_attempt_availability(route_target_id, observed_at DESC);

CREATE INDEX idx_provider_attempt_availability_observed
  ON provider_attempt_availability(observed_at);
