// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/server/sources/http.js", () => ({
  requestJson: vi.fn(),
}));

// Provider tests must not reach the settings database; credential precedence is
// covered separately in serpapi-credentials.test.ts.
vi.mock("../../src/server/services/serpapi-credentials.js", () => ({
  resolveSerpApiKey: vi.fn().mockResolvedValue("fake-serpapi-key"),
}));

import { requestJson } from "../../src/server/sources/http.js";
import { loadConfig } from "../../src/server/config.js";
import {
  buildSerpApiSearchParams,
  getSerpApiDetails,
  getSerpApiReviews,
  searchSerpApiPage,
} from "../../src/server/sources/serpapi.js";
import type { SearchCriteria } from "../../src/shared/types.js";

const config = loadConfig({
  APP_ACCESS_KEY: "test-access-key-not-for-production-0001",
  NODE_ENV: "test",
  SERPAPI_API_KEY: "fake-serpapi-key",
  SERPAPI_HL: "en",
});

const mocked = vi.mocked(requestJson);

function criteria(overrides: Partial<SearchCriteria> = {}): SearchCriteria {
  return {
    keyword: "biryani",
    category: "restaurant",
    sources: ["serpapi"],
    mode: "radius",
    center: { lat: 23.7808, lon: 90.4162 },
    radiusMeters: 2000,
    bounds: null,
    countryCode: "BD",
    country: "Bangladesh",
    region: "Dhaka Division",
    city: "Dhaka",
    area: "Dhanmondi",
    ...overrides,
  };
}

beforeEach(() => {
  mocked.mockReset();
});

describe("buildSerpApiSearchParams", () => {
  it("builds a paged google_maps search", () => {
    const params = buildSerpApiSearchParams(criteria(), 2, config);
    expect(params.get("engine")).toBe("google_maps");
    expect(params.get("type")).toBe("search");
    expect(params.get("q")).toBe("biryani restaurants");
    expect(params.get("start")).toBe("40");
    expect(params.get("gl")).toBe("bd");
    expect(params.get("hl")).toBe("en");
    expect(params.get("ll")).toBe("@23.780800,90.416200,14z");
  });

  it("uses the selected country's Google Maps locale", () => {
    const params = buildSerpApiSearchParams(criteria({ countryCode: "US" }), 0, config);
    expect(params.get("gl")).toBe("us");
  });

  it("rejects a search without an explicit country instead of applying a locale fallback", () => {
    expect(() => buildSerpApiSearchParams(criteria({ country: "", countryCode: undefined }), 0, config))
      .toThrow(/select a country before using SerpApi/i);
  });

  it("falls back to the category when there is no keyword", () => {
    expect(buildSerpApiSearchParams(criteria({ keyword: "" }), 0, config).get("q")).toBe("restaurants");
  });

  it("uses a different zoom for a wider radius", () => {
    const params = buildSerpApiSearchParams(criteria({ radiusMeters: 10_000 }), 0, config);
    expect(params.get("ll")).toContain(",12z");
  });

  it("frames the resolved boundary bbox rather than using radius zoom", () => {
    const params = buildSerpApiSearchParams(criteria({
      mode: "boundary",
      bounds: { south: 23.5, west: 90, north: 24, east: 90.5 },
      center: { lat: 23.75, lon: 90.25 },
      boundary: { level: "county", name: "Dhaka", countryCode: "BD" },
    }), 0, config);
    expect(params.get("ll")).toBe("@23.750000,90.250000,10z");
  });

  it("throws without a center point", () => {
    expect(() => buildSerpApiSearchParams(criteria({ center: null }), 0, config)).toThrow(/center point/i);
  });
});

