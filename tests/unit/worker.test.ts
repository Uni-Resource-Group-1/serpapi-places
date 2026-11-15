// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { validateCriteria } from "../../src/server/validation.js";

const config = loadConfig({ APP_ACCESS_KEY: "test-access-key-not-for-production-0001", NODE_ENV: "test" });
const criteria = {
  keyword: "coffee", category: "restaurant", sources: ["google_places"], mode: "radius",
  center: { lat: 40.7, lon: -74 }, radiusMeters: 1000, bounds: null,
  country: "United States", countryCode: "US", region: "New York", city: "New York", area: "Manhattan",

};

describe("retired Google Places source", () => {
  it("rejects saved-search criteria containing the retired source before queueing", () => {
    expect(() => validateCriteria(criteria, config)).toThrow();
  });
});
