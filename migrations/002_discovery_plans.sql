-- Opt-in tiled discovery, known-place imports, and Google Places discovery.

ALTER TABLE search_runs ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'standard';
ALTER TABLE search_runs DROP CONSTRAINT IF EXISTS search_runs_plan_check;
ALTER TABLE search_runs ADD CONSTRAINT search_runs_plan_check
  CHECK (plan IN ('standard', 'tiled', 'import'));

ALTER TABLE search_runs ADD COLUMN IF NOT EXISTS pages_google_places integer NOT NULL DEFAULT 0;
ALTER TABLE search_runs ADD COLUMN IF NOT EXISTS google_places_requests integer NOT NULL DEFAULT 0;

ALTER TABLE source_requests DROP CONSTRAINT IF EXISTS source_requests_source_check;
ALTER TABLE source_requests ADD CONSTRAINT source_requests_source_check
  CHECK (source IN ('osm', 'serpapi', 'google_places'));

ALTER TABLE source_place_records DROP CONSTRAINT IF EXISTS source_place_records_source_check;
ALTER TABLE source_place_records ADD CONSTRAINT source_place_records_source_check
  CHECK (source IN ('osm', 'serpapi', 'google_places'));

CREATE INDEX IF NOT EXISTS source_place_google_idx
  ON source_place_records (source, last_seen_at DESC)
  WHERE source = 'google_places';
