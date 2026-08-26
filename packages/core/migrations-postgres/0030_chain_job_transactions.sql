-- Durable signed transaction outbox for at-least-once Queue delivery.
SET search_path TO cinatoken_gateway;

CREATE TABLE chain_job_transactions (
  job_kind TEXT NOT NULL,
  job_id TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  raw_transaction TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  broadcast_at TIMESTAMPTZ,
  PRIMARY KEY (job_kind, job_id)
);

CREATE INDEX idx_chain_job_transactions_created
  ON chain_job_transactions(created_at, job_kind, job_id);
