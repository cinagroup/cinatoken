-- Opaque per-key revision for compare-and-set Admin configuration writes.
-- Existing rows begin at a shared initial token; every new Admin write replaces it.
ALTER TABLE system_config ADD COLUMN revision VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'legacy';
