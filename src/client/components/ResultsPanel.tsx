import { useEffect, useMemo, useState } from "react";
import type { Place, SearchRun, Source } from "../../shared/types.js";
import { coverageLabel, formatDateTime, formatDistance, formatUsd, runStatusLabel, sourceLabel, statusTone } from "../format.js";
import { Badge, EmptyState, Spinner } from "./Feedback.js";

interface ResultsPanelProps {
  run: SearchRun | null;
  runs: SearchRun[];
  places: Place[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  pricePerSearchUsd?: number;
  selectedId: string | null;
  onSelectPlace: (id: string) => void;
  onHoverPlace: (id: string | null) => void;
  onLoadMore: () => void;
  onSwitchRun: (runId: string) => void;
  onSavePlace: (place: Place) => void;
  onRemoveSavedPlace: (place: Place) => void;
  onExportRun: () => void;
  onOpenLibrary: () => void;
}

type SourceFilter = "all" | Source;
type SortKey = "distance" | "name" | "rating";

function ratingOf(place: Place): number {
  const value = place.fields.rating;
  return typeof value === "number" ? value : -1;
}

export function ResultsPanel({
  run,
  runs,
  places,
  total,
  loading,
  loadingMore,
  error,
  pricePerSearchUsd = 0.015,
  selectedId,
  onSelectPlace,
  onHoverPlace,
  onLoadMore,
  onSwitchRun,
  onSavePlace,
  onRemoveSavedPlace,
  onExportRun,
  onOpenLibrary,
}: ResultsPanelProps) {
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("distance");
  const [text, setText] = useState("");
  useEffect(() => {
    setSourceFilter("all");
    setText("");
  }, [run?.id]);

  const filtered = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const list = places.filter((place) => {
      if (sourceFilter !== "all" && place.source !== sourceFilter) return false;
      if (!needle) return true;
      return `${place.name} ${place.address ?? ""} ${place.category ?? ""}`.toLowerCase().includes(needle);
    });
    return [...list].sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name);
      if (sortKey === "rating") return ratingOf(b) - ratingOf(a) || a.name.localeCompare(b.name);
      return (a.distanceMeters ?? Number.MAX_SAFE_INTEGER) - (b.distanceMeters ?? Number.MAX_SAFE_INTEGER);
    });
  }, [places, sourceFilter, sortKey, text]);

  if (!run) {
    return (
      <section className="results" aria-labelledby="results-heading">
        <h2 id="results-heading" className="visually-hidden">
          Results
        </h2>
        <EmptyState title="No search yet">
          <p>
            Choose a location, keyword or category, then run a search. OpenStreetMap and SerpApi results stay in
            separate layers and are labelled by source.
          </p>
          <p>
            Saved searches can queue refreshes, and completed runs can be exported with a manifest.
          </p>
        </EmptyState>
      </section>
    );
  }

  const running = run.status === "queued" || run.status === "running";
  const finished = run.status === "completed" || run.status === "partial";
  const osmCount = run.counts.osm;
  const serpCount = run.counts.serpapi;

  return (
    <section className="results" aria-labelledby="results-heading">
      <div className="results__heading">
        <div>
          <h2 id="results-heading">Results</h2>
          <p className="results__subtitle">
            {run.criteria.keyword || "Category search"} · {run.criteria.city || "custom area"}
          </p>
        </div>
        <Badge tone={statusTone(run.status)}>{runStatusLabel(run.status)}</Badge>
      </div>

      {runs.length > 1 ? (
        <label className="field field--inline">
          <span>Recent run</span>
          <select value={run.id} onChange={(event) => onSwitchRun(event.target.value)}>
            {runs.map((item) => (
              <option key={item.id} value={item.id}>
                {formatDateTime(item.createdAt)} · {runStatusLabel(item.status)} · {item.counts.total} places
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {running ? (
        <div className="running-card" role="status" aria-live="polite">
          <Spinner label="Search in progress" />
          <div>
            <strong>{run.status === "queued" ? "Waiting for the worker…" : "Searching sources…"}</strong>
            <p>
              SerpApi pages are requested one at a time and counted against the budget. You can keep this tab
              open; results appear when the run finishes.
            </p>
          </div>
        </div>
      ) : null}

      {run.status === "failed" ? (
        <div className="callout callout--error" role="alert">
          <strong>This run failed.</strong>
          <p>Check the source errors below, then adjust the area or source settings and try again.</p>
          {run.errors.length > 0 ? (
            <ul>{run.errors.map((error, index) => <li key={`${error.source}-${error.code}-${index}`}>{error.source === "system" ? "System" : sourceLabel(error.source)}: {error.message}</li>)}</ul>
          ) : null}
        </div>
      ) : null}

      {finished ? (
        <>
          <div className="summary-grid" aria-label="Run summary">
            <div className="summary-card">
              <span className="summary-card__label">Places kept</span>
              <strong>{run.counts.total}</strong>
            </div>
            <div className="summary-card">
              <span className="summary-card__label">OSM</span>
              <strong>{osmCount}</strong>
            </div>
            <div className="summary-card">
              <span className="summary-card__label">SerpApi</span>
              <strong>{serpCount}</strong>
            </div>
            <div className="summary-card">
              <span className="summary-card__label">Duplicates</span>
              <strong>{run.counts.duplicates}</strong>
            </div>
            <div className="summary-card">
              <span className="summary-card__label">SerpApi requests</span>
              <strong>{run.requests.serpapi}</strong>
            </div>
          </div>

          <div className="run-meta">
            <Badge tone={run.coverage === "within_limits" ? "ok" : run.coverage === "failed" ? "error" : "warn"}>
              {coverageLabel(run.coverage)}
            </Badge>
            <span>
              {run.pagesProcessed.osm} OSM page{run.pagesProcessed.osm === 1 ? "" : "s"} ·{" "}
              {run.pagesProcessed.serpapi} SerpApi page{run.pagesProcessed.serpapi === 1 ? "" : "s"} ·{" "}
              {formatUsd(run.credits.actual * pricePerSearchUsd)} estimated source cost · retrieved {formatDateTime(run.finishedAt)}
            </span>
          </div>

          {run.sources.length > 0 ? (
            <details className="source-summary">
              <summary>Source details and provenance</summary>
              <table>
                <caption className="visually-hidden">Per-source request and result counts</caption>
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col">Status</th>
                    <th scope="col">Pages / requests</th>
                    <th scope="col">Returned</th>
                    <th scope="col">Kept</th>
                    <th scope="col">Invalid records</th>
                    <th scope="col">Duplicate</th>
                    <th scope="col">Coverage / enrichment</th>
                  </tr>
                </thead>
                <tbody>
                  {run.sources.map((summary) => (
                    <tr key={summary.source}>
                      <th scope="row">{sourceLabel(summary.source)}</th>
                      <td>{summary.status}</td>
                      <td>
                        {summary.pages}/{summary.requests}
                      </td>
                      <td>{summary.results}</td>
                      <td>{summary.kept}</td>
                      <td>
                        {summary.filteredOut}
                        {summary.exclusions ? (
                          <small className="source-summary__breakdown">
                            {` · ${summary.exclusions.missingCoordinates} unusable coordinates, ${summary.exclusions.invalidRecord} invalid or unidentified`}
                          </small>
                        ) : null}
                      </td>
                      <td>{summary.duplicates}</td>
                      <td>
                        {summary.tiles
                          ? `${summary.tiles.completed}/${summary.tiles.total} complete · ${summary.tiles.attempted} attempted · ${summary.tiles.sampled} sampled`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {run.criteria.mode === "boundary" ? (
                <p>
                  {run.criteria.boundaryResolution ? (
                    <span>{run.criteria.boundaryResolution.relationId
                      ? `Matched OSM relation ${run.criteria.boundaryResolution.relationId} (${run.criteria.boundaryResolution.name ?? run.criteria.boundary?.name ?? "selected area"}, admin level ${run.criteria.boundaryResolution.adminLevel ?? "unknown"}); ${run.criteria.boundaryResolution.ringCount ?? "unknown"} rings / ${run.criteria.boundaryResolution.vertexCount ?? "unknown"} vertices${run.criteria.boundaryResolution.osmTimestamp ? `; OSM snapshot ${formatDateTime(run.criteria.boundaryResolution.osmTimestamp)}` : ""}. `
                      : run.criteria.boundaryResolution.boundsSource === "map"
                        ? "No OSM administrative boundary matched; using the explicitly selected map rectangle, not the administrative boundary. "
                        : run.criteria.boundaryResolution.boundsSource === "geonames"
                          ? "No OSM administrative boundary matched; using approximate GeoNames bounds, not the administrative boundary. "
                          : "No OSM administrative boundary matched; using the available location fallback. "}</span>
                  ) : null}
                  {run.criteria.boundaryResolution?.selectedBoundsSource === "map" && run.criteria.boundaryResolution.boundsSource === "osm"
                    ? <span>The selected map rectangle was available as a fallback but was not used; the OSM boundary was resolved.</span>
                    : null}{" "}
                  Boundary precision: {run.sources.filter((summary) => summary.status !== "skipped" && summary.status !== "disabled").map((summary) =>
                    `${sourceLabel(summary.source)}: ${summary.boundaryPrecision === "polygon" ? "polygon search area (returned places retained)" : summary.boundaryPrecision === "bbox" ? "approximate bounding box search" : summary.boundaryPrecision === "radius" ? "approximate center-radius search" : "not recorded"}`,
                  ).join(" · ")}
                </p>
              ) : null}
              {run.sources.some((summary) => summary.error) ? (
                <ul className="error-list">
                  {run.sources
                    .filter((summary) => summary.error)
                    .map((summary) => (
                      <li key={summary.source}>
                        <strong>{sourceLabel(summary.source)}:</strong> {summary.error}
                      </li>
                    ))}
                </ul>
              ) : null}
            </details>
          ) : null}

          {run.caveats.length > 0 ? (
            <details className="caveats">
              <summary>Coverage caveats ({run.caveats.length})</summary>
              <ul>
                {run.caveats.map((caveat) => (
                  <li key={caveat}>{caveat}</li>
                ))}
              </ul>
            </details>
          ) : null}

          <div className="results__actions">
            <button type="button" className="button button--secondary button--small" onClick={onExportRun}>
              Export this run
            </button>
            <button type="button" className="button button--ghost button--small" onClick={onOpenLibrary}>
              Saved library
            </button>
          </div>
        </>
      ) : null}

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? (
        <div className="results__loading" role="status">
          <Spinner label="Loading results" /> Loading places…
        </div>
      ) : null}

      {!loading && !error && finished && places.length === 0 ? (
        <EmptyState title="No valid places returned">
          <p>
            No usable place records were returned by the selected sources. Check source errors and invalid-record counts,
            then try a different keyword or review the provider page limits. Search absence is not proof that a place does not exist.
          </p>
        </EmptyState>
      ) : null}

      {places.length > 0 ? (
        <>
          <div className="result-filters">
            <div className="chip-row" role="group" aria-label="Filter by source">
              {(
                [
                  ["all", `All ${places.length}`],
                  ["osm", `OSM ${osmCount}`],
                  ["serpapi", `SerpApi ${serpCount}`],
                ] as Array<[SourceFilter, string]>
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`chip${sourceFilter === value ? " chip--active" : ""}`}
                  aria-pressed={sourceFilter === value}
                  onClick={() => setSourceFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="result-filters__row">
              <label className="field field--inline">
                <span>Filter</span>
                <input
                  type="search"
                  value={text}
                  placeholder="Name or address"
                  onChange={(event) => setText(event.target.value)}
                />
              </label>
              <label className="field field--inline">
                <span>Sort</span>
                <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
                  <option value="distance">Distance</option>
                  <option value="name">Name</option>
                  <option value="rating">Rating</option>
                </select>
              </label>
            </div>
          </div>

          <p className="field__hint" role="status">Showing {places.length} loaded places of {total}. List filters only affect this view; no valid returned places are removed from the run.</p>
          <ul className="place-list">
            {filtered.map((place) => (
              <li key={place.id}>
                <article
                  className={`place-card${selectedId === place.id ? " place-card--selected" : ""}`}
                  onMouseEnter={() => onHoverPlace(place.id)}
                  onMouseLeave={() => onHoverPlace(null)}
                >
                  <button
                    type="button"
                    className="place-card__select"
                    onClick={() => onSelectPlace(place.id)}
                    aria-label={`Show details for ${place.name}`}
                    aria-current={selectedId === place.id ? "true" : undefined}
                    onFocus={() => onHoverPlace(place.id)}
                    onBlur={() => onHoverPlace(null)}
                  >
                    <span className="place-card__badges">
                      <Badge tone={place.source}>{place.source === "osm" ? "OSM" : "SerpApi"}</Badge>
                      {place.possibleDuplicate ? (
                        <Badge tone="warn" title="A possible cross-source duplicate awaits review">
                          Possible duplicate
                        </Badge>
                      ) : null}
                      {place.detailsStatus === "fetched" && place.source === "serpapi" ? (
                        <Badge tone="ok">Details fetched</Badge>
                      ) : null}
                    </span>
                    <span className="place-card__name">{place.name}</span>
                    <span className="place-card__meta">
                      {place.category ?? "Uncategorised"}
                      {place.address ? ` · ${place.address}` : ""}
                    </span>
                    <span className="place-card__stats">
                      <span>{formatDistance(place.distanceMeters)}</span>
                      {typeof place.fields.rating === "number" ? (
                        <span>
                          ★ {Number(place.fields.rating).toFixed(1)} / 5
                          
                        </span>
                      ) : null}
                      {typeof place.fields.reviews === "number" ? <span>{place.fields.reviews.toLocaleString()} source reviews</span> : null}
                      {typeof place.fields.cuisine === "string" ? <span>{place.fields.cuisine}</span> : null}
                      <span>Retrieved {formatDateTime(place.retrievedAt)}</span>
                    </span>
                  </button>
                  <div className="place-card__actions">
                    <button
                      type="button"
                      className={`button button--tiny${place.saved ? " button--saved" : " button--secondary"}`}
                      onClick={() => (place.saved ? onRemoveSavedPlace(place) : onSavePlace(place))}
                      aria-label={place.saved ? `Remove ${place.name} from saved places` : `Save ${place.name}`}
                    >
                      {place.saved ? "Saved ✓" : "Save"}
                    </button>
                    <button
                      type="button"
                      className="button button--tiny button--ghost"
                      onClick={() => onSelectPlace(place.id)}
                    >
                      Details
                    </button>
                  </div>
                </article>
              </li>
            ))}
          </ul>

          {filtered.length === 0 ? (
            <p className="empty-inline">No loaded places match this filter.</p>
          ) : null}

          <div className="load-more">
            <span>
              Showing {places.length} of {total}
            </span>
            {places.length < total ? (
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={onLoadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
