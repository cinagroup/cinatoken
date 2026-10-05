-- Administrative withdrawal rejection must also exclude durable signed jobs.
-- MySQL previously lacked the D1/PostgreSQL chain_job_transactions table.
-- This adds its persistence schema; it does not enable MySQL Chain Worker use.

CREATE TABLE chain_job_transactions (
  job_kind VARCHAR(32) NOT NULL,
  job_id VARCHAR(128) NOT NULL,
  tx_hash VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  raw_transaction LONGTEXT NOT NULL,
  chain_id INT NOT NULL,
  created_at TIMESTAMP(6) NOT NULL,
  broadcast_at TIMESTAMP(6) NULL,
  PRIMARY KEY (job_kind, job_id),
  UNIQUE KEY uk_chain_job_transactions_hash (tx_hash),
  KEY idx_chain_job_transactions_created (created_at, job_kind, job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
