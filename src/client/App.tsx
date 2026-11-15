import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Collection,
  DiscoveryEstimate,
  ImportedPlaceRef,
  Place,
  SavedPlace,
  SearchCriteria,
  SearchRun,
} from "../shared/types.js";
import { isTerminalRun } from "../shared/types.js";
import { boundsAreaKm2, boundsCenter } from "../shared/geo.js";
import { api, ApiError, setCsrfToken, type AppStatus, type AuthSessionInfo } from "./api.js";
import { formatUsd } from "./format.js";
import { LoginScreen } from "./components/LoginScreen.js";
import { SearchPanel } from "./components/SearchPanel.js";
import { ResultsPanel } from "./components/ResultsPanel.js";
import { MapView } from "./components/MapView.js";
import { DetailsPanel } from "./components/DetailsPanel.js";
import { LibraryModal, type LibraryTab } from "./components/LibraryModal.js";
import { ExportModal } from "./components/ExportModal.js";
import { SettingsModal } from "./components/SettingsModal.js";
import { SaveSearchModal } from "./components/SaveSearchModal.js";
import { NoticeBar, Spinner, type Notice, type NoticeKind } from "./components/Feedback.js";
import { useFocusTrap } from "./useFocusTrap.js";

const CRITERIA_KEY = "pd.criteria.v1";

function defaultCriteria(): SearchCriteria {
  return {
    keyword: "",
    category: "restaurant",
    sources: ["osm", "serpapi"],
    mode: "radius",
    center: { lat: 23.7104, lon: 90.40744 },
    radiusMeters: 2_000,
    bounds: null,
    country: "Bangladesh",
    countryCode: "BD",
    region: "Dhaka Division",
    regionCode: "BD.81",
    county: "Dhaka",
    countyCode: "BD.81.3026",
    city: "Dhaka",
    cityId: 1185241,
    area: "",
    boundary: null,
  };
}

