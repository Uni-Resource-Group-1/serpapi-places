import { useEffect, useMemo, useState } from "react";
import type { Collection, ExportFormat, ExportJob, SavedPlaceSummary, SearchRun } from "../../shared/types.js";
import { DEFAULT_EXPORT_FIELDS, EXPORT_FIELDS, RESTRICTED_EXPORT_FIELDS } from "../../shared/export-fields.js";
import { api, ApiError, downloadExport } from "../api.js";
import { formatDateTime } from "../format.js";
import { Modal } from "./Modal.js";
import { Badge, Spinner } from "./Feedback.js";

interface ExportModalProps {
  runs: SearchRun[];
  collections: Collection[];
  defaultTarget: { scope: "run" | "collection" | "saved"; id?: string } | null;
  selectedSavedPlaceIds?: string[];
  serpapiExportEnabled: boolean;
  onClose: () => void;
  onNotify: (kind: "info" | "success" | "error", message: string) => void;
}

const FORMATS: Array<{ value: ExportFormat; label: string; hint: string }> = [
  { value: "csv", label: "CSV", hint: "Spreadsheet-friendly, formula-safe cells" },
  { value: "xlsx", label: "Excel (.xlsx)", hint: "Up to 5,000 rows, safe text cells" },
  { value: "geojson", label: "GeoJSON", hint: "WGS84 point features plus manifest" },
  { value: "json", label: "JSON", hint: "Records with provenance and manifest" },
];

function jobTone(status: ExportJob["status"]): "ok" | "warn" | "error" | "busy" {
  if (status === "completed") return "ok";
  if (status === "failed") return "error";
  if (status === "expired") return "warn";
  return "busy";
}

