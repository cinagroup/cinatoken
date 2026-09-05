-- 0057: credential-free, per-upstream-attempt availability facts for Endpoint uptime.

CREATE TABLE provider_attempt_availability (
  request_log_id VARCHAR(512) NOT NULL,
  attempt_index INT NOT NULL,
  route_target_id VARCHAR(512) NOT NULL,
  provider_id VARCHAR(512) NOT NULL,
  outcome VARCHAR(16) NOT NULL,
  reason VARCHAR(32) NOT NULL,
  http_status INT NULL,
  observed_at DATETIME(6) NOT NULL,
  PRIMARY KEY (request_log_id, attempt_index),
  INDEX idx_provider_attempt_availability_route_observed
    (route_target_id, observed_at DESC),
  INDEX idx_provider_attempt_availability_observed (observed_at),
  CONSTRAINT fk_provider_attempt_availability_request_log
    FOREIGN KEY (request_log_id) REFERENCES api_key_request_logs(id) ON DELETE CASCADE,
  CONSTRAINT provider_attempt_availability_attempt_index_chk
    CHECK (attempt_index BETWEEN 1 AND 128),
  CONSTRAINT provider_attempt_availability_outcome_chk
    CHECK (outcome IN ('available', 'unavailable', 'excluded')),
  CONSTRAINT provider_attempt_availability_reason_chk
    CHECK (reason IN (
      'accepted', 'provider_http_error', 'rate_limited', 'network_error', 'invalid_response',
      'client_error', 'client_cancelled', 'unknown'
    )),
  CONSTRAINT provider_attempt_availability_http_status_chk
    CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
