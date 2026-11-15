// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildCsv,
  safeJson,
  sanitizeCsvCell,
  validateExportFields,
} from "../../src/server/services/export.js";
import {
  DEFAULT_EXPORT_FIELDS,
  EXPORT_FIELDS,
  isRestrictedExportKey,
  looksLikeImageReference,
  sanitizeExportValue,
} from "../../src/shared/export-fields.js";

describe("sanitizeCsvCell", () => {
  it("neutralises formula injection prefixes", () => {
    expect(sanitizeCsvCell("=1+1")).toBe("'=1+1");
    expect(sanitizeCsvCell("+8801700000000")).toBe("'+8801700000000");
    expect(sanitizeCsvCell("-5")).toBe("'-5");
    expect(sanitizeCsvCell("@user")).toBe("'@user");
    expect(sanitizeCsvCell("\tstart")).toBe("'\tstart");
    expect(sanitizeCsvCell("\rstart")).toBe("\"'\rstart\"");
  });

  it("quotes cells containing commas, quotes, or newlines", () => {
    expect(sanitizeCsvCell("Dhanmondi, Dhaka")).toBe('"Dhanmondi, Dhaka"');
    expect(sanitizeCsvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(sanitizeCsvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("removes NUL bytes and handles nullish values", () => {
    expect(sanitizeCsvCell("a\u0000b")).toBe("ab");
    expect(sanitizeCsvCell(null)).toBe("");
    expect(sanitizeCsvCell(undefined)).toBe("");
  });

  it("does not alter safe text", () => {
    expect(sanitizeCsvCell("Gulshan 2")).toBe("Gulshan 2");
  });
});

describe("buildCsv", () => {
  it("adds a BOM, a header row, and CRLF line endings", () => {
    const csv = buildCsv(["name", "address"], [
      { name: "A, B", address: "Dhaka" },
      { name: "=cmd", address: null },
    ]);
    expect(csv.startsWith("\uFEFFname,address\r\n")).toBe(true);
    expect(csv).toContain('"A, B",Dhaka');
    expect(csv).toContain("'=cmd,");
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});

describe("validateExportFields", () => {
  it("returns defaults when fields are omitted", () => {
    expect(validateExportFields(undefined)).toEqual([...DEFAULT_EXPORT_FIELDS]);
    expect(validateExportFields(null)).toEqual([...DEFAULT_EXPORT_FIELDS]);
  });

  it("deduplicates requested fields", () => {
    expect(validateExportFields(["name", "name", "lat"])).toEqual(["name", "lat"]);
  });

  it("allows every documented export field", () => {
    const all = EXPORT_FIELDS.map((field) => field.id);
    expect(validateExportFields(all)).toEqual(all);
  });

  it("rejects unknown fields", () => {
    expect(() => validateExportFields(["name", "secret_notes"])).toThrow(/Unknown export field/i);
  });

  it("allows the reviews export field", () => {
    expect(validateExportFields(["reviews"])).toEqual(["reviews"]);
  });

  it("rejects image-only fields", () => {
    expect(() => validateExportFields(["review_images"])).toThrow();
    expect(() => validateExportFields(["photo_url"])).toThrow();
  });

  it("rejects an empty field list", () => {
    expect(() => validateExportFields([])).toThrow(/at least one export field/i);
  });

  it("exposes the captured provider fields and keeps every restricted field out of the catalogue", () => {
    const ids = EXPORT_FIELDS.map((field) => field.id);
    for (const field of ["hours_last_updated", "popular_times", "location_summary", "at_this_place"]) {
      expect(ids).toContain(field);
    }
    for (const restricted of ["review_images", "photo_url", "photos", "images", "thumbnail", "thumbnails"]) {
      expect(ids).not.toContain(restricted);
    }
  });
});

describe("image policy", () => {
  it("recognizes restricted keys at any depth", () => {
    expect(isRestrictedExportKey("photo_url")).toBe(true);
    expect(isRestrictedExportKey("review_images")).toBe(true);
    expect(isRestrictedExportKey("PhotoUrl")).toBe(true);
    expect(isRestrictedExportKey("photos")).toBe(true);
    expect(isRestrictedExportKey("images")).toBe(true);
    expect(isRestrictedExportKey("thumbnail")).toBe(true);
    expect(isRestrictedExportKey("hours")).toBe(false);
    expect(isRestrictedExportKey("popular_times")).toBe(false);
  });

  it("detects image references without flagging ordinary facts", () => {
    expect(looksLikeImageReference("https://lh3.googleusercontent.com/p/abc=w200")).toBe(true);
    expect(looksLikeImageReference("data:image/png;base64,AAAA")).toBe(true);
    expect(looksLikeImageReference("https://example.com/logo.png")).toBe(true);
    expect(looksLikeImageReference("https://maps.google.com/?cid=123")).toBe(false);
    expect(looksLikeImageReference("https://example.com")).toBe(false);
    expect(looksLikeImageReference("6 AM–11 PM")).toBe(false);
    expect(looksLikeImageReference("Monday, 12:00 AM")).toBe(false);
    expect(looksLikeImageReference("Dine-in")).toBe(false);
  });

  it("strips restricted keys and image URLs from nested provider payloads", () => {
    const popularTimes = {
      live: "Typically not busy",
      graph_results: [
        { hour: 12, busyness_score: 70, thumbnail: "https://lh3.googleusercontent.com/p/x=w64" },
      ],
      photo_url: "https://lh3.googleusercontent.com/p/full",
    };
    const cleaned = sanitizeExportValue(popularTimes) as Record<string, unknown>;
    expect(cleaned).not.toHaveProperty("photo_url");
    const graph = cleaned.graph_results as Array<Record<string, unknown>>;
    expect(graph[0]).toMatchObject({ hour: 12, busyness_score: 70 });
    expect(graph[0]).not.toHaveProperty("thumbnail");
  });

  it("keeps plain facts but removes image-only entries from arrays", () => {
    const atThisPlace = [
      "Dine-in",
      "https://lh3.googleusercontent.com/img/a/AA/photo.jpg",
      { option: "Takeout", photo: "https://example.com/photo.jpg" },
      { option: "Delivery" },
    ];
    expect(sanitizeExportValue(atThisPlace)).toEqual([
      "Dine-in",
      { option: "Takeout" },
      { option: "Delivery" },
    ]);
  });

  it("keeps an ordinary listing link even when it mentions a photo", () => {
    expect(sanitizeExportValue(["See photo"])).toEqual(["See photo"]);
    expect(sanitizeExportValue(["https://maps.google.com/?cid=123"])).toEqual(["https://maps.google.com/?cid=123"]);
    expect(sanitizeExportValue({ price: "$12", open_state: "Open ⋅ Closes 11 PM" })).toEqual({
      price: "$12",
      open_state: "Open ⋅ Closes 11 PM",
    });
  });

  it("leaves primitive and non-plain values untouched", () => {
    expect(sanitizeExportValue(4.5)).toBe(4.5);
    expect(sanitizeExportValue(null)).toBeNull();
    const date = new Date("2026-01-01T00:00:00.000Z");
    expect(sanitizeExportValue(date)).toBe(date);
  });
});

describe("safeJson", () => {
  it("drops restricted keys and inline image values from unsanitized objects", () => {
    const text = safeJson({
      name: "Claremont Park",
      photo_url: "https://lh3.googleusercontent.com/p/full",
      reviews: [{ author: "Ann", thumbnail: "https://lh3.googleusercontent.com/p/x=w64" }],
    });
    expect(text).toContain("Claremont Park");
    expect(text).not.toContain("photo_url");
    expect(text).not.toContain("thumbnail");
    expect(text).not.toContain("googleusercontent");
  });
});
