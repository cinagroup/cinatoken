-- REVIEW ONLY. Execute as one top-level direct migrator statement after the
-- v346 retention companion; check pg_index.indisvalid after completion.
CREATE INDEX CONCURRENTLY shared_key_buyer_budget_receipts_retention_due_v346
  ON cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts
    (finalized_observed_at,xact_id,user_id)
    WHERE finalized_observed_at IS NOT NULL;
