import { useEffect, useMemo, useRef, useState } from "react";
import { CATEGORIES, CATEGORY_ANY } from "../../shared/categories.js";
import { boundsAreaKm2 } from "../../shared/geo.js";
import type { BoundaryRef, SearchCriteria, Source, UsageSummary } from "../../shared/types.js";
import { api, type GeoCity, type GeoCountry, type GeoCounty, type GeoRegion } from "../api.js";
import { Combobox } from "./Combobox.js";
import { formatUsd, percent } from "../format.js";

interface SearchPanelProps {
  criteria: SearchCriteria;
  onChange: (criteria: SearchCriteria) => void;
  onRun: () => void;
  running: boolean;
  usage: UsageSummary | null;
  maxPagesPerRun: number;
  serpapiConfigured: boolean;
  hardLimits: { maxRadiusMeters?: number; maxAreaKm2?: number; maxTiledAreaKm2: number; maxTilesPerRun: number; maxPagesPerTile: number; maxImportPlaces: number };
  importRefs: import("../../shared/types.js").ImportedPlaceRef[];
  importRejected: Array<{ input: string; reason: string }>;
  importText: string;
  importParsing: boolean;
  estimateLoading: boolean;
  onImportTextChange: (value: string) => void;
  onParseImports: () => void;
  onOpenSettings: () => void;
  onUseMapView: () => void;
  onFitResults: () => void;
  onFocusGeography: (location: { center: SearchCriteria["center"]; level: "country" | "region" | "county" | "city" }) => void;
  hasResults: boolean;
  onSaveSearch: () => void;
}

export function boundaryFor(criteria: SearchCriteria): BoundaryRef | null {
  const countryCode = (criteria.countryCode ?? "").toUpperCase();
  if (!countryCode) return null;
  if (criteria.cityId && criteria.city) {
    return { level: "city", name: criteria.city, countryCode, center: criteria.boundary?.level === "city" ? criteria.boundary.center : criteria.center, bounds: criteria.boundary?.level === "city" ? criteria.boundary.bounds : null };
  }
  if (criteria.countyCode && criteria.county) {
    return { level: "county", name: criteria.county, countryCode, center: criteria.boundary?.level === "county" ? criteria.boundary.center : criteria.center, bounds: criteria.boundary?.level === "county" ? criteria.boundary.bounds : null };
  }
  if (criteria.regionCode && criteria.region) {
    return { level: "region", name: criteria.region, countryCode, center: criteria.boundary?.level === "region" ? criteria.boundary.center : criteria.center, bounds: criteria.boundary?.level === "region" ? criteria.boundary.bounds : null };
  }
  return null;
}

