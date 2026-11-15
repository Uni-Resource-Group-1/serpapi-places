CREATE TABLE google_request_reservations (
  run_id uuid PRIMARY KEY REFERENCES search_runs(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL UNIQUE,
  day_period text NOT NULL,
  month_period text NOT NULL,
  reserved integer NOT NULL CHECK (reserved >= 0),
  consumed integer NOT NULL DEFAULT 0 CHECK (consumed >= 0 AND consumed <= reserved),
  released integer NOT NULL DEFAULT 0 CHECK (released >= 0 AND consumed + released <= reserved),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((finished_at IS NULL) OR (consumed + released = reserved))
);

CREATE INDEX google_request_reservations_open_period_idx
  ON google_request_reservations (day_period, month_period)
  WHERE finished_at IS NULL;
