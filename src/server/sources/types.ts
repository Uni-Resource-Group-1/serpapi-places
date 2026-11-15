import type { SearchCriteria, Source } from "../../shared/types.js";

export interface ParsedPlace {
  source: Source;
  sourceType: string;
  sourceId: string;
  sourceUrl: string | null;
  name: string;
  address: string | null;
  category: string | null;
  lat: number;
  lon: number;
  fields: Record<string, unknown>;
  provenance: Record<string, { source: Source; retrievedAt: string; note?: string }>;
  detailsStatus: "not_fetched" | "fetched" | "failed" | "not_available";
}

// Counts are mutually exclusive; returned = places.length + sum of rejection counts.
export interface ParseRejections {
  unusableCoordinates: number;
  missingName: number;
  missingIdentifier: number;
  other: number;
}

export interface SourceSearchPage {
  parseRejections?: ParseRejections;
  places: ParsedPlace[];
  returned: number;
  hasNext: boolean;
  pageFingerprint: string;
  sanitizedParams: Record<string, unknown>;
  nextPageToken?: string | null;
}

export interface OsmSearchResult {
  parseRejections?: ParseRejections;
  places: ParsedPlace[];
  returned: number;
  capped: boolean;
  sanitizedParams: Record<string, unknown>;
  osmTimestamp: string | null;
}

export interface SerpApiDetailsResult {
  fields: Record<string, unknown>;
  provenance: Record<string, { source: Source; retrievedAt: string; note?: string }>;
  name: string;
  address: string | null;
  category: string | null;
  lat: number | null;
  lon: number | null;
}

export interface ParsedReview {
  reviewKey: string;
  authorName: string | null;
  rating: number | null;
  dateText: string | null;
  snippet: string | null;
  likes: number | null;
}

export interface SerpApiReviewsResult {
  reviews: ParsedReview[];
  hasNext: boolean;
  nextPageToken: string | null;
  sanitizedParams: Record<string, unknown>;
}

export interface SearchAdapterContext {
  criteria: SearchCriteria;
  now: Date;
}
