import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Combobox } from "../../src/client/components/Combobox.js";
import { ResultsPanel } from "../../src/client/components/ResultsPanel.js";
import { NoticeBar } from "../../src/client/components/Feedback.js";
import { formatDistance, formatRelative, percent, truncate } from "../../src/client/format.js";
import type { Place, SearchRun } from "../../src/shared/types.js";

function place(overrides: Partial<Place> = {}): Place {
  return {
    id: "p1",
    source: "osm",
    sourceType: "osm_node",
    sourceId: "123",
    sourceUrl: "https://www.openstreetmap.org/node/123",
    name: "Sultan's Dine",
    address: "Road 11, Banani, Dhaka",
    category: "Restaurant",
    lat: 23.7808,
    lon: 90.4162,
    distanceMeters: 420,
    insideArea: true,
    areaCheck: "radius",
    fields: { rating: 4.5, reviews: 1200 },
    provenance: { name: { source: "osm", retrievedAt: "2026-01-01T00:00:00.000Z" } },
    detailsStatus: "fetched",
    detailsFetchedAt: "2026-01-01T00:00:00.000Z",
    retrievedAt: "2026-01-01T00:00:00.000Z",
    saved: false,
    possibleDuplicate: false,
    reviews: { available: false, fetched: 0, lastFetchedAt: null },
    ...overrides,
  };
}

function run(overrides: Partial<SearchRun> = {}): SearchRun {
  return {
    id: "run-1",
    status: "completed",
    coverage: "within_limits",
    criteria: {
      keyword: "biryani",
      category: "restaurant",
      sources: ["osm", "serpapi"],
      mode: "radius",
      center: { lat: 23.78, lon: 90.41 },
      radiusMeters: 2000,
      bounds: null,
      country: "Bangladesh",
      region: "Dhaka Division",
      city: "Dhaka",
      area: "Dhanmondi",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    finishedAt: "2026-01-01T00:00:05.000Z",
    counts: { total: 2, osm: 1, serpapi: 1, filteredOut: 3, duplicates: 1 },
    sources: [
      {
        source: "osm",
        status: "ok",
        requests: 1,
        pages: 1,
        results: 20,
        kept: 1,
        filteredOut: 2,
        duplicates: 0,
        creditsEstimated: 0,
        creditsActual: 0,
      },
      {
        source: "serpapi",
        status: "ok",
        requests: 1,
        pages: 1,
        results: 20,
        kept: 1,
        filteredOut: 1,
        duplicates: 1,
        creditsEstimated: 1,
        creditsActual: 1,
      },
    ],
    pagesProcessed: { osm: 1, serpapi: 1 },
    requests: { osm: 1, serpapi: 1 },
    credits: { estimated: 1, actual: 1 },
    truncated: false,
    errors: [],
    caveats: ["SerpApi results are a sample, not a complete inventory."],
    savedSearchId: null,
    ...overrides,
  };
}

const handlers = {
  onSelectPlace: vi.fn(),
  onHoverPlace: vi.fn(),
  onLoadMore: vi.fn(),
  onSwitchRun: vi.fn(),
  onRetryRun: vi.fn(),
  onSavePlace: vi.fn(),
  onRemoveSavedPlace: vi.fn(),
  onExportRun: vi.fn(),
  onOpenLibrary: vi.fn(),
  onSortChange: vi.fn(),
  onShowOutsideChange: vi.fn(),
  sortKey: "distance" as const,
  showOutside: false,
  rankById: new Map<string, number>(),
};

describe("NoticeBar", () => {
  it("announces errors assertively and other notices politely", () => {
    const { rerender } = render(<NoticeBar notice={{ id: 1, kind: "error", message: "Could not save." }} onDismiss={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
    rerender(<NoticeBar notice={{ id: 2, kind: "success", message: "Saved." }} onDismiss={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });
});

describe("format helpers", () => {
  it("formats distances", () => {
    expect(formatDistance(420)).toBe("420 m");
    expect(formatDistance(2400)).toBe("2.4 km");
    expect(formatDistance(null)).toBe("—");
  });

  it("computes bounded percentages", () => {
    expect(percent(5, 10)).toBe(50);
    expect(percent(20, 10)).toBe(100);
    expect(percent(-1, 10)).toBe(0);
    expect(percent(1, 0)).toBe(100);
  });

  it("truncates long strings", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("ab", 4)).toBe("ab");
  });

  it("describes relative times", () => {
    expect(formatRelative(null)).toBe("never");
    expect(formatRelative(new Date().toISOString())).toBe("just now");
  });
});

describe("Combobox", () => {
  it("exposes combobox semantics and selects an option", () => {
    const onChange = vi.fn();
    render(
      <Combobox
        id="city"
        label="City"
        value=""
        options={[
          { value: "dhaka", label: "Dhaka" },
          { value: "chattogram", label: "Chattogram" },
        ]}
        onChange={onChange}
      />,
    );
    const input = screen.getByRole("combobox", { name: "City" });
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    fireEvent.focus(input);
    fireEvent.click(screen.getByRole("option", { name: /Chattogram/ }));
    expect(onChange).toHaveBeenCalledWith("chattogram");
  });

  it("does not change the selected country on focus and Enter, but selects after navigation", () => {
    const onChange = vi.fn();
    render(<Combobox id="country" label="Country" value="BD" options={[
      { value: "AF", label: "Afghanistan" },
      { value: "BD", label: "Bangladesh" },
    ]} onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: "Country" });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Home" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("AF");
  });

  it("selects the highlighted option on Enter without requiring arrow navigation", () => {
    const onChange = vi.fn();
    render(<Combobox id="city" label="City" value="" options={[
      { value: "dhaka", label: "Dhaka" },
      { value: "chattogram", label: "Chattogram" },
    ]} onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: "City" });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("dhaka");
  });

  it("keeps the active descendant valid when filtering shrinks the options", () => {
    render(<Combobox id="city" label="City" value="" options={[
      { value: "dhaka", label: "Dhaka" },
      { value: "chattogram", label: "Chattogram" },
    ]} onChange={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "City" });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "End" });
    fireEvent.change(input, { target: { value: "Dha" } });
    expect(input).toHaveAttribute("aria-activedescendant", "city-option-0");
    expect(document.getElementById("city-option-0")).toBeInTheDocument();
  });

  it("matches accents and ignores case", () => {
    render(<Combobox id="region" label="Region" value="" options={[{ value: "qc", label: "Québec" }]} onChange={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "Region" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "QUE" } });
    expect(screen.getByRole("option", { name: /Québec/ })).toBeInTheDocument();
  });

  it("matches country codes and ranks an exact code before broader name matches", () => {
    render(
      <Combobox
        id="country"
        label="Country"
        value=""
        options={[
          { value: "UM", label: "United States Minor Outlying Islands", hint: "UM" },
          { value: "US", label: "United States", hint: "US" },
          { value: "UY", label: "Uruguay", hint: "UY" },
          { value: "CN", label: "Chad North", hint: "CN" },
        ]}
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Country" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "US" } });
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("United States");
    expect(options[0]).toHaveTextContent("US");
    fireEvent.change(input, { target: { value: "UM" } });
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("UM");
  });
});

