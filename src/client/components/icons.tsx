export type PlaceIconName =
  | "pin"
  | "dot"
  | "food"
  | "bed"
  | "tree"
  | "health"
  | "book"
  | "bank"
  | "bag";

interface IconProps {
  className?: string;
  size?: number;
}

/** Shared stroke paths, described on a 24×24 grid. */
const ICON_PATHS: Record<PlaceIconName, string[]> = {
  pin: [
    "M12 21.2s7-6.4 7-11.2a7 7 0 1 0-14 0c0 4.8 7 11.2 7 11.2Z",
    "M12 13.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z",
  ],
  dot: ["M12 5.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z"],
  food: [
    "M7 3.5v6.2a2 2 0 0 0 2 2h.4V3.5",
    "M8.2 11.7V20.5",
    "M16.8 3.5c-1.4 2.1-2 4.1-2 6.1v3.2h4V9.6c0-2-.6-4-2-6.1Z",
    "M16.8 12.8v7.7",
  ],
  bed: [
    "M3.5 18.5v-6.3h17v6.3",
    "M3.5 12.2V6.4",
    "M3.5 18.5v1.8",
    "M20.5 18.5v1.8",
    "M7 12.2V9.4h4.8v2.8",
  ],
  tree: ["M12 3.5 5.3 13h3.9l-2 3.8h9.6l-2-3.8h3.9L12 3.5Z", "M12 16.8v3.7"],
  health: ["M12 4.2v15.6", "M4.2 12h15.6"],
  book: [
    "M5 4.2h8.6a3 3 0 0 1 3 3v12.6H8a3 3 0 0 1-3-3V4.2Z",
    "M16.6 4.2h2.4v15.6h-2.4",
  ],
  bank: [
    "M3.5 9.2h17L12 4 3.5 9.2Z",
    "M5.5 9.2v7.4",
    "M9.8 9.2v7.4",
    "M14.2 9.2v7.4",
    "M18.5 9.2v7.4",
    "M3.5 20h17",
  ],
  bag: ["M6.2 8.3h11.6l1 11.2H5.2l1-11.2Z", "M9 8.3V6.4a3 3 0 0 1 6 0v1.9"],
};

function Glyph({ name, className, size = 20, strokeWidth = 2 }: IconProps & { name: PlaceIconName; strokeWidth?: number }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}

/** Outline pin used for the brand, map empty state, and other place affordances. */
export function MapPinIcon({ className, size = 20 }: IconProps) {
  return <Glyph name="pin" className={className} size={size} />;
}

/**
 * Category families used by the map markers. Kept deliberately small so one
 * glyph covers a whole family of provider category strings.
 */
export function placeIconName(value: string | null | undefined): PlaceIconName {
  const text = (value ?? "").toLowerCase();
  if (/(hotel|motel|lodging|rv park|resort|guest|hostel|mobile home)/.test(text)) return "bed";
  if (/(restaurant|food|cafe|coffee|bakery|bar|meal|pizza|diner|bistro|tea|cuisine|eat)/.test(text)) return "food";
  if (/(park|garden|nature|trail|beach|forest|zoo|playground)/.test(text)) return "tree";
  if (/(hospital|clinic|pharmacy|doctor|dentist|medical|health)/.test(text)) return "health";
  if (/(school|university|college|library|education|museum)/.test(text)) return "book";
  if (/(bank|atm|finance|insurance|government|city hall|courthouse|police|post office)/.test(text)) return "bank";
  if (/(store|shop|market|mall|retail|supermarket|grocery|gas|fuel|pharmacy)/.test(text)) return "bag";
  return "dot";
}

/** Human-readable label used by marker titles and accessibility text. */
const ICON_LABELS: Record<PlaceIconName, string> = {
  pin: "Place",
  dot: "Place",
  food: "Food and drink",
  bed: "Lodging",
  tree: "Outdoors",
  health: "Health",
  book: "Education and culture",
  bank: "Services",
  bag: "Shop",
};

export function placeIconLabel(name: PlaceIconName): string {
  return ICON_LABELS[name];
}

/** Monotonic id so each marker's SVG defs stay unique; duplicate SVG ids are invalid. */
let markerSeq = 0;

/**
 * Map marker body, drawn as a single SVG string for Leaflet div icons.
 *
 * The shape is a Google-Maps-style teardrop: a solid source-coloured pin with a
 * soft point where it meets the ground. The pin head carries the result number
 * in white, because the number is the one thing a marker must share with its
 * list row. The category stays in the tooltip and accessibility label instead of
 * crowding the pin, which keeps a dense map readable.
 */
export function markerPinSvg(sourceVariant: string): string {
  const id = (markerSeq += 1);
  const gradientId = `pd-pin-grad-${sourceVariant}-${id}`;
  const shapeId = `pd-pin-shape-${id}`;
  return [
    `<svg viewBox="0 0 26 38" aria-hidden="true" focusable="false">`,
    `<defs>`,
    `<linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">`,
    `<stop class="pd-pin__stop-a" offset="0" />`,
    `<stop class="pd-pin__stop-b" offset="1" />`,
    `</linearGradient>`,
    `<path id="${shapeId}" d="M13 37.4C13 37.4 24 24.6 24 13.9C24 7.3 19.1 2 13 2C6.9 2 2 7.3 2 13.9C2 24.6 13 37.4 13 37.4Z" />`,
    `</defs>`,
    `<use class="pd-pin__body" href="#${shapeId}" fill="url(#${gradientId})" />`,
    `</svg>`,
  ].join("");
}

/**
 * The number shown inside a marker head. Kept as its own element so the map can
 * emphasise it on hover/selection without rebuilding the pin.
 */
export function markerRankLabel(rank: number | null): string {
  if (rank === null || !Number.isFinite(rank)) return "";
  const compact = rank >= 100 ? " pd-marker__rank--compact" : "";
  return `<span class="pd-marker__rank${compact}" aria-hidden="true">${rank}</span>`;
}