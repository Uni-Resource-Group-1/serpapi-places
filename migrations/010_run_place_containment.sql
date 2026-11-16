-- Result containment metadata.
--
-- Provider searches sample a map viewport rather than a precise boundary, so a
-- valid returned place can sit outside the radius, rectangle, or polygon the
-- operator selected. Records are deliberately retained; this column lets the UI
-- and exports hide them by default without deleting anything.
--
-- area_check records which geometry produced the verdict:
--   radius  -> straight-line distance from the selected center
--   bounds  -> selected/resolved rectangle
--   polygon -> resolved OpenStreetMap administrative polygon
-- NULL means the run had no usable geometry (or predates this migration), and
-- consumers must treat the verdict as unknown rather than "outside".
ALTER TABLE run_places ADD COLUMN IF NOT EXISTS inside_area boolean;
ALTER TABLE run_places ADD COLUMN IF NOT EXISTS area_check text;

ALTER TABLE run_places DROP CONSTRAINT IF EXISTS run_places_area_check_valid;
ALTER TABLE run_places ADD CONSTRAINT run_places_area_check_valid
  CHECK (area_check IS NULL OR area_check IN ('radius', 'bounds', 'polygon'));

-- Optional export filter: only rows the run classified as inside the selected
-- area. Defaults to false so existing and new exports keep their full contents
-- unless the operator explicitly narrows them.
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS inside_only boolean NOT NULL DEFAULT false;

-- Download bookkeeping so the UI can prove a file was already retrieved and
-- avoid presenting an identical file without context.
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS download_count integer NOT NULL DEFAULT 0;
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS last_downloaded_at timestamptz;
