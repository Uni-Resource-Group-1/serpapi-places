-- Per-place export selection.
--
-- Export jobs previously covered a whole run, a whole collection, or the whole
-- saved set. Operators also need to export only the saved places they pick.
-- The existing scope vocabulary is kept ('saved' with a selection list), so the
-- export_jobs_scope_check constraint is untouched and historical rows stay valid.
--
-- `selection` holds a JSON array of saved_places.id values. NULL means "the
-- entire scope", preserving the behaviour of every existing row.
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS selection jsonb;

-- A 'saved' export is not anchored to a single run or collection, so scope_id
-- is meaningless for it. Allow NULL there while keeping it required elsewhere,
-- and stop treating the sentinel-less scope as an error in application code.
ALTER TABLE export_jobs ALTER COLUMN scope_id DROP NOT NULL;
ALTER TABLE export_jobs DROP CONSTRAINT IF EXISTS export_jobs_scope_id_required_check;
ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_scope_id_required_check
  CHECK ((scope = 'saved') OR (scope_id IS NOT NULL));