import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { SearchCriteria } from "../../src/shared/types.js";
import { api } from "../../src/client/api.js";
import { SearchPanel } from "../../src/client/components/SearchPanel.js";
import { boundsCenter } from "../../src/shared/geo.js";

const countries = [
  { code: "BD", name: "Bangladesh", center: { lat: 23, lon: 90 } },
  { code: "FR", name: "France", center: { lat: 46, lon: 2 } },
];
const regions = [
  { code: "FR.1", name: "Île-de-France", countryCode: "FR", center: { lat: 49, lon: 2 } },
  { code: "FR.2", name: "Centerless Region", countryCode: "FR", center: null },
];

function criteria(overrides: Partial<SearchCriteria> = {}): SearchCriteria {
  return {
    keyword: "coffee", category: "restaurant", sources: ["osm"], mode: "radius",
    center: { lat: 23, lon: 90 }, radiusMeters: 2000, bounds: null,
    country: "Bangladesh", countryCode: "BD", region: "", regionCode: "",
    county: "", countyCode: "", city: "", cityId: null, area: "", boundary: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const focus = vi.fn();
function Panel({ initial, onUseMapView = vi.fn() }: { initial: SearchCriteria; onUseMapView?: () => void }) {
  const [value, setValue] = useState(initial);
  return <>
    <SearchPanel criteria={value} onChange={setValue} onRun={vi.fn()} running={false} usage={null}
      maxPagesPerRun={6} serpapiConfigured={false}
      hardLimits={{ maxRadiusMeters: 20000, maxTiledAreaKm2: 10000, maxTilesPerRun: 25, maxPagesPerTile: 3, maxImportPlaces: 25 }}
      importRefs={[]} importRejected={[]} importText="" importParsing={false} estimateLoading={false}
      onImportTextChange={vi.fn()} onParseImports={vi.fn()}
      onOpenSettings={vi.fn()} onUseMapView={onUseMapView} onFitResults={vi.fn()}
      onFocusGeography={focus} hasResults={false} onSaveSearch={vi.fn()} />
    <output data-testid="criteria">{JSON.stringify(value)}</output>
  </>;
}

function selected(): SearchCriteria {
  return JSON.parse(screen.getByTestId("criteria").textContent ?? "null") as SearchCriteria;
}

function choose(label: string, option: string) {
  fireEvent.focus(screen.getByRole("combobox", { name: label }));
  fireEvent.click(screen.getByRole("option", { name: new RegExp(option) }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  focus.mockClear();
  vi.spyOn(api, "geoCountries").mockResolvedValue({ countries, attribution: "test" });
  vi.spyOn(api, "geoRegions").mockImplementation(async (code) => ({ regions: code === "FR" ? regions : [], attribution: "test" }));
  vi.spyOn(api, "geoCounties").mockResolvedValue({ counties: [], attribution: "test" });
  vi.spyOn(api, "geoCities").mockResolvedValue({ cities: [], attribution: "test" });
});

describe("geography selection", () => {
  it("uses the API country center, clears descendants, keeps area mode and invalidates its rectangle", async () => {
    render(<Panel initial={criteria({ mode: "area", bounds: { south: 22, west: 89, north: 24, east: 91 },
      regionCode: "BD.1", region: "Old region" })} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Country" })).not.toBeDisabled());
    choose("Country", "France");
    expect(selected()).toMatchObject({ countryCode: "FR", regionCode: "", mode: "area", bounds: null, center: countries[1]?.center });
    expect(focus).toHaveBeenCalledWith({ center: countries[1]?.center, level: "country" });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Region / state" })).not.toBeDisabled());
    choose("Region / state", "Île-de-France");
    expect(selected()).toMatchObject({ regionCode: "FR.1", mode: "area", bounds: null, center: regions[0]?.center });
    expect(focus).toHaveBeenCalledWith({ center: regions[0]?.center, level: "region" });
  });

  it("keeps a selected centerless boundary eligible without fabricating a center", async () => {
    render(<Panel initial={criteria({ mode: "boundary", countryCode: "FR", country: "France", center: null })} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Region / state" })).not.toBeDisabled());
    choose("Region / state", "Centerless Region");
    expect(selected()).toMatchObject({ mode: "boundary", regionCode: "FR.2", center: null, boundary: { name: "Centerless Region", center: null } });
    expect(screen.getByRole("button", { name: "Run search" })).toBeDisabled();
  });

  it("pan and viewport updates do not select a rectangle until the explicit action", async () => {
    const onUseMapView = vi.fn();
    render(<Panel initial={criteria({
      mode: "boundary",
      regionCode: "FR.1",
      region: "Île-de-France",
      countryCode: "FR",
      country: "France",
      boundary: { level: "region", name: "Île-de-France", countryCode: "FR", center: { lat: 49, lon: 2 }, bounds: null },
    })} onUseMapView={onUseMapView} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Region / state" })).not.toBeDisabled());

    const viewport = { south: 48, west: 1, north: 50, east: 3 };
    const ViewportHarness = () => {
      const [viewportBounds, setViewportBounds] = useState<typeof viewport | null>(null);
      const [value, setValue] = useState(criteria({
        mode: "boundary", regionCode: "FR.1", region: "Île-de-France", countryCode: "FR", country: "France",
        boundary: { level: "region", name: "Île-de-France", countryCode: "FR", center: { lat: 49, lon: 2 }, bounds: null },
      }));
      return <>
        <button type="button" onClick={() => setViewportBounds(viewport)}>Simulate map pan</button>
        <output data-testid="viewport-criteria">{JSON.stringify(value)}</output>
        <SearchPanel criteria={value} onChange={setValue} onRun={vi.fn()} running={false} usage={null}
          maxPagesPerRun={6} serpapiConfigured={false}
          hardLimits={{ maxRadiusMeters: 20000, maxTiledAreaKm2: 10000, maxTilesPerRun: 25, maxPagesPerTile: 3, maxImportPlaces: 25 }}
          importRefs={[]} importRejected={[]} importText="" importParsing={false} estimateLoading={false}
          onImportTextChange={vi.fn()} onParseImports={vi.fn()} onOpenSettings={vi.fn()}
          onUseMapView={() => {
            if (!viewportBounds) return;
            setValue((current) => ({ ...current, mode: current.mode === "boundary" ? "boundary" : "area", bounds: viewportBounds, center: boundsCenter(viewportBounds) }));
          }}
          onFitResults={vi.fn()} onFocusGeography={focus} hasResults={false} onSaveSearch={vi.fn()} />
      </>;
    };
    render(<ViewportHarness />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Use current map view instead" })).toHaveLength(2));
    const currentPanelCriteria = () => JSON.parse(screen.getByTestId("viewport-criteria").textContent ?? "null") as SearchCriteria;
    expect(currentPanelCriteria()).toMatchObject({ mode: "boundary", bounds: null, boundary: { name: "Île-de-France" } });
    fireEvent.click(screen.getByRole("button", { name: "Simulate map pan" }));
    expect(currentPanelCriteria()).toMatchObject({ mode: "boundary", bounds: null, boundary: { name: "Île-de-France" } });

    fireEvent.click(screen.getAllByRole("button", { name: "Use current map view instead" })[1]!);
    expect(currentPanelCriteria()).toMatchObject({ mode: "boundary", bounds: viewport, center: boundsCenter(viewport), boundary: { level: "region", name: "Île-de-France" } });
  });

  it("does not let a pending geography response undo a newer keyword edit", async () => {
    const pending = deferred<{ regions: typeof regions; attribution: string }>();
    vi.mocked(api.geoRegions).mockImplementation((code) => code === "BD" ? pending.promise : Promise.resolve({ regions, attribution: "test" }));
    render(<Panel initial={criteria({ regionCode: "BD.1", region: "Retained region" })} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Keyword" }), { target: { value: "new keyword" } });
    await act(async () => pending.resolve({ regions: [], attribution: "test" }));
    expect(selected()).toMatchObject({ regionCode: "BD.1", keyword: "new keyword" });
  });

  it("offers the explicit map rectangle action without changing boundary intent", async () => {
    const onUseMapView = vi.fn();
    render(<Panel initial={criteria({
      mode: "boundary",
      countryCode: "FR",
      country: "France",
      regionCode: "FR.1",
      region: "Île-de-France",
      boundary: { level: "region", name: "Île-de-France", countryCode: "FR", center: { lat: 49, lon: 2 }, bounds: null },
    })} onUseMapView={onUseMapView} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Region / state" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Use current map view instead" }));
    expect(onUseMapView).toHaveBeenCalledTimes(1);
    expect(selected()).toMatchObject({ mode: "boundary", bounds: null, boundary: { level: "region", name: "Île-de-France" } });
  });

  it("does not auto-select a region or fabricate a country boundary", async () => {
    render(<Panel initial={criteria({ mode: "boundary", countryCode: "", country: "", center: null })} />);
    await waitFor(() => expect(selected().countryCode).toBe("BD"));
    expect(selected()).toMatchObject({ mode: "boundary", center: countries[0]?.center, regionCode: "", boundary: null });
    expect(focus).not.toHaveBeenCalled();
  });

  it("warns that pasted import links must be parsed before the run can start", () => {
    render(
      <SearchPanel
        criteria={criteria({ plan: "import", mode: "radius", sources: ["serpapi"], center: null })}
        onChange={vi.fn()}
        onRun={vi.fn()}
        running={false}
        usage={null}
        maxPagesPerRun={6}
        serpapiConfigured
        hardLimits={{ maxRadiusMeters: 20000, maxTiledAreaKm2: 10000, maxTilesPerRun: 25, maxPagesPerTile: 3, maxImportPlaces: 25 }}
        importRefs={[]}
        importRejected={[]}
        importText="https://maps.google.com/?cid=123"
        importParsing={false}
        estimateLoading={false}
        onImportTextChange={vi.fn()}
        onParseImports={vi.fn()}
        onOpenSettings={vi.fn()}
        onUseMapView={vi.fn()}
        onFitResults={vi.fn()}
        onFocusGeography={focus}
        hasResults={false}
        onSaveSearch={vi.fn()}
      />,
    );
    expect(screen.getByText(/Press “Parse references”/)).toBeInTheDocument();
    // The run must stay disabled until the pasted links are parsed: the submit
    // action (the wide import button) is disabled while refs are empty.
    const importButtons = screen.getAllByRole("button", { name: "Import places" });
    expect(importButtons.some((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });
});
