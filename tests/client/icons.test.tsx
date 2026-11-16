import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MapPinIcon,
  markerPinSvg,
  markerRankLabel,
  placeIconLabel,
  placeIconName,
} from "../../src/client/components/icons.js";

describe("placeIconName", () => {
  it("maps common provider categories onto a single icon family", () => {
    expect(placeIconName("Restaurant")).toBe("food");
    expect(placeIconName("Coffee shop")).toBe("food");
    expect(placeIconName("Hotel")).toBe("bed");
    expect(placeIconName("National Park")).toBe("tree");
    expect(placeIconName("Dental clinic")).toBe("health");
    expect(placeIconName("Public library")).toBe("book");
    expect(placeIconName("City hall")).toBe("bank");
    expect(placeIconName("Grocery store")).toBe("bag");
  });

  it("falls back to a plain dot for unknown, empty, or missing categories", () => {
    expect(placeIconName(null)).toBe("dot");
    expect(placeIconName(undefined)).toBe("dot");
    expect(placeIconName("")).toBe("dot");
    expect(placeIconName("Some unclassified thing")).toBe("dot");
  });
});

describe("placeIconLabel", () => {
  it("returns a human-readable label for every family", () => {
    expect(placeIconLabel("food")).toBe("Food and drink");
    expect(placeIconLabel("bed")).toBe("Lodging");
    expect(placeIconLabel("dot")).toBe("Place");
  });
});

describe("markerPinSvg", () => {
  it("draws a source-coloured teardrop with unique ids per marker", () => {
    const first = markerPinSvg("serpapi");
    const second = markerPinSvg("serpapi");
    // Unique defs ids keep a marker's gradient and shape from colliding with
    // another marker's when Leaflet adds and removes pins.
    expect(first).not.toBe(second);
    expect(first).toContain("<svg");
    expect(first).toContain("pd-pin__body");
    expect(first).toContain("linearGradient");
    expect(first).toContain('id="pd-pin-shape-');
    expect(first).toContain('fill="url(#pd-pin-grad-serpapi-');
  });
});

describe("markerRankLabel", () => {
  it("renders the shared result number and hides it when there is no rank", () => {
    expect(markerRankLabel(3)).toContain(">3<");
    expect(markerRankLabel(3)).toContain("pd-marker__rank");
    expect(markerRankLabel(null)).toBe("");
    expect(markerRankLabel(Number.NaN)).toBe("");
  });

  it("compacts three-digit ranks so the number fits in the pin head", () => {
    expect(markerRankLabel(120)).toContain("pd-marker__rank--compact");
  });
});

describe("MapPinIcon", () => {
  it("renders an aria-hidden outline pin so it never adds noise to the a11y tree", () => {
    const markup = renderToStaticMarkup(<MapPinIcon size={24} />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('width="24"');
    expect(markup).toContain("<svg");
  });
});