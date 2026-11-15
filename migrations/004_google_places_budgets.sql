ALTER TABLE usage_counters
  DROP CONSTRAINT IF EXISTS usage_counters_scope_check;

ALTER TABLE usage_counters
  ADD CONSTRAINT usage_counters_scope_check
  CHECK (scope IN ('serpapi_month', 'serpapi_day', 'google_places_month', 'google_places_day'));

ALTER TABLE search_runs
  ADD COLUMN IF NOT EXISTS approved_google_max_requests integer;

ALTER TABLE search_runs
  DROP CONSTRAINT IF EXISTS search_runs_approved_google_max_requests_check;

ALTER TABLE search_runs
  ADD CONSTRAINT search_runs_approved_google_max_requests_check
  CHECK (approved_google_max_requests IS NULL OR approved_google_max_requests > 0);
