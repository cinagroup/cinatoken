-- Catalog copy (provider kind and model introductions) lives in static presets.
-- The former description columns are operator notes and are not returned by public APIs.

ALTER TABLE models ADD COLUMN note TEXT;
UPDATE models SET note = description;
ALTER TABLE providers ADD COLUMN note TEXT;
UPDATE providers SET note = description;