describe("searchSerpApiPage", () => {
  it("rejects missing country before dispatching to SerpApi", async () => {
    await expect(searchSerpApiPage(criteria({ country: "", countryCode: undefined }), 0, config))
      .rejects.toThrow(/select a country before using SerpApi/i);
    expect(mocked).not.toHaveBeenCalled();
  });

  it("normalises local results and keeps identifiers distinct", async () => {
    mocked.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: {
        local_results: [
          {
            title: "Sultan's Dine",
            place_id: "place-1",
            data_id: "0x123:0x456",
            data_cid: "987654",
            address: "Road 11, Dhaka",
            type: "Restaurant",
            gps_coordinates: { latitude: 23.78, longitude: 90.41 },
            rating: 4.5,
            reviews: 1200,
            website: "https://example.com",
            phone: "+880 1700 000000",
          },
        ],
        serpapi_pagination: { next: "https://serpapi.com/next" },
      },
    });

    const page = await searchSerpApiPage(criteria(), 0, config);
    expect(page.returned).toBe(1);
    expect(page.hasNext).toBe(true);
    expect(page.places).toHaveLength(1);
    const place = page.places[0];
    expect(place?.sourceId).toBe("place_id:place-1");
    expect(place?.fields.place_id).toBe("place-1");
    expect(place?.fields.data_id).toBe("0x123:0x456");
    expect(place?.fields.data_cid).toBe("987654");
    expect(place?.sourceUrl).toContain("place_id:place-1");
    expect(place?.detailsStatus).toBe("not_fetched");
    expect(page.sanitizedParams).not.toHaveProperty("api_key");
  });

  it("keeps the structured provider fields when the search payload includes them", async () => {
    mocked.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: {
        local_results: [
          {
            title: "Sultan's Dine",
            place_id: "place-1",
            gps_coordinates: { latitude: 23.78, longitude: 90.41 },
            hours: { Monday: "11 AM–11 PM", Tuesday: "11 AM–11 PM" },
            hours_last_updated: { raw: "Monday, 12:00 AM" },
            location_summary: { text: "Inside a shopping complex" },
            at_this_place: ["Dine-in", "Takeout"],
          },
        ],
      },
    });
    const page = await searchSerpApiPage(criteria(), 0, config);
    const fields = page.places[0]?.fields;
    expect(fields?.hours).toEqual({ Monday: "11 AM–11 PM", Tuesday: "11 AM–11 PM" });
    expect(fields?.hours_last_updated).toEqual({ raw: "Monday, 12:00 AM" });
    expect(fields?.location_summary).toEqual({ text: "Inside a shopping complex" });
    expect(fields?.at_this_place).toEqual(["Dine-in", "Takeout"]);
  });

  it("normalizes a complete weekly hours object into Monday-first day entries", async () => {
    mocked.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: {
        local_results: [
          {
            title: "Full Hours Cafe",
            place_id: "place-full",
            gps_coordinates: { latitude: 23.78, longitude: 90.41 },
            hours: {
              Sunday: "Closed",
              Monday: "9 AM–5 PM",
              Tuesday: "9 AM–5 PM",
              Wednesday: "9 AM–5 PM",
              Thursday: "9 AM–5 PM",
              Friday: "9 AM–5 PM",
              Saturday: "10 AM–2 PM",
            },
          },
        ],
      },
    });
    const page = await searchSerpApiPage(criteria(), 0, config);
    const hours = page.places[0]?.fields.hours as { days: Array<{ day: string; hours: string }> };
    expect(hours.days.map((entry) => entry.day)).toEqual([
      "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    ]);
    expect(hours.days[0]).toEqual({ day: "Monday", hours: "9 AM–5 PM" });
    expect(hours.days[6]).toEqual({ day: "Sunday", hours: "Closed" });
  });

  it("leaves an incomplete weekly hours object untouched", async () => {
    mocked.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: {
        local_results: [
          {
            title: "Partial Hours",
            place_id: "place-partial",
            gps_coordinates: { latitude: 23.78, longitude: 90.41 },
            hours: { Monday: "9 AM–5 PM", Tuesday: "9 AM–5 PM", Wednesday: "9 AM–5 PM" },
          },
        ],
      },
    });
    const page = await searchSerpApiPage(criteria(), 0, config);
    expect(page.places[0]?.fields.hours).toEqual({
      Monday: "9 AM–5 PM",
      Tuesday: "9 AM–5 PM",
      Wednesday: "9 AM–5 PM",
    });
  });

  it("omits the requested fields when the provider does not return them", async () => {
    mocked.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: {
        local_results: [
          { title: "Bare", place_id: "bare-1", gps_coordinates: { latitude: 23.7, longitude: 90.4 } },
        ],
      },
    });
    const page = await searchSerpApiPage(criteria(), 0, config);
    const fields = page.places[0]?.fields ?? {};
    for (const key of ["popular_times", "location_summary", "at_this_place", "hours_last_updated"]) {
      expect(fields).not.toHaveProperty(key);
    }
  });

  it("treats a successful fully empty map result as exhausted, not a provider error", async () => {
    mocked.mockResolvedValue({ status: 200, headers: new Headers(), data: {
      search_metadata: { status: "Success" }, local_results_state: "Fully empty",
      error: "Google hasn't returned any results for this query.",
    } });
    const page = await searchSerpApiPage(criteria(), 0, config);
    expect(page).toMatchObject({ returned: 0, hasNext: false, places: [] });
  });

  it("does not infer a next paid page from 20 results without pagination", async () => {
    mocked.mockResolvedValue({ status: 200, headers: new Headers(), data: {
      local_results: Array.from({ length: 20 }, (_, index) => ({ title: `Place ${index}`, place_id: `p-${index}`, gps_coordinates: { latitude: 23.8, longitude: 90.4 } })),
    } });
    expect((await searchSerpApiPage(criteria(), 0, config)).hasNext).toBe(false);
  });

  it("prefers data_id when place_id is absent", async () => {
    mocked.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: {
        local_results: [
          {
            title: "No Place Id",
            data_id: "0xabc:0xdef",
            gps_coordinates: { latitude: 23.78, longitude: 90.41 },
          },
        ],
      },
    });
    const page = await searchSerpApiPage(criteria(), 0, config);
    expect(page.places[0]?.sourceId).toBe("data_id:0xabc:0xdef");
  });

  it("skips results without an identifier or coordinates", async () => {
    mocked.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: {
        local_results: [
          { title: "No id", gps_coordinates: { latitude: 23.78, longitude: 90.41 } },
          { title: "No coords", place_id: "p2" },
          { title: "Good", place_id: "p3", gps_coordinates: { latitude: 23.7, longitude: 90.4 } },
        ],
      },
    });
    const page = await searchSerpApiPage(criteria(), 0, config);
    expect(page.returned).toBe(3);
    expect(page.places).toHaveLength(1);
    expect(page.parseRejections).toEqual({
      unusableCoordinates: 1, missingName: 0, missingIdentifier: 1, other: 0,
    });
  });

  it("accounts for malformed records and prioritizes one rejection reason per result", async () => {
    mocked.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: {
        place_results: { title: "Place", place_id: "single", gps_coordinates: { latitude: 23, longitude: 90 } },
        local_results: [
          null,
          "bad",
          { title: " ", place_id: "p1" },
          { title: "Bad coordinates", place_id: "p2", gps_coordinates: { latitude: 91, longitude: 90 } },
          { title: "No id", gps_coordinates: { latitude: 23, longitude: 90 } },
          { title: "Valid", data_cid: "cid", gps_coordinates: { latitude: 0, longitude: 0 } },
        ],
      },
    });
    const page = await searchSerpApiPage(criteria(), 0, config);
    expect(page.returned).toBe(7);
    expect(page.places).toHaveLength(2);
    expect(page.parseRejections).toEqual({
      unusableCoordinates: 1, missingName: 1, missingIdentifier: 1, other: 2,
    });
    expect(page.returned).toBe(page.places.length + Object.values(page.parseRejections ?? {}).reduce((a, b) => a + b, 0));
  });

  it("throws a source error when SerpApi reports an error", async () => {
    mocked.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: { error: "Invalid API key" },
    });
    await expect(searchSerpApiPage(criteria(), 0, config)).rejects.toThrow(/Invalid API key/);
  });
});

