-- Retire the official Google Places source without deleting provider history,
-- source request records, counters, or reservation audit rows.
-- Existing historical rows remain valid; new source records and request rows
-- can only be written for OSM and SerpApi. In-flight old-version workers may
-- fail these writes after deployment; stop those workers before applying.
ALTER TABLE source_requests
  DROP CONSTRAINT IF EXISTS source_requests_source_check;
ALTER TABLE source_requests
  ADD CONSTRAINT source_requests_source_check
  CHECK (source IN ('osm', 'serpapi')) NOT VALID;

ALTER TABLE source_place_records
  DROP CONSTRAINT IF EXISTS source_place_records_source_check;
ALTER TABLE source_place_records
  ADD CONSTRAINT source_place_records_source_check
  CHECK (source IN ('osm', 'serpapi')) NOT VALID;

-- Keep these constraints NOT VALID: PostgreSQL still enforces them for new
-- writes, while validation would reject preserved historical Google rows.
-- Run after application code no longer writes legacy google_places_requests
-- columns. Keep those columns, budget scopes, and reservation rows for history;
-- the retired application does not read or increment the legacy counters.
