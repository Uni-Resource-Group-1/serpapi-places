ALTER TABLE export_jobs DROP CONSTRAINT IF EXISTS export_jobs_format_check;
ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_format_check
  CHECK (format IN ('csv', 'geojson', 'json', 'xlsx'));