describe("ResultsPanel", () => {
  it("renders source-separated results with coverage counts", () => {
    render(
      <ResultsPanel
        run={run()}
        runs={[run()]}
        places={[
          place(),
          place({
            id: "p2",
            source: "serpapi",
            sourceType: "serpapi",
            sourceId: "place_id:abc",
            name: "Biryani House",
            possibleDuplicate: true,
          }),
        ]}
        total={2}
        loading={false}
        loadingMore={false}
        error={null}
        selectedId={null}
        {...handlers}
      />,
    );

    expect(screen.getByRole("heading", { name: "Results" })).toBeInTheDocument();
    expect(screen.getByText("Biryani House")).toBeInTheDocument();
    expect(screen.getByText("Sultan's Dine")).toBeInTheDocument();
    expect(screen.getByText("Possible duplicate")).toBeInTheDocument();
    expect(screen.getByText("Invalid records")).toBeInTheDocument();
    expect(screen.getByText(/SerpApi results are a sample/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show details for Sultan's Dine, result 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show details for Biryani House, result 2" })).toBeInTheDocument();
  });

  it("hides outside records until the shared toggle is enabled", () => {
    const onShowOutsideChange = vi.fn();
    render(
      <ResultsPanel
        run={run()}
        runs={[]}
        places={[
          place(),
          place({
            id: "p2",
            name: "Far Away Cafe",
            insideArea: false,
            distanceMeters: 9_000,
          }),
        ]}
        total={2}
        loading={false}
        loadingMore={false}
        error={null}
        selectedId={null}
        {...handlers}
        onShowOutsideChange={onShowOutsideChange}
      />,
    );

    expect(screen.queryByText("Far Away Cafe")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /show 1 outside the selected area/i }));
    expect(onShowOutsideChange).toHaveBeenCalledWith(true);
  });

  it("uses the shared rank map for numbered result cards", () => {
    render(
      <ResultsPanel
        run={run()}
        runs={[]}
        places={[place()]}
        total={1}
        loading={false}
        loadingMore={false}
        error={null}
        selectedId={null}
        {...handlers}
        rankById={new Map([["p1", 7]])}
      />,
    );
    expect(screen.getByRole("button", { name: "Show details for Sultan's Dine, result 7" })).toBeInTheDocument();
  });

  it("shows an honest empty state when no valid places are returned", () => {
    render(
      <ResultsPanel
        run={run({ counts: { total: 0, osm: 0, serpapi: 0, filteredOut: 4, duplicates: 0 } })}
        runs={[]}
        places={[]}
        total={0}
        loading={false}
        loadingMore={false}
        error={null}
        selectedId={null}
        {...handlers}
      />,
    );
    expect(screen.getByText("No valid places returned")).toBeInTheDocument();
    expect(screen.getByText(/absence is not proof/i)).toBeInTheDocument();
  });

  it("invokes the save handler from a result card", () => {
    const onSavePlace = vi.fn();
    render(
      <ResultsPanel
        run={run()}
        runs={[]}
        places={[place()]}
        total={1}
        loading={false}
        loadingMore={false}
        error={null}
        selectedId={null}
        {...handlers}
        onSavePlace={onSavePlace}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save Sultan's Dine" }));
    expect(onSavePlace).toHaveBeenCalledTimes(1);
  });

  it("shows a running state for queued runs", () => {
    render(
      <ResultsPanel
        run={run({ status: "running", counts: { total: 0, osm: 0, serpapi: 0, filteredOut: 0, duplicates: 0 } })}
        runs={[]}
        places={[]}
        total={0}
        loading
        loadingMore={false}
        error={null}
        selectedId={null}
        {...handlers}
      />,
    );
    expect(screen.getByText("Searching sources…")).toBeInTheDocument();
    expect(screen.getByLabelText("Search in progress")).toBeInTheDocument();
  });

  it("offers a Retry beside a results error so a failed load is recoverable in place", () => {
    const onRetryRun = vi.fn();
    render(
      <ResultsPanel
        run={run()}
        runs={[run()]}
        places={[]}
        total={0}
        loading={false}
        loadingMore={false}
        error="Could not load results."
        pricePerSearchUsd={0.015}
        selectedId={null}
        {...handlers}
        onRetryRun={onRetryRun}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load results.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryRun).toHaveBeenCalledTimes(1);
  });
});
