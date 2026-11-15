ALTER TABLE saved_searches
  ADD COLUMN IF NOT EXISTS auto_refresh_skipped_at timestamptz;

ALTER TABLE saved_searches
  ADD COLUMN IF NOT EXISTS auto_refresh_skip_reason text;
