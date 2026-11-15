import { useState, type FormEvent } from "react";
import type { SearchCriteria } from "../../shared/types.js";
import { api, ApiError } from "../api.js";
import { Modal } from "./Modal.js";

const REFRESH_OPTIONS = [
  { value: 0, label: "Manual only" },
  { value: 15, label: "Every 15 minutes" },
  { value: 60, label: "Every hour" },
  { value: 360, label: "Every 6 hours" },
  { value: 1440, label: "Every day" },
];

interface SaveSearchModalProps {
  criteria: SearchCriteria;
  onClose: () => void;
  onSaved: () => void;
  onNotify: (kind: "info" | "success" | "error", message: string) => void;
}

export function SaveSearchModal({ criteria, onClose, onSaved, onNotify }: SaveSearchModalProps) {
  const [name, setName] = useState(
    [criteria.keyword || "Places", criteria.area || criteria.city].filter(Boolean).join(" · ").slice(0, 120),
  );
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError("Give this search a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.saveSearch(name.trim(), criteria, refresh);
      onNotify("success", "Saved search created. Refreshes run in the background worker.");
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not save this search.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Save this search" onClose={onClose} size="small">
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="saved-search-name">Name</label>
          <input
            id="saved-search-name"
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="saved-search-refresh">Refresh</label>
          <select
            id="saved-search-refresh"
            value={refresh}
            onChange={(event) => setRefresh(Number(event.target.value))}
          >
            {REFRESH_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="field__hint">
            Automatic refreshes use SerpApi budget without asking again. Start with manual refreshes while you
            check result quality.
          </p>
        </div>
        <dl className="criteria-summary">
          <div>
            <dt>Location</dt>
            <dd>{[criteria.area, criteria.city, criteria.region, criteria.country].filter(Boolean).join(", ")}</dd>
          </div>
          <div>
            <dt>Query</dt>
            <dd>{criteria.keyword || criteria.category}</dd>
          </div>
          <div>
            <dt>Area</dt>
            <dd>
              {criteria.mode === "radius"
                ? `${Math.round(criteria.radiusMeters)} m radius`
                : "Selected map rectangle"}
            </dd>
          </div>
          <div>
            <dt>Sources</dt>
            <dd>{criteria.sources.map((source) => source === "osm" ? "OSM" : "SerpApi").join(" + ")}</dd>
          </div>
        </dl>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="button button--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={busy}>
            {busy ? "Saving…" : "Save search"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
