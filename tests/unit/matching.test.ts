// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  addressSimilarity,
  nameSimilarity,
  normalizeName,
  scoreMatch,
} from "../../src/server/services/matching.js";

describe("normalizeName", () => {
  it("lowercases, strips accents, and removes punctuation", () => {
    expect(normalizeName("Café  Déjà-Vu!")).toBe("cafe deja vu");
  });

  it("collapses whitespace", () => {
    expect(normalizeName("  A   B  ")).toBe("a b");
  });
});

describe("nameSimilarity", () => {
  it("scores near-identical names highly", () => {
    expect(nameSimilarity("Sultan's Dine", "Sultans Dine")).toBeGreaterThan(0.85);
  });

  it("scores unrelated names low", () => {
    expect(nameSimilarity("KFC", "Pizza Hut")).toBeLessThan(0.4);
  });

  it("ignores generic stop words", () => {
    expect(nameSimilarity("The Sultan's Dine", "Sultan's Dine")).toBe(1);
  });

  it("returns zero when either side has no tokens", () => {
    expect(nameSimilarity("", "Anything")).toBe(0);
    expect(nameSimilarity("!!!", "Anything")).toBe(0);
  });
});

describe("addressSimilarity", () => {
  it("returns zero when one address is missing", () => {
    expect(addressSimilarity(null, "Road 11")).toBe(0);
  });

  it("scores matching addresses", () => {
    expect(addressSimilarity("Road 11, Banani", "Road 11 Banani")).toBeGreaterThan(0.8);
  });
});

describe("scoreMatch", () => {
  const base = {
    nameA: "Sultan's Dine",
    nameB: "Sultans Dine",
    addressA: "Road 11, Banani, Dhaka",
    addressB: "Road 11, Banani, Dhaka",
    categoryA: "Restaurant",
    categoryB: "Restaurant",
    latA: 23.7808,
    lonA: 90.4162,
    latB: 23.7809,
    lonB: 90.4163,
    sourceA: "osm",
    sourceB: "serpapi",
  };

  it("marks a close, same-name, same-category pair eligible", () => {
    const result = scoreMatch(base);
    expect(result.eligible).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.8);
    expect(result.signals.categoryMatch).toBe(true);
    expect(result.signals.distanceMeters).toBeLessThan(120);
  });

  it("rejects pairs that are too far apart", () => {
    const result = scoreMatch({ ...base, latB: 23.9, lonB: 90.5 });
    expect(result.eligible).toBe(false);
    expect(result.signals.distanceMeters).toBeGreaterThan(10_000);
  });

  it("rejects pairs with dissimilar names", () => {
    const result = scoreMatch({ ...base, nameB: "Pizza Hut" });
    expect(result.eligible).toBe(false);
    expect(result.signals.nameSimilarity).toBeLessThan(0.45);
  });

  it("treats category matching as case-insensitive containment", () => {
    const result = scoreMatch({ ...base, categoryA: "Coffee Shop", categoryB: "coffee" });
    expect(result.signals.categoryMatch).toBe(true);
  });
});