export function ExportModal({
  runs,
  collections,
  defaultTarget,
  selectedSavedPlaceIds = [],
  serpapiExportEnabled,
  onClose,
  onNotify,
}: ExportModalProps) {
  const finishedRuns = useMemo(
    () => runs.filter((run) => run.status === "completed" || run.status === "partial"),
    [runs],
  );
  const [scope, setScope] = useState<"run" | "collection" | "saved">(
    defaultTarget?.scope === "saved" || (selectedSavedPlaceIds.length > 0 && defaultTarget?.scope !== "run")
      ? "saved"
      : defaultTarget?.scope ?? (finishedRuns.length > 0 ? "run" : collections.length > 0 ? "collection" : "saved"),
  );
  const [savedPlaceIds, setSavedPlaceIds] = useState<string[]>(selectedSavedPlaceIds);
  const [summaries, setSummaries] = useState<SavedPlaceSummary[]>([]);
  const [summariesLoaded, setSummariesLoaded] = useState(false);
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [scopeId, setScopeId] = useState(
    defaultTarget?.id ?? finishedRuns[0]?.id ?? collections[0]?.id ?? "",
  );
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [sources, setSources] = useState<string[]>([
    "osm",
    ...(serpapiExportEnabled ? ["serpapi"] : []),
  ]);
  const [fields, setFields] = useState<Set<string>>(new Set(DEFAULT_EXPORT_FIELDS));
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deletingJob, setDeletingJob] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);

  const loadJobs = async () => {
    try {
      const result = await api.exportJobs();
      setJobs(result.jobs);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not load export jobs.");
    } finally {
      setLoadingJobs(false);
    }
  };

  useEffect(() => {
    void loadJobs();
    void api.savedPlaceSummaries()
      .then((result) => {
        setSummaries(result.places);
        setSavedPlaceIds((current) => current.filter((id) => result.places.some((place) => place.id === id)));
        setSummariesLoaded(true);
      })
      .catch((caught) => {
        setPlaceError(caught instanceof ApiError ? caught.message : "Could not load saved places.");
        setSummariesLoaded(true);
      });
  }, []);

  useEffect(() => {
    if (!jobs.some((job) => job.status === "queued" || job.status === "running")) return;
    const timer = window.setInterval(() => void loadJobs(), 2500);
    return () => window.clearInterval(timer);
  }, [jobs]);

  const options = scope === "run" ? finishedRuns : collections;
  const selectedReasonMissing =
    scope === "run" ? finishedRuns.length === 0 : scope === "collection" ? collections.length === 0 : false;
  const filteredSavedPlaces = useMemo(() => {
    const query = placeQuery.trim().toLocaleLowerCase();
    if (!query) return summaries;
    return summaries.filter((place) =>
      [place.name, place.address ?? "", place.category ?? "", place.note ?? ""]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [placeQuery, summaries]);
  const toggleSavedPlace = (id: string) => {
    setSavedPlaceIds((current) =>
      current.includes(id) ? current.filter((placeId) => placeId !== id) : [...current, id],
    );
  };
  const selectVisiblePlaces = (select: boolean) => {
    const visibleIds = new Set(filteredSavedPlaces.map((place) => place.id));
    setSavedPlaceIds((current) => {
      if (select) return [...new Set([...current, ...visibleIds])];
      return current.filter((id) => !visibleIds.has(id));
    });
  };

  const toggleField = (id: string) => {
    setFields((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSource = (source: string) => {
    setSources((current) =>
      current.includes(source) ? current.filter((item) => item !== source) : [...current, source],
    );
  };

  const submit = async () => {
    if (scope !== "saved" && !scopeId) {
      setError("Choose a completed run or a collection to export.");
      return;
    }
    if (scope === "saved" && savedPlaceIds.length === 0) {
      setError("Select at least one saved place to export.");
      return;
    }
    if (fields.size === 0) {
      setError("Choose at least one field.");
      return;
    }
    if (sources.length === 0) {
      setError("Choose at least one source.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const job = await api.createExport({
        scope,
        ...(scope === "saved"
          ? { savedPlaceIds }
          : { scopeId }),
        format,
        fields: [...fields],
        sources,
      });
      setJobs((current) => [job, ...current]);
      onNotify("info", "Export queued. The worker builds it in the background.");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not queue the export.");
    } finally {
      setBusy(false);
    }
  };

  const removeJob = async (job: ExportJob) => {
    const label = `the ${job.format.toUpperCase()} export from ${formatDateTime(job.createdAt)}`;
    if (!window.confirm(`Delete ${label}? This removes the history entry and any generated ZIP file. This cannot be undone.`)) {
      return;
    }
    setDeletingJob(job.id);
    setError(null);
    try {
      const result = await api.deleteExportJob(job.id);
      setJobs((current) => current.filter((item) => item.id !== job.id));
      onNotify(
        result.fileCleanupFailed ? "error" : "success",
        result.fileCleanupFailed
          ? "Export history was deleted, but its ZIP file could not be removed. Check the server logs for cleanup details."
          : result.fileDeleted
            ? "Export and its generated file were deleted."
            : "Export history entry deleted. No generated file remained to remove.",
      );
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : "Could not delete this export.";
      setError(message);
      onNotify("error", message);
    } finally {
      setDeletingJob(null);
    }
  };

  return (
    <Modal
      title="Exports"
      subtitle="Every archive contains the data file, manifest.json, and ATTRIBUTION.txt. SerpApi place and stored review records are included for this workspace's own use; do not republish or resell them without the necessary rights."
      onClose={onClose}
      size="large"
    >
      <section className="export-builder" aria-labelledby="export-build-heading">
        <div className="export-builder__heading">
          <h3 id="export-build-heading">New export</h3>
          {scope === "saved" && savedPlaceIds.length > 0 ? (
            <span className="export-builder__scope">
              <Badge tone="busy">{savedPlaceIds.length} selected place{savedPlaceIds.length === 1 ? "" : "s"}</Badge>
            </span>
          ) : null}
        </div>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="export-scope">Export from</label>
            <select
              id="export-scope"
              value={scope}
              onChange={(event) => {
                const next = event.target.value as "run" | "collection" | "saved";
                setScope(next);
                if (next === "run") setScopeId(finishedRuns[0]?.id ?? "");
                else if (next === "collection") setScopeId(collections[0]?.id ?? "");
              }}
            >
              <option value="run">Completed search run</option>
              <option value="collection">Saved collection</option>
              <option value="saved">
                Choose saved places
                {savedPlaceIds.length > 0 ? ` (${savedPlaceIds.length} selected)` : ""}
              </option>
            </select>
          </div>
          {scope === "saved" ? (
            <div className="field field--grow">
              <span>Selected places</span>
              <p className="field__hint" role="status">
                {savedPlaceIds.length} saved place{savedPlaceIds.length === 1 ? "" : "s"} · {format.toUpperCase()} ·{" "}
                {sources.map((source) => (source === "osm" ? "OSM" : "SerpApi")).join(" + ")}
              </p>
            </div>
          ) : (
            <div className="field">
              <label htmlFor="export-target">{scope === "run" ? "Search run" : "Collection"}</label>
              <select id="export-target" value={scopeId} onChange={(event) => setScopeId(event.target.value)}>
                {options.length === 0 ? <option value="">Nothing available</option> : null}
                {scope === "run"
                  ? finishedRuns.map((run) => (
                      <option key={run.id} value={run.id}>
                        {formatDateTime(run.createdAt)} · {run.counts.total} places · {run.status}
                      </option>
                    ))
                  : collections.map((collection) => (
                      <option key={collection.id} value={collection.id}>
                        {collection.name} · {collection.itemCount} places
                      </option>
                    ))}
              </select>
              {selectedReasonMissing ? (
                <p className="field__hint">
                  {scope === "run"
                    ? "Complete a search run before exporting. Runs that are queued or running cannot be exported."
                    : "Create a collection and add saved places first."}
                </p>
              ) : null}
            </div>
          )}
        </div>

        {scope === "saved" ? (
          <fieldset className="export-place-picker">
            <legend className="sr-only">Choose saved places</legend>
            <div className="export-place-picker__toolbar">
              <label className="field export-place-picker__search">
                <span>Find saved places</span>
                <input
                  type="search"
                  value={placeQuery}
                  onChange={(event) => setPlaceQuery(event.target.value)}
                  placeholder="Search by name, category, address, or note"
                />
              </label>
              <div className="button-row">
                <button type="button" className="button button--ghost button--small" onClick={() => selectVisiblePlaces(true)} disabled={filteredSavedPlaces.length === 0}>
                  Select visible
                </button>
                <button type="button" className="button button--ghost button--small" onClick={() => selectVisiblePlaces(false)} disabled={filteredSavedPlaces.length === 0}>
                  Clear visible
                </button>
              </div>
            </div>
            <div className="export-place-picker__count" role="status" aria-live="polite">
              <strong>{savedPlaceIds.length}</strong> of {summaries.length} saved places selected
            </div>
            {placeError ? <p className="form-error" role="alert">{placeError}</p> : null}
            {!summariesLoaded ? (
              <div className="modal-loading" role="status"><Spinner label="Loading saved places" /> Loading saved places…</div>
            ) : summaries.length === 0 ? (
              <p className="empty-inline">No saved places yet. Save places in the Library to export them here.</p>
            ) : filteredSavedPlaces.length === 0 ? (
              <p className="empty-inline">No saved places match “{placeQuery}”.</p>
            ) : (
              <ul className="export-place-list">
                {filteredSavedPlaces.map((place) => (
                  <li key={place.id}>
                    <label className="export-place-option">
                      <input
                        type="checkbox"
                        checked={savedPlaceIds.includes(place.id)}
                        onChange={() => toggleSavedPlace(place.id)}
                      />
                      <span className="export-place-option__body">
                        <strong>{place.name}</strong>
                        <span>{place.category ?? (place.source === "osm" ? "OpenStreetMap" : "Google Maps")}{place.address ? ` · ${place.address}` : ""}</span>
                        {place.note ? <span className="export-place-option__note">Note: {place.note}</span> : null}
                      </span>
                      <span className={`badge badge--${place.source}`}>{place.source === "osm" ? "OSM" : "SerpApi"}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        ) : null}

        <fieldset className="fieldset">
          <legend>Format</legend>
          <div className="format-grid">
            {FORMATS.map((option) => (
              <label key={option.value} className={`format-option${format === option.value ? " format-option--active" : ""}`}>
                <input
                  type="radio"
                  name="export-format"
                  value={option.value}
                  checked={format === option.value}
                  onChange={() => setFormat(option.value)}
                />
                <strong>{option.label}</strong>
                <span>{option.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="fieldset">
          <legend>Sources</legend>
          <div className="check-row">
            <label className="check">
              <input
                type="checkbox"
                checked={sources.includes("osm")}
                onChange={() => toggleSource("osm")}
              />
              OpenStreetMap
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={sources.includes("serpapi")}
                onChange={() => toggleSource("serpapi")}
              />
              SerpApi Google Maps
            </label>
          </div>
          {!serpapiExportEnabled ? (
            <p className="field__hint">
              SerpApi export is disabled by the server policy flag. Requested SerpApi rows will be omitted and the
              manifest will record why.
            </p>
          ) : (
            <p className="field__hint">
              SerpApi row and review exports are enabled. Keep the attribution and do not republish or resell the data
              without the necessary rights.
            </p>
          )}
        </fieldset>

        <fieldset className="fieldset">
          <legend>Fields</legend>
          <div className="field-picker">
            {EXPORT_FIELDS.map((field) => (
              <label key={field.id} className="check check--field">
                <input
                  type="checkbox"
                  checked={fields.has(field.id)}
                  onChange={() => toggleField(field.id)}
                />
                <span>
                  <strong>{field.label}</strong>
                  <span className="field__hint">{field.description}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="button-row">
            <button type="button" className="button button--ghost button--small" onClick={() => setFields(new Set(DEFAULT_EXPORT_FIELDS))}>
              Reset to defaults
            </button>
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => setFields(new Set(EXPORT_FIELDS.map((field) => field.id)))}
            >
              Select all
            </button>
          </div>
          <p className="field__hint">
            Never exportable: {RESTRICTED_EXPORT_FIELDS.join(", ")}. CSV and Excel cells are protected against formula
            injection; coordinates are validated before GeoJSON generation.
          </p>
        </fieldset>

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="button button--ghost" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={submit}
            disabled={
              busy ||
              fields.size === 0 ||
              sources.length === 0 ||
              (scope === "saved" ? savedPlaceIds.length === 0 : !scopeId)
            }
          >
            {busy ? "Queuing…" : "Create export"}
          </button>
        </div>
      </section>

      <section className="export-jobs" aria-labelledby="export-jobs-heading">
        <div className="export-jobs__heading">
          <h3 id="export-jobs-heading">Export history</h3>
          <span className="field__hint">{jobs.length} record{jobs.length === 1 ? "" : "s"}</span>
        </div>
        {loadingJobs ? (
          <div className="modal-loading" role="status">
            <Spinner label="Loading exports" /> Loading exports…
          </div>
        ) : jobs.length === 0 ? (
          <p className="empty-inline">No exports created yet.</p>
        ) : (
          <ul className="job-list">
            {jobs.map((job) => (
              <li key={job.id} className="job-item">
                <div className="job-item__head">
                  <div>
                    <strong>
                      {job.scope === "run" ? "Search run" : job.scope === "collection" ? "Collection" : "Selected places"} · {job.format.toUpperCase()}
                    </strong>
                    <span>
                      {formatDateTime(job.createdAt)}
                      {job.rowCount !== null ? ` · ${job.rowCount} rows` : ""}
                    </span>
                  </div>
                  <Badge tone={jobTone(job.status)}>{job.status}</Badge>
                </div>
                <div className="job-item__actions">
                  {job.status === "completed" && job.downloadUrl ? (
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={() => downloadExport(job.id)}
                    >
                      Download ZIP
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="button button--ghost button--small job-item__delete"
                    onClick={() => removeJob(job)}
                    disabled={deletingJob === job.id || job.status === "queued" || job.status === "running"}
                    title={
                      job.status === "queued" || job.status === "running"
                        ? "Wait for the export to finish before deleting it"
                        : "Delete this export and its generated file"
                    }
                  >
                    {deletingJob === job.id ? "Deleting…" : "Delete"}
                  </button>
                </div>
                {job.status === "queued" || job.status === "running" ? (
                  <p className="field__hint">Delete becomes available when the export finishes.</p>
                ) : null}
                {job.expiresAt ? <p className="field__hint">Expires {formatDateTime(job.expiresAt)}</p> : null}
                {job.omittedSources.length > 0 ? (
                  <p className="field__hint">Omitted: {job.omittedSources.join("; ")}</p>
                ) : null}
                {job.error ? (
                  <p className="form-error" role="alert">
                    {job.error}
                  </p>
                ) : null}
                {job.manifest ? (
                  <>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setExpandedJob(expandedJob === job.id ? null : job.id)}
                      aria-expanded={expandedJob === job.id}
                    >
                      {expandedJob === job.id ? "Hide manifest" : "Show manifest"}
                    </button>
                    {expandedJob === job.id ? (
                      <pre className="manifest">{JSON.stringify(job.manifest, null, 2)}</pre>
                    ) : null}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Modal>
  );
}
