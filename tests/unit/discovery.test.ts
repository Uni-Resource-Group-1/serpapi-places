// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import type { SearchCriteria } from "../../src/shared/types.js";

vi.mock("../../src/server/services/usage.js", () => ({
  getSettings: vi.fn().mockResolvedValue({ serpapiPriceUsd: 0.015, serpapiMaxPages: 6 }),
  getUsage: vi.fn().mockResolvedValue({ day: { remaining: 100 }, month: { remaining: 250 } }),
}));

import { buildDiscoveryEstimate } from "../../src/server/services/discovery.js";

const criteria: SearchCriteria = {
  keyword: "coffee", category: "restaurant", sources: ["serpapi"], mode: "radius",
  center: { lat: 40.7, lon: -74 }, radiusMeters: 1000, bounds: null,
  country: "United States", countryCode: "US", region: "New York", city: "New York", area: "Manhattan",
};

const appConfig = loadConfig({ APP_ACCESS_KEY: "test-access-key-not-for-production-0001", NODE_ENV: "test" });

describe("buildDiscoveryEstimate", () => {
  it("estimates bounded SerpApi requests and cost", async () => {
    const estimate = await buildDiscoveryEstimate(criteria, appConfig);
    expect(estimate.serpapiRequests).toBe(6);
    expect(estimate.estimatedCostUsd).toBeCloseTo(0.09);
    expect(estimate.withinBudget).toBe(true);
  });
});
