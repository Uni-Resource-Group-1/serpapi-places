import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { Place } from "../../src/shared/types.js";

const placeRequest = vi.hoisted(() => vi.fn());
vi.mock("../../src/client/api.js", () => ({
  ApiError: class ApiError extends Error {},
  api: { place: placeRequest },
}));

import { DetailsPanel } from "../../src/client/components/DetailsPanel.js";

function place(hours: unknown, extraFields: Record<string, unknown> = {}): Place {
  return {
    id: "place-1",
    source: "osm",
    sourceType: "osm_node",
    sourceId: "osm-1",
    sourceUrl: "https://www.openstreetmap.org/node/1",
    name: "Hours Test Cafe",
    address: "1 Example Street",
    category: "Cafe",
    lat: 23.78,
    lon: 90.41,
    distanceMeters: null,
    insideArea: null,
    areaCheck: null,
    fields: { hours, ...extraFields },
    provenance: {},
    detailsStatus: "fetched",
    detailsFetchedAt: null,
    retrievedAt: "2026-01-01T00:00:00.000Z",
    saved: false,
    possibleDuplicate: false,
    reviews: { available: false, fetched: 0, lastFetchedAt: null },
  };
}

function renderDetails(hours: unknown, extraFields: Record<string, unknown> = {}) {
  placeRequest.mockResolvedValue(place(hours, extraFields));
  return render(
    <DetailsPanel
      placeId="place-1"
      savedPlaces={[]}
      collections={[]}
      reviewsEnabled={false}
      onClose={() => undefined}
      onChanged={() => undefined}
      onNotify={() => undefined}
      onOpenDuplicates={() => undefined}
      onSearchHere={() => undefined}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("DetailsPanel opening hours", () => {
  it("renders complete weekly schedules as an accessible visual chart", async () => {
    renderDetails({
      days: [
        { day: "Monday", hours: "9 AM–5 PM" },
        { day: "Tuesday", hours: "9 AM–5 PM" },
        { day: "Wednesday", hours: "9 AM–5 PM" },
        { day: "Thursday", hours: "9 AM–5 PM" },
        { day: "Friday", hours: "9 AM–5 PM" },
        { day: "Saturday", hours: "10 AM–2 PM" },
        { day: "Sunday", hours: "Closed" },
      ],
    });
    const chart = await screen.findByRole("region", { name: /opening hours/i });
    expect(within(chart).getByText("Monday")).toBeInTheDocument();
    expect(within(chart).getByText("Sunday")).toBeInTheDocument();
    expect(within(chart).getAllByText("9 AM–5 PM")).toHaveLength(5);
    expect(within(chart).getByText("Closed")).toBeInTheDocument();
    expect(within(chart).getByRole("img", { name: "Monday: 9 AM–5 PM" })).toBeInTheDocument();
    expect(within(chart).getByRole("img", { name: "Sunday: Closed" })).toBeInTheDocument();
  });

  it("charts provider schedules stored as arrays of weekday-keyed objects", async () => {
    renderDetails([
      { wednesday: "7 AM–11 PM (Veterans Day might affect these hours)" },
      { thursday: "7 AM–11 PM" },
      { friday: "7 AM–11 PM" },
      { saturday: "7 AM–11 PM" },
      { sunday: "7 AM–11 PM" },
      { monday: "7 AM–11 PM" },
      { tuesday: "7 AM–11 PM" },
    ]);
    const chart = await screen.findByRole("region", { name: /opening hours/i });
    expect(within(chart).getByText("Monday")).toBeInTheDocument();
    expect(within(chart).getByText("Wednesday")).toBeInTheDocument();
    expect(within(chart).getByText(/Veterans Day might affect these hours/)).toBeInTheDocument();
  });

  it("does not show a partial bar for split hours and recognizes 24/7", async () => {
    renderDetails({ monday: "6 AM–10 AM, 12 PM–6 PM", tuesday: "24/7", wednesday: "10 PM–2 AM" });
    const chart = await screen.findByRole("region", { name: /opening hours/i });
    const split = within(chart).getByRole("img", { name: "Monday: 6 AM–10 AM, 12 PM–6 PM" });
    expect(split.querySelector(".hours-chart__unknown")).toBeInTheDocument();
    const allDay = within(chart).getByRole("img", { name: "Tuesday: 24/7" });
    expect(allDay.querySelector(".hours-chart__bar")).toHaveStyle({ width: "100%" });
    const overnight = within(chart).getByRole("img", { name: "Wednesday: 10 PM–2 AM" });
    const bar = overnight.querySelector<HTMLElement>(".hours-chart__bar");
    expect(parseFloat(bar?.style.width ?? "")).toBeCloseTo(100 / 6);
  });

  it("keeps flat hours as source text without inventing a weekly chart", async () => {
    renderDetails("Mo-Su 11:00-23:00");
    expect(await screen.findByText("Mo-Su 11:00-23:00")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /opening hours/i })).not.toBeInTheDocument();
  });
});

describe("DetailsPanel visual summary", () => {
  it("summarizes rating, open state, and price level for the place", async () => {
    renderDetails(null, {
      rating: 4.5,
      reviews: 1200,
      open_state: "Open ⋅ Closes 11 PM",
      price: "$$",
    });

    const hero = await screen.findByRole("region", { name: /place summary/i });
    expect(within(hero).getByLabelText(/rated 4\.5 out of 5 from 1200 source reviews/i)).toBeInTheDocument();
    expect(within(hero).getByText("4.5")).toBeInTheDocument();
    expect(within(hero).getByText("1,200 source reviews")).toBeInTheDocument();

    const fill = hero.querySelector<HTMLElement>(".stars__fill");
    expect(fill).toHaveStyle({ width: "90%" });

    expect(within(hero).getByText("Open now")).toBeInTheDocument();
    expect(within(hero).getByText("Closes 11 PM")).toBeInTheDocument();
    expect(within(hero).getByText("Price level $$", { selector: ".visually-hidden" })).toBeInTheDocument();
  });

  it("renders service, accessibility, and offering attributes as chips", async () => {
    renderDetails(null, {
      service_options: { dine_in: true, takeout: true, delivery: false },
      accessibility: { wheelchair_accessible_entrance: true },
      at_this_place: ["Dogs allowed"],
    });

    const highlights = await screen.findByRole("region", { name: /highlights/i });
    expect(within(highlights).getByText("Services")).toBeInTheDocument();
    expect(within(highlights).getByText(/^Dine in/)).toBeInTheDocument();
    expect(within(highlights).getByText(/^Takeout/)).toBeInTheDocument();
    expect(within(highlights).getByText("Accessibility")).toBeInTheDocument();
    expect(within(highlights).getByText(/^Wheelchair accessible entrance/)).toBeInTheDocument();
    expect(within(highlights).getByText("At this place")).toBeInTheDocument();
    expect(within(highlights).getByText(/^Dogs allowed/)).toBeInTheDocument();

    const delivery = within(highlights).getByText(/^Delivery/).closest("li");
    expect(delivery).toHaveClass("detail-chip--off");
    expect(delivery).toHaveTextContent(": no");
  });
});