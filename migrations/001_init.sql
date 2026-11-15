CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  csrf_token text NOT NULL,
  display_name text NOT NULL,
  user_agent text,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS app_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  serpapi_monthly_limit integer NOT NULL CHECK (serpapi_monthly_limit >= 0),
  serpapi_daily_limit integer NOT NULL CHECK (serpapi_daily_limit >= 0),
  serpapi_max_pages integer NOT NULL CHECK (serpapi_max_pages BETWEEN 1 AND 10),
  serpapi_max_results integer NOT NULL CHECK (serpapi_max_results BETWEEN 20 AND 500),
  serpapi_price_usd numeric(10, 4) NOT NULL CHECK (serpapi_price_usd >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

CREATE TABLE IF NOT EXISTS usage_counters (
  scope text NOT NULL CHECK (scope IN ('serpapi_month', 'serpapi_day', 'google_places_month', 'google_places_day')),
  period text NOT NULL,
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, period)
);

CREATE TABLE IF NOT EXISTS saved_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  criteria jsonb NOT NULL,
  refresh_interval_minutes integer NOT NULL DEFAULT 0 CHECK (refresh_interval_minutes BETWEEN 0 AND 10080),
  last_run_at timestamptz,
  last_run_id uuid,
  last_auto_run_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_searches_due_idx
  ON saved_searches (refresh_interval_minutes, last_run_at)
  WHERE refresh_interval_minutes > 0;

CREATE TABLE IF NOT EXISTS search_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  saved_search_id uuid REFERENCES saved_searches(id) ON DELETE SET NULL,
  label text,
  criteria jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS search_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id uuid REFERENCES search_definitions(id) ON DELETE SET NULL,
  saved_search_id uuid REFERENCES saved_searches(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
  coverage text CHECK (coverage IN ('within_limits', 'capped', 'partial', 'failed')),
  criteria jsonb NOT NULL,
  sources text[] NOT NULL,
  center_lat double precision,
  center_lon double precision,
  radius_m double precision,
  bounds jsonb,
  keyword text,
  category text,
  requested_max_pages integer NOT NULL,
  requested_max_results integer NOT NULL,
  serpapi_requests integer NOT NULL DEFAULT 0,
  osm_requests integer NOT NULL DEFAULT 0,
  pages_osm integer NOT NULL DEFAULT 0,
  pages_serpapi integer NOT NULL DEFAULT 0,
  result_count integer NOT NULL DEFAULT 0,
  filtered_out integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  truncated boolean NOT NULL DEFAULT false,
  credits_estimated integer NOT NULL DEFAULT 0,
  credits_actual integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  caveats jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_summaries jsonb NOT NULL DEFAULT '[]'::jsonb,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text UNIQUE,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz
);
CREATE INDEX IF NOT EXISTS search_runs_queue_idx ON search_runs (status, created_at);
CREATE INDEX IF NOT EXISTS search_runs_created_idx ON search_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS search_runs_saved_idx ON search_runs (saved_search_id, created_at DESC);

CREATE TABLE IF NOT EXISTS source_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES search_runs(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('osm', 'serpapi', 'google_places')),
  page integer NOT NULL DEFAULT 0,
  fingerprint text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  http_status integer,
  result_count integer NOT NULL DEFAULT 0,
  kept_count integer NOT NULL DEFAULT 0,
  filtered_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  cached boolean NOT NULL DEFAULT false,
  credits_estimated integer NOT NULL DEFAULT 0,
  credits_actual integer NOT NULL DEFAULT 0,
  duration_ms integer,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'success', 'error', 'skipped', 'capped')),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS source_requests_run_idx ON source_requests (run_id, source, page);
CREATE UNIQUE INDEX IF NOT EXISTS source_requests_page_success_idx
  ON source_requests (run_id, source, page, fingerprint)
  WHERE status = 'success';