describe("getSerpApiDetails", () => {
  it("uses place_id and excludes the API key from provenance", async () => {
    mocked.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: {
        place_results: {
          title: "Sultan's Dine",
          place_id: "place-1",
          address: "Road 11",
          type: "Restaurant",
          gps_coordinates: { latitude: 23.78, longitude: 90.41 },
          rating: 4.6,
          website: "https://example.com",
        },
      },
    });
    const result = await getSerpApiDetails({ place_id: "place-1" }, config);
    expect(result.name).toBe("Sultan's Dine");
    expect(result.fields.rating).toBe(4.6);
    expect(result.provenance.rating?.source).toBe("serpapi");
    const calledUrl = String(mocked.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("type=place");
    expect(calledUrl).toContain("place_id=place-1");
  });

  it("refuses records without a provider identifier", async () => {
    await expect(getSerpApiDetails({}, config)).rejects.toThrow(/no place_id/i);
    expect(mocked).not.toHaveBeenCalled();
  });

  it("keeps popular times, location summary, at-this-place, and hours last updated", async () => {
    mocked.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: {
        place_results: {
          title: "Sultan's Dine",
          place_id: "place-1",
          gps_coordinates: { latitude: 23.78, longitude: 90.41 },
          hours: { Monday: { open: "11 AM", close: "11 PM" } },
          hours_last_updated: "Monday, 12:00 AM",
          popular_times: {
            graph_results: [{ hour: 12, busyness_score: 70 }],
            live: "Typically not busy",
          },
          location_summary: { text: "Ground floor of the mall" },
          at_this_place: ["Dine-in", { option: "Delivery", available: true }],
        },
      },
    });
    const result = await getSerpApiDetails({ place_id: "place-1" }, config);
    expect(result.fields.hours).toEqual({ Monday: { open: "11 AM", close: "11 PM" } });
    expect(result.fields.hours_last_updated).toBe("Monday, 12:00 AM");
    expect(result.fields.popular_times).toEqual({
      graph_results: [{ hour: 12, busyness_score: 70 }],
      live: "Typically not busy",
    });
    expect(result.fields.location_summary).toEqual({ text: "Ground floor of the mall" });
    expect(result.fields.at_this_place).toEqual(["Dine-in", { option: "Delivery", available: true }]);
    expect(result.provenance.popular_times?.source).toBe("serpapi");
  });

  it("omits structured fields the provider did not return", async () => {
    mocked.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: {
        place_results: {
          title: "Bare",
          place_id: "bare-1",
          gps_coordinates: { latitude: 23.78, longitude: 90.41 },
        },
      },
    });
    const result = await getSerpApiDetails({ place_id: "bare-1" }, config);
    expect(result.fields).not.toHaveProperty("popular_times");
    expect(result.fields).not.toHaveProperty("location_summary");
    expect(result.fields).not.toHaveProperty("at_this_place");
    expect(result.fields).not.toHaveProperty("hours_last_updated");
  });
});