function loadStoredCriteria(): SearchCriteria {
  const fallback = defaultCriteria();
  try {
    const raw = localStorage.getItem(CRITERIA_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<SearchCriteria>;
    if (!parsed.countryCode || (parsed.mode === "boundary" && !parsed.boundary)) return fallback;
    const sources = Array.isArray(parsed.sources)
      ? parsed.sources.filter((source): source is "osm" | "serpapi" => source === "osm" || source === "serpapi")
      : fallback.sources;
    return {
      ...fallback,
      ...parsed,
      sources: sources.length > 0 ? sources : fallback.sources,
      center:
        parsed.mode === "boundary" && parsed.center === null
          ? null
          : parsed.center &&
              typeof parsed.center.lat === "number" &&
              typeof parsed.center.lon === "number"
            ? parsed.center
            : fallback.center,
      bounds:
        parsed.bounds &&
        ["south", "west", "north", "east"].every(
          (key) => typeof (parsed.bounds as unknown as Record<string, unknown>)[key] === "number",
        )
          ? parsed.bounds
          : null,
    };
  } catch {
    return fallback;
  }
}

function isMobileViewport(): boolean {
  return window.matchMedia("(max-width: 860px)").matches;
}

export function App() {
  const [session, setSession] = useState<AuthSessionInfo | null>(null);
  const [booting, setBooting] = useState(true);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [maxPagesPerRun, setMaxPagesPerRun] = useState(6);
  const [criteria, setCriteria] = useState<SearchCriteria>(() => loadStoredCriteria());
  const [runs, setRuns] = useState<SearchRun[]>([]);
  const [activeRun, setActiveRun] = useState<SearchRun | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [placesTotal, setPlacesTotal] = useState(0);
  const [loadingPlaces, setLoadingPlaces] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const runGeneration = useRef(0);
  const activeRunIdRef = useRef<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const estimateDialogRef = useRef<HTMLElement>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [savedPlaces, setSavedPlaces] = useState<SavedPlace[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [library, setLibrary] = useState<{ open: boolean; tab: LibraryTab } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saveSearchOpen, setSaveSearchOpen] = useState(false);
  const [exportTarget, setExportTarget] = useState<{
    scope: "run" | "collection" | "saved";
    id: string | null;
    savedPlaceIds?: string[];
  } | null>(null);
  const [ephemeralRuns, setEphemeralRuns] = useState<SearchRun[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [mobileView, setMobileView] = useState<"map" | "list">("list");
  const [narrowViewport, setNarrowViewport] = useState(() => isMobileViewport());
  const [searchCollapsed, setSearchCollapsed] = useState(false);
  const [viewportBounds, setViewportBounds] = useState<SearchCriteria["bounds"]>(null);
  const [fitToken, setFitToken] = useState(0);
  const geographyFocusToken = useRef(0);
  const [geographyFocus, setGeographyFocus] = useState<{
    center: SearchCriteria["center"];
    level: "country" | "region" | "county" | "city";
    token: number;
  } | null>(null);
  const [layers, setLayers] = useState({ osm: true, serpapi: true });
  const [confirmationEstimate, setConfirmationEstimate] = useState<DiscoveryEstimate | null>(null);
  useFocusTrap(estimateDialogRef, Boolean(confirmationEstimate), () => setConfirmationEstimate(null));
  const criteriaRevision = useRef(0);
  const [estimateLoading, setEstimateLoading] = useState(false);
  const [importText, setImportText] = useState("");
  const [importRefs, setImportRefs] = useState<ImportedPlaceRef[]>([]);
  const [importRejected, setImportRejected] = useState<Array<{ input: string; reason: string }>>([]);
  const [importParsing, setImportParsing] = useState(false);
  const noticeTimer = useRef<number | null>(null);
  const bootRef = useRef(false);

  const notify = useCallback((kind: NoticeKind, message: string) => {
    setNotice({ id: Date.now(), kind, message });
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), kind === "error" ? 9000 : 5000);
  }, []);

  const allRuns = useMemo(() => {
    const map = new Map<string, SearchRun>();
    for (const run of ephemeralRuns) map.set(run.id, run);
    for (const run of runs) map.set(run.id, run);
    if (activeRun) map.set(activeRun.id, activeRun);
    return [...map.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [runs, ephemeralRuns, activeRun]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 860px)");
    const update = () => setNarrowViewport(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    localStorage.setItem(CRITERIA_KEY, JSON.stringify(criteria));
  }, [criteria]);

  const refreshStatus = useCallback(async () => {
    try {
      const result = await api.status();
      setStatus(result);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return;
    }
  }, []);

  const refreshLibrary = useCallback(async () => {
    try {
      const saved = await api.savedPlaces();
      setSavedPlaces(saved.places);
      setCollections(saved.collections);
      const savedIds = new Set(saved.places.map((item) => item.place.id));
      setPlaces((current) => current.map((place) => ({ ...place, saved: savedIds.has(place.id) })));
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return;
    }
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      const result = await api.runs(20);
      setRuns(result.runs);
    } catch {
      // A run history refresh is not critical.
    }
  }, []);

  const refreshSettingsMeta = useCallback(async () => {
    try {
      const result = await api.getSettings();
      setMaxPagesPerRun(result.settings.serpapiMaxPages);
    } catch {
      // Keep the previous estimate.
    }
  }, []);

  const handleDataChanged = useCallback(() => {
    void refreshLibrary();
    void refreshStatus();
  }, [refreshLibrary, refreshStatus]);

  const activateRun = useCallback((run: SearchRun) => {
    runGeneration.current += 1;
    activeRunIdRef.current = run.id;
    setActiveRun(run);
    setPlaces([]);
    setPlacesTotal(0);
    setRunError(null);
    setSelectedPlaceId(null);
  }, []);

  const loadRunPlaces = useCallback(
    async (runId: string, append = false, offset = 0) => {
      if (activeRunIdRef.current !== runId) return;
      const generation = runGeneration.current;
      if (append) setLoadingMore(true);
      else {
        setLoadingPlaces(true);
        setPlaces([]);
      }
      setRunError(null);
      try {
        const result = await api.runPlaces(runId, offset, 100);
        if (generation !== runGeneration.current || activeRunIdRef.current !== runId) return;
        setPlacesTotal(result.total);
        setPlaces((current) => {
          if (!append) return result.places;
          const byId = new Map(current.map((place) => [place.id, place]));
          for (const place of result.places) byId.set(place.id, place);
          return [...byId.values()];
        });
      } catch (caught) {
        if (generation === runGeneration.current && activeRunIdRef.current === runId) {
          setRunError(caught instanceof ApiError ? caught.message : "Could not load results.");
        }
      } finally {
        if (generation === runGeneration.current && activeRunIdRef.current === runId) {
          setLoadingPlaces(false);
          setLoadingMore(false);
        }
      }
    },
    [],
  );

  const selectRun = useCallback(
    async (runId: string) => {
      runGeneration.current += 1;
      const generation = runGeneration.current;
      activeRunIdRef.current = runId;
      setPlaces([]);
      setPlacesTotal(0);
      setSelectedPlaceId(null);
      try {
        const run = await api.run(runId);
        if (generation !== runGeneration.current) return;
        setActiveRun(run);
        if (isTerminalRun(run.status)) await loadRunPlaces(run.id);
      } catch (caught) {
        if (generation === runGeneration.current) {
          notify("error", caught instanceof ApiError ? caught.message : "Could not load that search run.");
        }
      }
    },
    [loadRunPlaces, notify],
  );

  const bootstrap = useCallback(async () => {
    try {
      const me = await api.me();
      setCsrfToken(me.csrfToken);
      setSession(me);
      const [statusResult, settingsResult, runsResult, savedResult] = await Promise.all([
        api.status(),
        api.getSettings(),
        api.runs(20),
        api.savedPlaces(),
      ]);
      setStatus(statusResult);
      setMaxPagesPerRun(settingsResult.settings.serpapiMaxPages);
      setRuns(runsResult.runs);
      setSavedPlaces(savedResult.places);
      setCollections(savedResult.collections);
      const active = runsResult.runs.find((run) => run.status === "queued" || run.status === "running");
      const latest = active ?? runsResult.runs[0] ?? null;
      if (latest) {
        activateRun(latest);
        if (isTerminalRun(latest.status)) {
          await loadRunPlaces(latest.id);
        }
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.status !== 401) {
        notify("error", caught.message);
      }
    } finally {
      setBooting(false);
    }
  }, [activateRun, loadRunPlaces, notify]);

  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const onUnauthorized = () => {
      setSession(null);
      setCsrfToken(null);
    };
    window.addEventListener("pd:unauthorized", onUnauthorized);
    return () => window.removeEventListener("pd:unauthorized", onUnauthorized);
  }, []);

  // Poll a running search until it reaches a terminal state.
  useEffect(() => {
    if (!activeRun || !["queued", "running"].includes(activeRun.status)) return;
    const runId = activeRun.id;
    let cancelled = false;
    const timer = window.setInterval(() => {
      api
        .run(runId)
        .then(async (run) => {
          if (cancelled || activeRunIdRef.current !== runId) return;
          setActiveRun(run);
          if (isTerminalRun(run.status)) {
            await loadRunPlaces(run.id);
            void refreshRuns();
            void refreshStatus();
            void refreshSettingsMeta();
            if (run.status === "failed") {
              notify("error", "The search failed. Review the source errors and try again.");
            } else if (run.status === "partial") {
              notify("info", "Search finished with partial results. Check the source caveats.");
            } else {
              notify("success", `Search finished with ${run.counts.total} places.`);
            }
          }
        })
        .catch((caught) => {
          if (cancelled) return;
          if (caught instanceof ApiError && caught.status !== 401) {
            notify("error", caught.message);
          }
        });
    }, 1800);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun?.id, activeRun?.status, loadRunPlaces, notify, refreshRuns, refreshStatus, refreshSettingsMeta]);

  useEffect(() => {
    return () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    };
  }, []);

  const startSearch = async () => {
    if (!status || submittingRef.current) return;
    if (criteria.plan === "import" && importRefs.length === 0) {
      notify("error", "Parse at least one place reference first.");
      return;
    }
    if (criteria.plan === "tiled") {
      setEstimateLoading(true);
      try {
        const normalized = { ...criteria, plan: "tiled" as const, tiling: criteria.tiling };
        const estimate = await api.estimateRun(normalized);
        if (!estimate.withinBudget) {
          notify("error", estimate.warnings.find((warning) => warning.includes("needs")) ?? "The tiled plan exceeds the remaining SerpApi budget.");
          return;
        }
        setCriteria(normalized);
        setConfirmationEstimate(estimate);
      } catch (caught) {
        notify("error", caught instanceof ApiError ? caught.message : "Could not estimate this tiled plan.");
      } finally {
        setEstimateLoading(false);
      }
      return;
    }
    if (criteria.plan === "import") {
      // Import runs have no search geography; validation explicitly permits this.
    } else if (criteria.mode === "radius" && !criteria.center) {
      notify("error", "Pick a search center on the map first.");
      return;
    }
    if (criteria.plan !== "import" && criteria.mode === "area" && !criteria.bounds) {
      notify("error", "Show the map and select an area first.");
      return;
    }
    if (criteria.plan !== "import" && criteria.mode === "boundary" && !criteria.boundary) {
      notify("error", "Select a region, county, or city for the boundary search.");
      return;
    }
    void submitStandardRun(criteria.plan === "import" ? { ...criteria, importRefs } : criteria);
  };

  const submitStandardRun = async (runCriteria: SearchCriteria) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const created = await api.createRun(runCriteria);
      const run = await api.run(created.runId);
      activateRun(run);
      setEphemeralRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      void refreshRuns();
      if (isMobileViewport()) {
        setSearchCollapsed(true);
        setMobileView("list");
      }
      notify("info", created.reused ? "Resumed the existing search run." : "Search queued.");
    } catch (caught) {
      notify("error", caught instanceof ApiError ? caught.message : "Could not start the search.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const parseImports = async () => {
    if (!importText.trim() || importParsing) return;
    setImportParsing(true);
    try {
      const parsed = await api.parsePlaceImports(importText);
      setImportRefs(parsed.refs);
      setImportRejected(parsed.rejected);
      setCriteria((current) => ({
        ...current,
        plan: "import",
        mode: "radius",
        sources: ["serpapi"],
        center: null,
        bounds: null,
        boundary: null,
        importRefs: parsed.refs,
        tiling: null,
      }));
      notify(parsed.refs.length ? "success" : "error", parsed.refs.length
        ? `Parsed ${parsed.refs.length} unique place reference${parsed.refs.length === 1 ? "" : "s"}.`
        : "No usable place references found.");
    } catch (caught) {
      notify("error", caught instanceof ApiError ? caught.message : "Could not parse those place references.");
    } finally {
      setImportParsing(false);
    }
  };

  const confirmTiledRun = async () => {
    if (!confirmationEstimate || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const result = await api.queueTiles(criteria);
      setConfirmationEstimate(null);
      await refreshRuns();
      const first = result.runs[0];
      if (first) {
        const run = await api.run(first.runId);
        activateRun(run);
        setEphemeralRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      }
      notify("success", `Queued ${result.runs.length} separately tracked tiles. Estimated cost: ${formatUsd(result.estimate.estimatedCostUsd)}.`);
      if (isMobileViewport()) { setSearchCollapsed(true); setMobileView("list"); }
    } catch (caught) {
      notify("error", caught instanceof ApiError ? caught.message : "Could not queue the tile runs.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const savePlace = async (place: Place) => {
    try {
      await api.savePlace(place.id);
      setPlaces((current) => current.map((item) => (item.id === place.id ? { ...item, saved: true } : item)));
      await refreshLibrary();
      notify("success", `${place.name} saved.`);
    } catch (caught) {
      notify("error", caught instanceof ApiError ? caught.message : "Could not save this place.");
    }
  };

  const removeSavedPlace = async (place: Place) => {
    const saved = savedPlaces.find((item) => item.place.id === place.id);
    if (!saved) {
      await refreshLibrary();
      return;
    }
    try {
      await api.deleteSavedPlace(saved.id);
      setPlaces((current) => current.map((item) => (item.id === place.id ? { ...item, saved: false } : item)));
      await refreshLibrary();
      notify("info", "Removed from saved places.");
    } catch (caught) {
      notify("error", caught instanceof ApiError ? caught.message : "Could not remove this saved place.");
    }
  };

  const useMapView = () => {
    if (!viewportBounds) {
      notify("info", "Move the map first, then use the current view.");
      return;
    }
    const area = boundsAreaKm2(viewportBounds);
    const maxArea = status?.hardLimits.maxAreaKm2 ?? 400;
    if (area > maxArea) {
      notify("error", `The current map view is ${area.toFixed(0)} km². Zoom in to ${maxArea} km² or less.`);
      return;
    }
    setCriteria((current) => ({
      ...current,
      mode: current.mode === "boundary" ? "boundary" : "area",
      bounds: viewportBounds,
      boundary: current.mode === "boundary"
        ? current.boundary
        : null,
      center: boundsCenter(viewportBounds),
    }));
    if (isMobileViewport()) setMobileView("map");
    notify("info", `Map area selected (≈ ${area.toFixed(1)} km²). Press “Run search”.`);
  };

  const handleMapClick = (center: { lat: number; lon: number }) => {
    setCriteria((current) => current.mode === "radius" ? { ...current, center } : current);
  };

  const searchAroundPlace = (place: Place) => {
    setCriteria((current) => ({
      ...current,
      mode: "radius",
      center: { lat: place.lat, lon: place.lon },
      radiusMeters: Math.min(Math.max(current.radiusMeters, 500), 5_000),
      countryCode: "",
      country: "",
      regionCode: "",
      region: "",
      countyCode: "",
      county: "",
      cityId: null,
      city: "",
      bounds: null,
      boundary: null,
    }));
    setSelectedPlaceId(null);
    notify("info", `Search center set to ${place.name}. Adjust the radius, then run the search.`);
  };

  const fitResults = () => {
    setFitToken((token) => token + 1);
    if (isMobileViewport()) setMobileView("map");
  };

  const openLibrary = (tab: LibraryTab = "places") => {
    setLibrary({ open: true, tab });
  };

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      // Clearing local state is still the right result.
    }
    setCsrfToken(null);
    setSession(null);
    runGeneration.current += 1;
    activeRunIdRef.current = null;
    setPlaces([]);
    setActiveRun(null);
    setSelectedPlaceId(null);
  };

  if (booting) {
    return (
      <div className="boot-screen" role="status">
        <Spinner label="Starting Places Discovery" />
        <p>Starting Places Discovery…</p>
      </div>
    );
  }

  if (!session) {
    return (
      <LoginScreen
        onAuthenticated={(next) => {
          setCsrfToken(next.csrfToken);
          setSession(next);
          setBooting(true);
          void bootstrap();
        }}
      />
    );
  }

  const tiles = status?.tiles ?? {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  };
  const reviewsEnabled = status?.sources.serpapi.reviewsEnabled ?? false;
  const portalModalOpen = Boolean(library?.open || settingsOpen || saveSearchOpen || exportTarget);

  return (
    <div className="app" inert={portalModalOpen}>
      <a className="skip-link" href="#results-heading">
        Skip to results
      </a>
      <header className="topbar">
        <div className="topbar__brand">
          <span className="brand-mark" aria-hidden="true">
            ◉
          </span>
          <div>
            <h1 className="topbar__title">Places Discovery</h1>
            <span className="topbar__sub">OSM + SerpApi research</span>
          </div>
        </div>
        <div className="topbar__usage" aria-label="SerpApi usage">
          {status ? (
            <button type="button" className="usage-pill" onClick={() => setSettingsOpen(true)}>
              SerpApi {status.usage.month.used}/{status.usage.month.limit}
              <span>{formatUsd(status.usage.estimatedCostUsd)} this month</span>
            </button>
          ) : null}
        </div>
        <nav className="topbar__nav" aria-label="Workspace actions">
          <div className="view-switch" role="group" aria-label="Mobile view">
            <button
              type="button"
              className={`view-switch__button${mobileView === "list" ? " is-active" : ""}`}
              aria-pressed={mobileView === "list"}
              onClick={() => setMobileView("list")}
            >
              List
            </button>
            <button
              type="button"
              className={`view-switch__button${mobileView === "map" ? " is-active" : ""}`}
              aria-pressed={mobileView === "map"}
              onClick={() => setMobileView("map")}
            >
              Map
            </button>
          </div>
          <button type="button" className="button button--ghost button--small" onClick={() => openLibrary("places")}>
            Library
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => setExportTarget({ scope: "run", id: "" })}
          >
            Exports
          </button>
          <button type="button" className="button button--ghost button--small" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          <span className="topbar__user" title={session.displayName}>
            {session.displayName}
          </span>
          <button type="button" className="button button--ghost button--small" onClick={logout}>
            Sign out
          </button>
        </nav>
      </header>

      {confirmationEstimate ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setConfirmationEstimate(null);
        }}>
          <section
            ref={estimateDialogRef}
            className="modal discovery-estimate"
            role="dialog"
            aria-modal="true"
            aria-labelledby="estimate-title"
            tabIndex={-1}
          >
            <header className="modal__header">
              <div><span className="eyebrow">Paid discovery · explicit confirmation</span><h2 id="estimate-title">Queue {confirmationEstimate.tileCount} tiles?</h2></div>
              <button type="button" className="icon-button" aria-label="Close estimate" onClick={() => setConfirmationEstimate(null)}>×</button>
            </header>
            <div className="discovery-estimate__body">
              <dl className="estimate-grid">
                <div><dt>SerpApi requests</dt><dd>{confirmationEstimate.serpapiRequests} max</dd></div>
                <div><dt>Estimated cost</dt><dd>{formatUsd(confirmationEstimate.estimatedCostUsd)}</dd></div>
                <div><dt>Daily budget left</dt><dd>{confirmationEstimate.remainingDay}</dd></div>
                <div><dt>Monthly budget left</dt><dd>{confirmationEstimate.remainingMonth}</dd></div>
              </dl>
              <p>Each grid cell becomes a separately tracked, separately reviewed search. Actual requests may be lower if results exhaust early. Coverage remains sampled, not exhaustive.</p>
              {confirmationEstimate.warnings.map((warning) => <p className="field__hint" key={warning}>{warning}</p>)}
              <div className="estimate-tiles" aria-label="Planned tile areas">
                {confirmationEstimate.tiles.map((tile) => <span key={tile.index}>Tile {tile.index + 1}: {tile.areaKm2.toFixed(1)} km²</span>)}
              </div>
            </div>
            <footer className="modal__footer">
              <button type="button" className="button button--ghost" onClick={() => setConfirmationEstimate(null)}>Cancel</button>
              <button type="button" className="button button--primary" disabled={submitting} onClick={() => void confirmTiledRun()}>{submitting ? "Queueing…" : `Confirm queue · ${confirmationEstimate.serpapiRequests} requests / ${formatUsd(confirmationEstimate.estimatedCostUsd)} max`}</button>
            </footer>
          </section>
        </div>
      ) : null}
      <NoticeBar notice={notice} onDismiss={() => setNotice(null)} />

      <main className={`workspace workspace--${mobileView}`}>
        <aside
          className={`sidebar${mobileView === "map" ? " sidebar--hidden-mobile" : ""}`}
          aria-label="Search and results"
          {...(narrowViewport && mobileView === "map" ? { inert: true as const, "aria-hidden": true } : {})}
        >
          <div className="sidebar__scroll">
            <div className="mobile-search-header">
              <button
                type="button"
                className="button button--secondary button--small"
                aria-expanded={!searchCollapsed}
                aria-controls="search-controls"
                onClick={() => setSearchCollapsed((collapsed) => !collapsed)}
              >
                {searchCollapsed ? "Show search controls" : "Hide search controls"}
              </button>
              {activeRun ? (
                <span className="mobile-search-header__state">{activeRun.counts.total} places</span>
              ) : null}
            </div>
            <div id="search-controls" className={`search-collapse${searchCollapsed ? " is-collapsed" : ""}`}>
              <SearchPanel
                criteria={criteria}
                onChange={(next) => {
                  criteriaRevision.current += 1;
                  setCriteria(next);
                  if (next.plan !== "tiled") setConfirmationEstimate(null);
                }}
                onRun={() => void startSearch()}
                running={submitting || Boolean(activeRun && ["queued", "running"].includes(activeRun.status))}
                usage={status?.usage ?? null}
                maxPagesPerRun={maxPagesPerRun}
                serpapiConfigured={status?.sources.serpapi.configured ?? false}
                hardLimits={status?.hardLimits ?? {
                  maxTiledAreaKm2: 10000,
                  maxTilesPerRun: 25,
                  maxPagesPerTile: 3,
                  maxImportPlaces: 25,
                }}
                importRefs={importRefs}
                importRejected={importRejected}
                importText={importText}
                importParsing={importParsing}
                onImportTextChange={setImportText}
                onParseImports={() => void parseImports()}
                estimateLoading={estimateLoading}
                onOpenSettings={() => setSettingsOpen(true)}
                onUseMapView={useMapView}
                onFitResults={fitResults}
                onFocusGeography={({ center, level }) => {
                  geographyFocusToken.current += 1;
                  setGeographyFocus({ center, level, token: geographyFocusToken.current });
                  if (isMobileViewport()) setMobileView("map");
                }}
                hasResults={places.length > 0}
                onSaveSearch={() => setSaveSearchOpen(true)}
              />
            </div>
            <ResultsPanel
              run={activeRun}
              runs={allRuns}
              places={places}
              total={placesTotal}
              loading={loadingPlaces}
              loadingMore={loadingMore}
              error={runError}
              pricePerSearchUsd={status?.usage.pricePerSearchUsd}
              selectedId={selectedPlaceId}
              onSelectPlace={(id) => {
                setSelectedPlaceId(id);
                if (isMobileViewport()) setMobileView("map");
              }}
              onHoverPlace={setHoveredId}
              onLoadMore={() => {
                if (!activeRun) return;
                void loadRunPlaces(activeRun.id, true, places.length);
              }}
              onSwitchRun={(runId) => void selectRun(runId)}
              onSavePlace={(place) => void savePlace(place)}
              onRemoveSavedPlace={(place) => void removeSavedPlace(place)}
              onExportRun={() => {
                if (!activeRun) return;
                setExportTarget({ scope: "run", id: activeRun.id });
              }}
              onOpenLibrary={() => openLibrary("places")}
            />
          </div>
        </aside>

        <section
          className={`map-pane${mobileView === "list" ? " map-pane--hidden-mobile" : ""}`}
          aria-label="Map"
          {...(narrowViewport && mobileView === "list" ? { inert: true as const, "aria-hidden": true } : {})}
        >
          <MapView
            places={places}
            center={criteria.center}
            radiusMeters={criteria.radiusMeters}
            mode={criteria.mode}
            bounds={criteria.bounds}
            selectedId={selectedPlaceId}
            hoveredId={hoveredId}
            onSelect={(id) => setSelectedPlaceId(id)}
            onMapClick={handleMapClick}
            onViewport={setViewportBounds}
            fitToken={fitToken}
            geographyFocus={geographyFocus}
            tiles={tiles}
            layers={layers}
            onLayersChange={setLayers}
          />
        </section>

        {selectedPlaceId ? (
          <DetailsPanel
            placeId={selectedPlaceId}
            savedPlaces={savedPlaces}
            collections={collections}
            reviewsEnabled={reviewsEnabled}
            onClose={() => setSelectedPlaceId(null)}
            onChanged={handleDataChanged}
            onNotify={notify}
            onOpenDuplicates={() => openLibrary("duplicates")}
            onSearchHere={searchAroundPlace}
          />
        ) : null}
      </main>
      {library?.open ? (
        <LibraryModal
          initialTab={library.tab}
          onClose={() => setLibrary(null)}
          onNotify={notify}
          onDataChanged={handleDataChanged}
          onLoadSearch={(loaded) => {
            setCriteria(loaded);
            notify("info", "Saved criteria loaded into the search form.");
          }}
          onRunQueued={(runId) => {
            void selectRun(runId);
            if (isMobileViewport()) setMobileView("list");
          }}
          onExportCollection={(collectionId) => setExportTarget({ scope: "collection", id: collectionId })}
          onExportPlaces={(savedPlaceIds) =>
            setExportTarget({ scope: "saved", id: null, savedPlaceIds })
          }
        />
      ) : null}

      {settingsOpen ? (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            void refreshStatus();
            void refreshSettingsMeta();
          }}
          onNotify={notify}
        />
      ) : null}

      {saveSearchOpen ? (
        <SaveSearchModal
          criteria={criteria}
          onClose={() => setSaveSearchOpen(false)}
          onSaved={() => {
            void refreshLibrary();
          }}
          onNotify={notify}
        />
      ) : null}

      {exportTarget ? (
        <ExportModal
          runs={allRuns}
          collections={collections}
          defaultTarget={
            exportTarget
              ? exportTarget.scope === "saved"
                ? { scope: "saved" }
                : exportTarget.id
                  ? { scope: exportTarget.scope, id: exportTarget.id }
                  : null
              : null
          }
          selectedSavedPlaceIds={exportTarget?.savedPlaceIds ?? []}
          serpapiExportEnabled={status?.sources.serpapi.exportEnabled ?? false}
          onClose={() => setExportTarget(null)}
          onNotify={notify}
        />
      ) : null}
    </div>
  );
}
