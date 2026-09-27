-- REVIEW ONLY. Execute as one top-level direct migrator statement after the
-- v346 retention companion; CREATE INDEX CONCURRENTLY cannot run in a block.
CREATE INDEX CONCURRENTLY shared_key_buyer_budget_receipts_unobserved_v346
  ON cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts
    (xact_id,user_id) WHERE finalized_observed_at IS NULL;
