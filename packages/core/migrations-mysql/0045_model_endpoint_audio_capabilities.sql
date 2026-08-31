-- 0045: exact operation-scoped audio pricing evidence for model endpoints.
-- Existing rows receive only the empty/unknown sentinel. No audio pricing is
-- inferred from legacy models.pricing_profile or endpoint text pricing.

ALTER TABLE model_endpoints
  ADD COLUMN audio_capabilities TEXT NOT NULL DEFAULT ('{}');
