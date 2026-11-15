import type { ImportedPlaceRef } from "../../shared/types.js";

export interface RejectedImportInput {
  input: string;
  reason: string;
}

export interface ParsedPlaceInput {
  refs: ImportedPlaceRef[];
  rejected: RejectedImportInput[];
}

const GOOGLE_HOST = /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/;

function isAllowedGoogleHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "goo.gl" || host === "maps.app.goo.gl" || GOOGLE_HOST.test(host);
}

function normalizeUrl(raw: string): URL | null {
  let value = raw.trim();
  if (!value) return null;
  if (/^(maps\.app\.goo\.gl|goo\.gl|(www\.|maps\.)?google\.[a-z.]+)\//i.test(value)) {
    value = `https://${value}`;
  }
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!isAllowedGoogleHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function dataIdFromText(text: string): string | null {
  const match = text.match(/(?:!1s|ftid=)(0x[0-9a-f]+:0x[0-9a-f]+)/i);
  return match?.[1] ?? null;
}

function placeIdFromText(text: string): string | null {
  const match = text.match(/place_id[=:]([A-Za-z0-9_-]{10,300})/i);
  return match?.[1] ?? null;
}

function refsFromUrl(url: URL): ImportedPlaceRef[] {
  const refs: ImportedPlaceRef[] = [];
  const params = ["place_id", "data_id", "data_cid", "cid", "ftid", "query", "q"];
  for (const key of params) {
    const value = url.searchParams.get(key);
    if (!value) continue;
    if (key === "place_id") refs.push({ kind: "place_id", value });
    else if (key === "data_id") refs.push({ kind: "data_id", value });
    else if (key === "cid" || key === "data_cid") {
      if (/^\d{5,25}$/.test(value)) refs.push({ kind: "data_cid", value });
    } else if (key === "ftid") {
      if (/^0x[0-9a-f]+:0x[0-9a-f]+$/i.test(value)) refs.push({ kind: "data_id", value });
    } else {
      const embeddedPlace = placeIdFromText(value);
      if (embeddedPlace) refs.push({ kind: "place_id", value: embeddedPlace });
      const embeddedData = dataIdFromText(value);
      if (embeddedData) refs.push({ kind: "data_id", value: embeddedData });
    }
  }
  const haystack = `${url.pathname}${url.search}${url.hash}`;
  const embeddedPlace = placeIdFromText(haystack);
  if (embeddedPlace) refs.push({ kind: "place_id", value: embeddedPlace });
  const embeddedData = dataIdFromText(haystack);
  if (embeddedData) refs.push({ kind: "data_id", value: embeddedData });
  return refs;
}

function refFromBareToken(token: string): ImportedPlaceRef | null {
  if (token.startsWith("place_id:")) {
    const value = token.slice("place_id:".length);
    return /^[A-Za-z0-9_-]{4,300}$/.test(value) ? { kind: "place_id", value } : null;
  }
  if (token.startsWith("data_id:")) {
    const value = token.slice("data_id:".length);
    return /^0x[0-9a-f]+:0x[0-9a-f]+$/i.test(value) ? { kind: "data_id", value } : null;
  }
  if (token.startsWith("data_cid:")) {
    const value = token.slice("data_cid:".length);
    return /^\d{5,25}$/.test(value) ? { kind: "data_cid", value } : null;
  }
  if (/^0x[0-9a-f]+:0x[0-9a-f]+$/i.test(token)) return { kind: "data_id", value: token };
  if (/^\d{6,25}$/.test(token)) return { kind: "data_cid", value: token };
  if (/^[A-Za-z0-9_-]{20,300}$/.test(token)) return { kind: "place_id", value: token };
  return null;
}

function valueFor(ref: ImportedPlaceRef): string {
  return ref.kind === "place_id" ? ref.value : ref.value;
}

function dedupe(refs: ImportedPlaceRef[]): ImportedPlaceRef[] {
  const seen = new Set<string>();
  const result: ImportedPlaceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${valueFor(ref)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ kind: ref.kind, value: ref.value });
  }
  return result;
}

const SHORT_LINK_HOSTS = new Set(["goo.gl", "maps.app.goo.gl"]);

async function resolveShortLink(url: URL): Promise<{ finalUrl: URL; body: string } | null> {
  let current = url;
  for (let hop = 0; hop < 4; hop += 1) {
    if (!isAllowedGoogleHost(current.hostname)) return null;
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "PlacesDiscovery/1.0" },
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return null;
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return null;
      }
      if (!isAllowedGoogleHost(next.hostname)) return null;
      current = next;
      continue;
    }
    const body = await response.text().then((text) => text.slice(0, 200_000)).catch(() => "");
    return { finalUrl: current, body };
  }
  return null;
}

function splitInput(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

/**
 * Parse pasted Google Maps links and identifiers. Only Google hosts are ever
 * fetched, redirects are followed manually, and every hop is allow-listed.
 */
export async function parsePlaceInput(text: string, maxRefs: number): Promise<ParsedPlaceInput> {
  const refs: ImportedPlaceRef[] = [];
  const rejected: RejectedImportInput[] = [];
  for (const token of splitInput(text)) {
    const url = normalizeUrl(token);
    if (url) {
      let extracted = refsFromUrl(url);
      if (extracted.length === 0 && SHORT_LINK_HOSTS.has(url.hostname.toLowerCase())) {
        const resolved = await resolveShortLink(url);
        if (resolved) {
          extracted = [
            ...refsFromUrl(resolved.finalUrl),
            ...(dataIdFromText(resolved.body) ? [{ kind: "data_id" as const, value: dataIdFromText(resolved.body)! }] : []),
            ...(placeIdFromText(resolved.body) ? [{ kind: "place_id" as const, value: placeIdFromText(resolved.body)! }] : []),
          ];
        }
      }
      if (extracted.length === 0) {
        rejected.push({
          input: token.slice(0, 300),
          reason: "This Google link does not expose a place ID. Open it and paste the full Maps URL or the place ID.",
        });
        continue;
      }
      refs.push(...extracted);
      continue;
    }
    const bare = refFromBareToken(token);
    if (bare) refs.push(bare);
    else {
      rejected.push({
        input: token.slice(0, 300),
        reason: "Unrecognized reference. Paste a Google Maps URL, a place_id, a data_id, or a numeric CID.",
      });
    }
  }
  const unique = dedupe(refs);
  if (unique.length > maxRefs) {
    rejected.push({
      input: `${unique.length} references`,
      reason: `At most ${maxRefs} places can be imported in one run. Extra references were ignored.`,
    });
  }
  return { refs: unique.slice(0, maxRefs), rejected };
}