CREATE TABLE IF NOT EXISTS canonical_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  merged_into_id uuid REFERENCES canonical_places(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_place_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('osm', 'serpapi')),
  source_type text NOT NULL,
  source_id text NOT NULL,
  source_url text,
  canonical_place_id uuid REFERENCES canonical_places(id) ON DELETE SET NULL,
  name text NOT NULL,
  address text,
  category text,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  details_status text NOT NULL DEFAULT 'not_available'
    CHECK (details_status IN ('not_fetched', 'fetched', 'failed', 'not_available')),
  details_fetched_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE (source, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS source_place_bbox_idx ON source_place_records (lat, lon);
CREATE INDEX IF NOT EXISTS source_place_source_idx ON source_place_records (source, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS source_place_expiry_idx ON source_place_records (expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS source_place_canonical_idx ON source_place_records (canonical_place_id);

CREATE TABLE IF NOT EXISTS run_places (
  run_id uuid NOT NULL REFERENCES search_runs(id) ON DELETE CASCADE,
  source_record_id uuid NOT NULL REFERENCES source_place_records(id) ON DELETE CASCADE,
  distance_m double precision,
  position integer,
  possible_duplicate boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, source_record_id)
);
CREATE INDEX IF NOT EXISTS run_places_record_idx ON run_places (source_record_id);

CREATE TABLE IF NOT EXISTS place_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  a_source_record_id uuid NOT NULL REFERENCES source_place_records(id) ON DELETE CASCADE,
  b_source_record_id uuid NOT NULL REFERENCES source_place_records(id) ON DELETE CASCADE,
  score numeric(4, 3) NOT NULL CHECK (score BETWEEN 0 AND 1),
  signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'candidate'
    CHECK (state IN ('candidate', 'approved', 'rejected')),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (a_source_record_id <> b_source_record_id),
  UNIQUE (a_source_record_id, b_source_record_id)
);
CREATE INDEX IF NOT EXISTS place_matches_state_idx ON place_matches (state, created_at DESC);

CREATE TABLE IF NOT EXISTS saved_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id uuid REFERENCES source_place_records(id) ON DELETE SET NULL,
  canonical_place_id uuid REFERENCES canonical_places(id) ON DELETE SET NULL,
  snapshot jsonb NOT NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS saved_places_record_unique_idx
  ON saved_places (source_record_id)
  WHERE source_record_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR char_length(description) <= 1000),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  saved_place_id uuid NOT NULL REFERENCES saved_places(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, saved_place_id)
);

CREATE TABLE IF NOT EXISTS place_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id uuid NOT NULL REFERENCES source_place_records(id) ON DELETE CASCADE,
  page integer NOT NULL,
  review_key text NOT NULL,
  author_name text,
  rating numeric(2, 1),
  date_text text,
  snippet text,
  likes integer,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE (source_record_id, review_key)
);
CREATE INDEX IF NOT EXISTS place_reviews_record_idx ON place_reviews (source_record_id, page);

CREATE TABLE IF NOT EXISTS enrichment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id uuid NOT NULL REFERENCES source_place_records(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('details', 'reviews')),
  page integer,
  status text NOT NULL CHECK (status IN ('success', 'error', 'blocked')),
  credits_estimated integer NOT NULL DEFAULT 0,
  credits_actual integer NOT NULL DEFAULT 0,
  fields_returned integer NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  requested_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS enrichment_history_record_idx
  ON enrichment_history (source_record_id, created_at DESC);

CREATE TABLE IF NOT EXISTS export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('run', 'collection', 'saved')),
  scope_id uuid NOT NULL,
  format text NOT NULL CHECK (format IN ('csv', 'geojson', 'json')),
  fields text[] NOT NULL,
  sources text[] NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'expired')),
  row_count integer,
  omitted_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  manifest jsonb,
  file_name text,
  file_path text,
  error text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS export_jobs_queue_idx ON export_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS export_jobs_created_idx ON export_jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS serpapi_page_cache (
  fingerprint text PRIMARY KEY,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS serpapi_cache_expiry_idx ON serpapi_page_cache (expires_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_action_idx ON audit_events (action, created_at DESC);