describe("getSerpApiReviews", () => {
  it("requests reviews with data_id and parses snippets", async () => {
    mocked.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: {
        reviews: [
          {
            review_id: "r1",
            user: { name: "Ayesha" },
            rating: 5,
            date: "2 weeks ago",
            snippet: "Great biryani",
            likes: 12,
          },
        ],
        serpapi_pagination: { next_page_token: "token-2" },
      },
    });
    const result = await getSerpApiReviews({ data_id: "0x1:0x2" }, 1, null, config);
    expect(result.reviews[0]?.authorName).toBe("Ayesha");
    expect(result.reviews[0]?.snippet).toBe("Great biryani");
    expect(result.hasNext).toBe(true);
    expect(result.nextPageToken).toBe("token-2");
    const calledUrl = String(mocked.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("engine=google_maps_reviews");
    expect(calledUrl).toContain("data_id=0x1%3A0x2");
  });

  it("passes a next page token when provided", async () => {
    mocked.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: { reviews: [] },
    });
    await getSerpApiReviews({ place_id: "p1" }, 2, "next-token", config);
    expect(String(mocked.mock.calls[0]?.[0])).toContain("next_page_token=next-token");
  });

  it("requires an identifier", async () => {
    await expect(getSerpApiReviews({}, 1, null, config)).rejects.toThrow(/identifier/i);
  });
});

describe("SerpApi pagination offsets", () => {
  it("is zero-based so the first request asks for start=0", () => {
    expect(buildSerpApiSearchParams(criteria(), 0, config).get("start")).toBe("0");
    expect(buildSerpApiSearchParams(criteria(), 1, config).get("start")).toBe("20");
    expect(buildSerpApiSearchParams(criteria(), 3, config).get("start")).toBe("60");
  });
});