export function SearchPanel({
  criteria,
  onChange,
  onRun,
  running,
  usage,
  maxPagesPerRun,
  serpapiConfigured,
  hardLimits,
  importRefs,
  importRejected,
  importText,
  importParsing,
  estimateLoading,
  onImportTextChange,
  onParseImports,
  onOpenSettings,
  onUseMapView,
  onFitResults,
  onFocusGeography,
  hasResults,
  onSaveSearch,
}: SearchPanelProps) {
  const maxRadiusMeters = hardLimits.maxRadiusMeters ?? 20000;
  const maxRadiusKm = Math.max(0.1, Math.round((maxRadiusMeters / 1000) * 10) / 10);
  const radiusKm = criteria.radiusMeters / 1000;
  const [radiusDraft, setRadiusDraft] = useState(radiusKm.toFixed(1));
  useEffect(() => setRadiusDraft((criteria.radiusMeters / 1000).toFixed(1)), [criteria.radiusMeters]);

  const [countries, setCountries] = useState<GeoCountry[]>([]);
  const [regions, setRegions] = useState<GeoRegion[]>([]);
  const [counties, setCounties] = useState<GeoCounty[]>([]);
  const [cities, setCities] = useState<GeoCity[]>([]);
  const [loading, setLoading] = useState({ countries: true, regions: false, counties: false, cities: false });
  const [geoError, setGeoError] = useState<string | null>(null);
  const [loadedGeo, setLoadedGeo] = useState({ regions: "", counties: "", cities: "" });
  const [failedGeo, setFailedGeo] = useState({ regions: "", counties: "", cities: "" });
  const latestCriteria = useRef(criteria);
  const criteriaRevision = useRef(0);
  if (latestCriteria.current !== criteria) {
    criteriaRevision.current += 1;
    latestCriteria.current = criteria;
  }
  const changeCriteria = (next: SearchCriteria) => {
    criteriaRevision.current += 1;
    latestCriteria.current = next;
    onChange(next);
  };

  useEffect(() => {
    let cancelled = false;
    api
      .geoCountries()
      .then((result) => {
        if (cancelled) return;
        setCountries(result.countries);
        setLoading((current) => ({ ...current, countries: false }));
        const current = latestCriteria.current;
        if (!current.countryCode && !current.center && criteriaRevision.current === 0) {
          const fallback = result.countries.find((country) => country.code === "BD") ?? result.countries[0];
          if (fallback) {
            changeCriteria({
              ...current,
              countryCode: fallback.code,
              country: fallback.name,
              regionCode: "",
              region: "",
              countyCode: "",
              county: "",
              cityId: null,
              city: "",
              center: fallback.center,
              boundary: null,
            });
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading((current) => ({ ...current, countries: false }));
          setGeoError("Could not load countries. Reload to try again.");
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const countryCode = criteria.countryCode;
    if (!countryCode) {
      setRegions([]);
      setLoading((current) => ({ ...current, regions: false }));
      return;
    }
    let cancelled = false;
    const revision = criteriaRevision.current;
    setLoading((current) => ({ ...current, regions: true }));
    api
      .geoRegions(countryCode)
      .then((result) => {
        if (cancelled) return;
        setRegions(result.regions);
        setLoadedGeo((current) => ({ ...current, regions: countryCode }));
        setFailedGeo((current) => ({ ...current, regions: "" }));
        setLoading((current) => ({ ...current, regions: false }));
        const current = latestCriteria.current;
        if (current.countryCode !== countryCode || criteriaRevision.current !== revision) return;
        if (current.regionCode && !result.regions.some((region) => region.code === current.regionCode)) {
          const next = {
            ...current, regionCode: "", region: "", countyCode: "", county: "", cityId: null, city: "",
          };
          changeCriteria({ ...next, boundary: next.mode === "boundary" ? boundaryFor(next) : null });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading((current) => ({ ...current, regions: false }));
          setFailedGeo((current) => ({ ...current, regions: countryCode }));
          setGeoError(`Could not load regions for ${criteria.country}.`);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [criteria.countryCode]);

  useEffect(() => {
    const regionCode = criteria.regionCode;
    if (!regionCode) {
      setCounties([]);
      setLoading((current) => ({ ...current, counties: false }));
      return;
    }
    let cancelled = false;
    const revision = criteriaRevision.current;
    setLoading((current) => ({ ...current, counties: true }));
    api
      .geoCounties(regionCode)
      .then((result) => {
        if (cancelled) return;
        setCounties(result.counties);
        setLoadedGeo((current) => ({ ...current, counties: regionCode }));
        setFailedGeo((current) => ({ ...current, counties: "" }));
        setLoading((current) => ({ ...current, counties: false }));
        const current = latestCriteria.current;
        if (current.regionCode !== regionCode || criteriaRevision.current !== revision) return;
        if (current.countyCode && !result.counties.some((county) => county.code === current.countyCode)) {
          const next = { ...current, countyCode: "", county: "", cityId: null, city: "" };
          changeCriteria({ ...next, boundary: next.mode === "boundary" ? boundaryFor(next) : null });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading((current) => ({ ...current, counties: false }));
          setFailedGeo((current) => ({ ...current, counties: regionCode }));
          setGeoError(`Could not load counties for ${criteria.region}.`);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [criteria.regionCode]);

  useEffect(() => {
    const countyCode = criteria.countyCode;
    const regionCode = criteria.regionCode;
    if (!countyCode && !regionCode) {
      setCities([]);
      setLoading((current) => ({ ...current, cities: false }));
      return;
    }
    let cancelled = false;
    const revision = criteriaRevision.current;
    setLoading((current) => ({ ...current, cities: true }));
    api
      .geoCities(countyCode ? { county: countyCode } : { region: regionCode })
      .then((result) => {
        if (cancelled) return;
        setCities(result.cities);
        setLoadedGeo((current) => ({ ...current, cities: countyCode || regionCode || "" }));
        setFailedGeo((current) => ({ ...current, cities: "" }));
        setLoading((current) => ({ ...current, cities: false }));
        const current = latestCriteria.current;
        if (current.regionCode !== regionCode || current.countyCode !== countyCode || criteriaRevision.current !== revision) return;
        if (current.cityId && !result.cities.some((city) => city.id === current.cityId)) {
          const next = { ...current, cityId: null, city: "" };
          changeCriteria({ ...next, boundary: next.mode === "boundary" ? boundaryFor(next) : null });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading((current) => ({ ...current, cities: false }));
          setFailedGeo((current) => ({ ...current, cities: countyCode || regionCode || "" }));
          setGeoError(`Could not load cities for ${criteria.county || criteria.region}.`);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [criteria.countyCode, criteria.regionCode]);

  const country = countries.find((item) => item.code === criteria.countryCode);
  const region = regions.find((item) => item.code === criteria.regionCode);
  const county = counties.find((item) => item.code === criteria.countyCode);
  const city = cities.find((item) => item.id === criteria.cityId);

  const emitLocation = (patch: Partial<SearchCriteria>, geographicCenter: SearchCriteria["center"]) => {
    const next = { ...latestCriteria.current, ...patch, bounds: null };
    next.boundary = next.mode === "boundary"
      ? boundaryFor({ ...next, boundary: null, center: geographicCenter })
      : null;
    changeCriteria(next);
  };

  const chooseCountry = (code: string) => {
    const next = countries.find((item) => item.code === code);
    if (!next) return;
    emitLocation({
      countryCode: next.code,
      country: next.name,
      regionCode: "",
      region: "",
      countyCode: "",
      county: "",
      cityId: null,
      city: "",
      center: next.center,
      bounds: null,
      boundary: null,
    }, next.center);
    onFocusGeography({ center: next.center, level: "country" });
  };

  const chooseRegion = (code: string) => {
    const next = regions.find((item) => item.code === code);
    if (!next) return;
    if (next.countryCode !== criteria.countryCode) return;
    emitLocation({
      regionCode: next.code,
      region: next.name,
      countyCode: "",
      county: "",
      cityId: null,
      city: "",
      center: next.center ?? null,
      boundary: null,
    }, next.center);
    onFocusGeography({ center: next.center, level: "region" });
  };

  const chooseCounty = (code: string) => {
    const next = counties.find((item) => item.code === code);
    if (!next) return;
    if (next.regionCode !== criteria.regionCode) return;
    emitLocation({
      countyCode: next.code,
      county: next.name,
      cityId: null,
      city: "",
      center: next.center ?? null,
      boundary: null,
    }, next.center);
    onFocusGeography({ center: next.center, level: "county" });
  };

  const chooseCity = (id: string) => {
    const next = cities.find((item) => String(item.id) === id);
    if (!next) return;
    if (next.regionCode !== criteria.regionCode || (criteria.countyCode && next.countyCode !== criteria.countyCode)) return;
    emitLocation({
      cityId: next.id,
      city: next.name,
      center: next.center,
    }, next.center);
    onFocusGeography({ center: next.center, level: "city" });
  };

  const setMode = (mode: SearchCriteria["mode"]) => {
    const selectedCenter = criteria.cityId ? city?.center : criteria.countyCode ? county?.center : criteria.regionCode ? region?.center : country?.center;
    const next = { ...criteria, mode, boundary: mode === "boundary" ? boundaryFor({ ...criteria, boundary: null, center: selectedCenter ?? null }) : null };
    if (mode === "boundary") {
      next.bounds = null;
      next.center = selectedCenter ?? null;
      next.boundary = next.boundary ? { ...next.boundary, center: next.center, bounds: null } : null;
    }
    changeCriteria(next);
  };

  const setRadiusKm = (value: number) => {
    if (!Number.isFinite(value)) return;
    const clamped = Math.min(maxRadiusMeters, Math.max(100, Math.round(value * 1000)));
    changeCriteria({ ...criteria, radiusMeters: clamped, mode: "radius", bounds: null, boundary: null });
  };
  const commitRadius = () => {
    const value = Number(radiusDraft);
    const km = Number.isFinite(value) && radiusDraft.trim() ? value : criteria.radiusMeters / 1000;
    setRadiusKm(km);
    setRadiusDraft(Math.min(maxRadiusKm, Math.max(0.1, km)).toFixed(1));
  };

  const [gridColumns, setGridColumns] = useState(2);
  const [gridRows, setGridRows] = useState(2);
  const [pagesPerTile, setPagesPerTile] = useState(1);
  const importMode = criteria.plan === "import";
  const tiledMode = criteria.plan === "tiled";
  const setPlan = (plan: NonNullable<SearchCriteria["plan"]>) => {
    changeCriteria({
      ...criteria,
      plan,
      mode: plan === "tiled" ? "area" : plan === "import" ? "radius" : criteria.mode,
      sources: plan === "import" ? ["serpapi"] : criteria.sources,
      bounds: plan === "import" ? null : criteria.bounds,
      boundary: null,
      tiling: plan === "tiled"
        ? criteria.tiling ?? { columns: gridColumns, rows: gridRows, tileCount: gridColumns * gridRows, maxPagesPerTile: pagesPerTile }
        : null,
      importRefs: plan === "import" ? importRefs : null,
    });
  };

  const countryOptions = useMemo(
    () => countries.map((item) => ({ value: item.code, label: item.name, hint: item.code })),
    [countries],
  );
  const regionOptions = useMemo(
    () => regions.map((item) => ({ value: item.code, label: item.name })),
    [regions],
  );
  const countyOptions = useMemo(
    () => counties.map((item) => ({ value: item.code, label: item.name })),
    [counties],
  );
  const cityOptions = useMemo(
    () =>
      cities.map((item) => ({
        value: String(item.id),
        label: item.name,
        hint: item.population > 0 ? `${Math.round(item.population / 1000)}k people` : undefined,
      })),
    [cities],
  );

  const boundaryTarget = boundaryFor(criteria);
  const geographyLoading = loading.countries || (Boolean(criteria.countryCode) && (loading.regions || (loadedGeo.regions !== criteria.countryCode && failedGeo.regions !== criteria.countryCode))) ||
    (Boolean(criteria.regionCode) && (loading.counties || (loadedGeo.counties !== criteria.regionCode && failedGeo.counties !== criteria.regionCode))) ||
    (Boolean(criteria.regionCode) && (loading.cities || (loadedGeo.cities !== (criteria.countyCode || criteria.regionCode) && failedGeo.cities !== (criteria.countyCode || criteria.regionCode))));
  const areaKm2 = criteria.bounds ? boundsAreaKm2(criteria.bounds) : 0;
  const missingQuery = !importMode && criteria.category === CATEGORY_ANY && criteria.keyword.trim().length === 0;
  const canRun =
    !running &&
    !estimateLoading &&
    criteria.sources.length > 0 &&
    !missingQuery &&
    (importMode
      ? serpapiConfigured && importRefs.length > 0
      : criteria.mode === "radius"
        ? Boolean(criteria.center)
        : criteria.mode === "boundary"
          ? Boolean(boundaryTarget) && !geographyLoading && (Boolean(boundaryTarget?.center) || !criteria.center && !boundaryTarget?.bounds)
          : Boolean(criteria.bounds));
  const monthPercent = usage ? percent(usage.month.used, usage.month.limit) : 0;
  const dayPercent = usage ? percent(usage.day.used, usage.day.limit) : 0;
  const serpapiSelected = criteria.sources.includes("serpapi");
  const estimatedMaxCost = usage ? usage.pricePerSearchUsd * Math.max(1, maxPagesPerRun) : 0;

  const toggleSource = (source: Source) => {
    const active = criteria.sources.includes(source);
    if (active && criteria.sources.length === 1) return;
    const next = active ? criteria.sources.filter((item) => item !== source) : [...criteria.sources, source];
    changeCriteria({ ...criteria, sources: next });
  };

  return (
    <form
      className={`search-panel${criteria.plan === "import" ? " search-panel--import" : ""}`}
      aria-labelledby="search-heading"
      onSubmit={(event) => {
        event.preventDefault();
        if (canRun) onRun();
      }}
    >
      <div className="search-panel__heading">
        <h2 id="search-heading">Find places</h2>
        <span className="search-panel__count">
          {criteria.sources.length} source{criteria.sources.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="field-grid">
        <Combobox
          id="country"
          label="Country"
          value={criteria.countryCode ?? ""}
          options={countryOptions}
          onChange={chooseCountry}
          placeholder={loading.countries ? "Loading…" : "Type to filter…"}
          disabled={loading.countries}
          hint={country?.center ? "Radius searches use a point near a major city, not the entire country." : undefined}
        />
        <Combobox
          id="region"
          label="Region / state"
          value={criteria.regionCode ?? ""}
          options={regionOptions}
          onChange={chooseRegion}
          placeholder={loading.regions ? "Loading…" : regionOptions.length ? "Type to filter…" : "No regions listed"}
          disabled={loading.regions || regionOptions.length === 0}
        />
        <Combobox
          id="county"
          label="County / district"
          value={criteria.countyCode ?? ""}
          options={countyOptions}
          onChange={chooseCounty}
          placeholder={
            loading.counties ? "Loading…" : countyOptions.length ? "Optional — type to filter…" : "No counties listed"
          }
          disabled={loading.counties || countyOptions.length === 0}
          hint={county ? "Narrows the city list and boundary" : undefined}
        />
        <Combobox
          id="city"
          label="City"
          value={criteria.cityId ? String(criteria.cityId) : ""}
          options={cityOptions}
          onChange={chooseCity}
          placeholder={loading.cities ? "Loading…" : cityOptions.length ? "Optional — type to filter…" : "No listed cities"}
          disabled={loading.cities || cityOptions.length === 0}
          hint={city ? `Center ${city.center.lat.toFixed(4)}, ${city.center.lon.toFixed(4)}` : undefined}
        />
      </div>
      {geoError ? <p className="field__hint field__hint--warning">{geoError}</p> : null}
      <p className="field__hint">
        Location names and coordinates: <a href="https://www.geonames.org/" target="_blank" rel="noreferrer noopener">GeoNames</a> (CC BY 4.0).
      </p>

      <div className="field">
        <label htmlFor="keyword">Keyword</label>
        <input
          id="keyword"
          type="text"
          value={criteria.keyword}
          maxLength={120}
          placeholder="e.g. biryani, coffee, dentist"
          onChange={(event) => changeCriteria({ ...criteria, keyword: event.target.value })}
          aria-describedby="keyword-hint"
        />
        <p className="field__hint" id="keyword-hint">
          Combined with the category when both are set. Names are matched differently by each source.
        </p>
      </div>

      <div className="field">
        <label htmlFor="category">Category</label>
        <select
          id="category"
          value={criteria.category}
          onChange={(event) => changeCriteria({ ...criteria, category: event.target.value, mode: criteria.mode })}
        >
          <option value={CATEGORY_ANY}>Any category</option>
          {CATEGORIES.map((category) => (
            <option key={category.id} value={category.id}>
              {category.label}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="fieldset">
        <legend>Discovery plan</legend>
        <div className="segmented segmented--three" role="group" aria-label="Discovery plan">
          <button type="button" className={!tiledMode && !importMode ? "segmented__option is-active" : "segmented__option"} aria-pressed={!tiledMode && !importMode} onClick={() => setPlan("standard")}>Standard</button>
          <button type="button" disabled={!criteria.bounds} className={tiledMode ? "segmented__option is-active" : "segmented__option"} aria-pressed={tiledMode} onClick={() => setPlan("tiled")}>Tiled</button>
          <button type="button" className={importMode ? "segmented__option is-active" : "segmented__option"} aria-pressed={importMode} onClick={() => setPlan("import")}>Import places</button>
        </div>
        {tiledMode ? (
          <div className="area-control">
            <p className="field__hint">Tiled SerpApi discovery samples a rectangle cell by cell. Every tile is a separately queued run with a budget check; it is not exhaustive coverage.</p>
            <div className="grid-controls">
              <label>Columns <input type="number" min={1} max={5} value={gridColumns} onChange={(event) => {
                const value = Math.max(1, Math.min(5, Number(event.target.value) || 1));
                setGridColumns(value);
                changeCriteria({ ...criteria, tiling: { columns: value, rows: gridRows, tileCount: value * gridRows, maxPagesPerTile: pagesPerTile } });
              }} /></label>
              <label>Rows <input type="number" min={1} max={5} value={gridRows} onChange={(event) => {
                const value = Math.max(1, Math.min(5, Number(event.target.value) || 1));
                setGridRows(value);
                changeCriteria({ ...criteria, tiling: { columns: gridColumns, rows: value, tileCount: gridColumns * value, maxPagesPerTile: pagesPerTile } });
              }} /></label>
              <label>Pages / tile <select value={pagesPerTile} onChange={(event) => {
                const value = Number(event.target.value);
                setPagesPerTile(value);
                changeCriteria({ ...criteria, tiling: { columns: gridColumns, rows: gridRows, tileCount: gridColumns * gridRows, maxPagesPerTile: value } });
              }}>{Array.from({ length: hardLimits.maxPagesPerTile }, (_, i) => i + 1).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            </div>
            <p className="field__hint">Limit: {hardLimits.maxTilesPerRun} tiles, {hardLimits.maxTiledAreaKm2.toLocaleString()} km² total, {hardLimits.maxPagesPerTile} pages per tile.</p>
          </div>
        ) : importMode ? (
          <div className="area-control">
            <label htmlFor="import-places">Google Maps URLs or place IDs</label>
            <textarea id="import-places" rows={4} maxLength={20000} value={importText} onChange={(event) => onImportTextChange(event.target.value)} placeholder="Paste Google Maps links or place_id / data_id / CID values, one per line" />
            <div className="button-row">
              <button type="button" className="button button--secondary button--small" disabled={importParsing || !importText.trim()} onClick={onParseImports}>{importParsing ? "Checking links…" : "Parse references"}</button>
              <span className="field__hint">{importRefs.length} / {hardLimits.maxImportPlaces} references ready</span>
            </div>
            {importRejected.length > 0 ? <ul className="field__hint field__hint--warning">{importRejected.map((item, index) => <li key={`${item.input}-${index}`}>{item.input}: {item.reason}</li>)}</ul> : null}
            <p className="field__hint">Each accepted place uses one paid SerpApi details request. Only Google-hosted links are resolved server-side. SerpApi configured: {serpapiConfigured ? "yes" : "no"}.</p>
          </div>
        ) : null}
      </fieldset>

      <fieldset className="fieldset">
        <legend>Search area</legend>
        <div className="segmented" role="group" aria-label="Search area mode">
          <button
            type="button"
            className={criteria.mode === "radius" ? "segmented__option is-active" : "segmented__option"}
            aria-pressed={criteria.mode === "radius"}
            onClick={() => setMode("radius")}
          >
            Radius
          </button>
          <button
            type="button"
            className={criteria.mode === "boundary" ? "segmented__option is-active" : "segmented__option"}
            aria-pressed={criteria.mode === "boundary"}
            onClick={() => setMode("boundary")}
          >
            Boundary
          </button>
          <button
            type="button"
            className={criteria.mode === "area" ? "segmented__option is-active" : "segmented__option"}
            aria-pressed={criteria.mode === "area"}
            onClick={() => {
              if (!criteria.bounds) {
                onUseMapView();
              } else {
                setMode("area");
              }
            }}
          >
            Map rectangle
          </button>
        </div>

        {criteria.mode === "radius" ? (
          <div className="radius-control">
            <div className="radius-control__row">
              <label htmlFor="radius-number">Radius (km)</label>
              <div className="radius-control__value">
                <input
                  id="radius-number"
                  type="number"
                  min={0.1}
                  max={maxRadiusKm}
                  step={0.1}
                  value={radiusDraft}
                  aria-label="Radius in kilometres"
                  onChange={(event) => setRadiusDraft(event.target.value)}
                  onBlur={commitRadius}
                />
                <span>km</span>
              </div>
            </div>
            <input
              id="radius"
              aria-label="Radius slider in kilometres"
              type="range"
              min={0.1}
              max={maxRadiusKm}
              step={0.1}
              value={Math.min(maxRadiusKm, Math.max(0.1, Math.round(radiusKm * 10) / 10))}
              onChange={(event) => setRadiusKm(Number(event.target.value))}
            />
            <div className="radius-control__scale">
              <span>0.1 km</span>
              <span>{maxRadiusKm.toFixed(1)} km max</span>
            </div>
            <p className="field__hint">
              Click the map or drag the center marker to move the search center. Distance is stored as{" "}
              {Math.round(criteria.radiusMeters).toLocaleString()} m.
            </p>
          </div>
        ) : criteria.mode === "boundary" ? (
          <div className="area-control">
            <p className="field__hint">
              {boundaryTarget
                ? `Searching ${boundaryTarget.name}: OpenStreetMap attempts its administrative area; paid providers sample near its center. Results are checked against the polygon when available. Large regions require polygon data and are sampled; smaller counties/cities are limited to ${hardLimits.maxAreaKm2 ?? 400} km².`
                : "Select a region, county, or city above to define the boundary."}
              {criteria.bounds ? " An explicitly selected map rectangle is available as a fallback area; the boundary intent remains selected." : ""}
              {boundaryTarget && !boundaryTarget.center ? " No reliable center is available. The server will use a matched OpenStreetMap boundary when available; otherwise it will use an explicitly selected map rectangle or clearly labeled approximate GeoNames bounds, and will not invent a center-radius search." : ""}
              {geographyLoading ? " Loading geography…" : ""}
            </p>
            {counties.length > 0 || cities.length > 0 ? (
              <p className="field__hint">
                Use the county and city fields to narrow the boundary. Leaving them empty searches the whole{" "}
                {region?.name ?? "region"}; large regions require a usable OSM polygon and paid sources remain sampled.
              </p>
            ) : null}
            <div className="button-row">
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={onUseMapView}
              >
                Use current map view instead
              </button>
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => setMode("radius")}
              >
                Back to radius
              </button>
            </div>
          </div>
        ) : (
          <div className="area-control">
            <p className="field__hint">
              {criteria.bounds
                ? `Selected rectangle ≈ ${areaKm2.toFixed(1)} km². Pan or zoom the map, then update the selection.`
                : "No map area selected yet. Show the map and press “Use current map view”."}
            </p>
            <div className="button-row">
              <button type="button" className="button button--secondary button--small" onClick={onUseMapView}>
                Use current map view
              </button>
              <button type="button" className="button button--ghost button--small" onClick={() => setMode("radius")}>
                Back to radius
              </button>
            </div>
            {criteria.bounds ? (
              <dl className="bounds-summary">
                <div>
                  <dt>South / West</dt>
                  <dd>
                    {criteria.bounds.south.toFixed(4)}, {criteria.bounds.west.toFixed(4)}
                  </dd>
                </div>
                <div>
                  <dt>North / East</dt>
                  <dd>
                    {criteria.bounds.north.toFixed(4)}, {criteria.bounds.east.toFixed(4)}
                  </dd>
                </div>
              </dl>
            ) : null}
          </div>
        )}
      </fieldset>

      <fieldset className="fieldset">
        <legend>Sources</legend>
        <label className={`source-toggle${criteria.sources.includes("osm") ? " source-toggle--on" : ""}`}>
          <input type="checkbox" checked={criteria.sources.includes("osm")} onChange={() => toggleSource("osm")} />
          <span className="source-toggle__body">
            <span className="source-toggle__title">OpenStreetMap</span>
            <span className="source-toggle__hint">Community-mapped places via Overpass. Free, no API key.</span>
          </span>
          <span className="badge badge--osm">OSM</span>
        </label>
        <label className={`source-toggle${criteria.sources.includes("serpapi") ? " source-toggle--on" : ""}`}>
          <input
            type="checkbox"
            checked={criteria.sources.includes("serpapi")}
            onChange={() => toggleSource("serpapi")}
          />
          <span className="source-toggle__body">
            <span className="source-toggle__title">SerpApi Google Maps</span>
            <span className="source-toggle__hint">
              {serpapiConfigured
                ? "Paid Google Maps results via SerpApi. Sample, not a complete inventory."
                : "Not configured on this server. Searches will be skipped."}
            </span>
          </span>
          <span className="badge badge--serpapi">SerpApi</span>
        </label>
        {criteria.sources.length === 1 ? (
          <p className="field__hint">At least one source must stay enabled.</p>
        ) : null}
      </fieldset>

      {usage ? (
        <section className="usage" aria-label="SerpApi budget">
          <div className="usage__row">
            <span>Monthly SerpApi budget</span>
            <strong>
              {usage.month.used} / {usage.month.limit}
            </strong>
          </div>
          <div className="meter" aria-hidden="true">
            <span className="meter__fill" style={{ width: `${monthPercent}%` }} />
          </div>
          <div className="usage__row usage__row--muted">
            <span>Today</span>
            <span>
              {usage.day.used} / {usage.day.limit}
            </span>
          </div>
          <div className="meter meter--small" aria-hidden="true">
            <span className="meter__fill" style={{ width: `${dayPercent}%` }} />
          </div>
          <div className="usage__row usage__row--muted">
            <span>Estimated spend this month</span>
            <span>{formatUsd(usage.estimatedCostUsd)}</span>
          </div>
          {serpapiSelected ? (
            <p className="usage__estimate">
              Up to {Math.max(1, maxPagesPerRun)} SerpApi page requests per run ≈{" "}
              {formatUsd(estimatedMaxCost)} before details or reviews.
            </p>
          ) : null}
          <button type="button" className="link-button" onClick={onOpenSettings}>
            Adjust limits and price
          </button>
        </section>
      ) : null}

      <div className="search-actions">
        <button type="submit" className="button button--primary button--wide" disabled={!canRun}>
          {running ? "Search running…" : estimateLoading ? "Estimating requests…" : tiledMode ? "Review and queue tiles" : importMode ? "Import places" : "Run search"}
        </button>
        <div className="button-row">
          <button type="button" className="button button--secondary button--small" onClick={onSaveSearch}>
            Save this search
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={onFitResults}
            disabled={!hasResults}
          >
            Fit results
          </button>
        </div>
        {missingQuery ? <p className="field__hint">Add a keyword or choose a category to search.</p> : null}
        {importMode && importRefs.length === 0 ? <p className="field__hint">Parse one or more references before starting the import.</p> : null}
      </div>
    </form>
  );
}
