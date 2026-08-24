-- Durable signed transaction outbox for at-least-once Queue delivery.
-- The raw transaction is signed before persistence and broadcast only after it
-- is stored, so a retry always rebroadcasts the same hash instead of minting twice.

CREATE TABLE IF NOT EXISTS chain_job_transactions (
  job_kind TEXT NOT NULL,
  job_id TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  raw_transaction TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  broadcast_at TEXT,
  PRIMARY KEY (job_kind, job_id)
);

CREATE INDEX IF NOT EXISTS idx_chain_job_transactions_created
  ON chain_job_transactions(created_at, job_kind, job_id);
