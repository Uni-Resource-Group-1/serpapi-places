import type { CoverageStatus, SearchRunStatus, Source } from "../shared/types.js";

export function formatDistance(meters: number | null | undefined): string {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) return "—";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "never";
  const diff = Date.now() - date.getTime();
  const minute = 60_000;
  if (diff < minute) return "just now";
  if (diff < 60 * minute) return `${Math.round(diff / minute)} min ago`;
  if (diff < 24 * 60 * minute) return `${Math.round(diff / (60 * minute))} h ago`;
  if (diff < 30 * 24 * 60 * minute) return `${Math.round(diff / (24 * 60 * minute))} d ago`;
  return formatDateTime(value);
}

export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Cost unavailable";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(
    value,
  );
}

export function sourceLabel(source: Source): string {
  if (source === "osm") return "OpenStreetMap";
  return "SerpApi";
}

export function runStatusLabel(status: SearchRunStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Searching";
    case "completed":
      return "Completed";
    case "partial":
      return "Partial results";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

export function coverageLabel(coverage: CoverageStatus | null): string {
  switch (coverage) {
    case "within_limits":
      return "Within request limits (not exhaustive)";
    case "capped":
      return "Limited or sampled coverage";
    case "partial":
      return "Partial / source error";
    case "failed":
      return "Failed";
    default:
      return "Pending";
  }
}

export function statusTone(status: SearchRunStatus): "ok" | "warn" | "error" | "busy" {
  if (status === "completed") return "ok";
  if (status === "partial" || status === "cancelled") return "warn";
  if (status === "failed") return "error";
  return "busy";
}

export function percent(used: number, limit: number): number {
  if (limit <= 0) return 100;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

export function truncate(value: string, max = 160): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
