import { haversineMeters } from "../../shared/geo.js";
import { query } from "../db.js";

const STOP_WORDS = new Set([
  "the",
  "and",
  "ltd",
  "limited",
  "co",
  "company",
  "restaurant",
  "hotel",
  "shop",
  "store",
  "branch",
]);

export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalizeName(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function nameSimilarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let overlap = 0;
  for (const token of leftSet) if (rightSet.has(token)) overlap += 1;
  const dice = (2 * overlap) / (leftSet.size + rightSet.size);
  const compactA = left.join("");
  const compactB = right.join("");
  const maxLength = Math.max(compactA.length, compactB.length);
  let edits = 0;
  if (maxLength > 0) {
    const previous = Array.from({ length: compactB.length + 1 }, (_, index) => index);
    for (let i = 1; i <= compactA.length; i += 1) {
      let current = [i];
      for (let j = 1; j <= compactB.length; j += 1) {
        const insertion = (current[j - 1] ?? 0) + 1;
        const deletion = (previous[j] ?? 0) + 1;
        const substitution = (previous[j - 1] ?? 0) + (compactA[i - 1] === compactB[j - 1] ? 0 : 1);
        current = [...current, Math.min(insertion, deletion, substitution)];
      }
      edits = current[compactB.length] ?? edits;
      previous.splice(0, previous.length, ...current);
    }
  }
  const levenshtein = maxLength === 0 ? 1 : 1 - edits / maxLength;
  return Math.max(0, Math.min(1, dice * 0.6 + levenshtein * 0.4));
}

export function addressSimilarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  return nameSimilarity(a, b);
}

export interface MatchSignals {
  nameSimilarity: number;
  addressSimilarity: number;
  distanceMeters: number;
  categoryMatch: boolean;
  sourceA: string;
  sourceB: string;
}

export function scoreMatch(input: {
  nameA: string;
  nameB: string;
  addressA: string | null;
  addressB: string | null;
  categoryA: string | null;
  categoryB: string | null;
  latA: number;
  lonA: number;
  latB: number;
  lonB: number;
  sourceA: string;
  sourceB: string;
}): { score: number; signals: MatchSignals; eligible: boolean } {
  const name = nameSimilarity(input.nameA, input.nameB);
  const address = addressSimilarity(input.addressA, input.addressB);
  const distance = haversineMeters(
    { lat: input.latA, lon: input.lonA },
    { lat: input.latB, lon: input.lonB },
  );
  const normalizedA = normalizeName(input.categoryA ?? "");
  const normalizedB = normalizeName(input.categoryB ?? "");
  const categoryMatch =
    Boolean(normalizedA && normalizedB) &&
    (normalizedA === normalizedB ||
      normalizedA.includes(normalizedB) ||
      normalizedB.includes(normalizedA));
  const proximity = Math.max(0, 1 - distance / 150);
  const score =
    name * 0.55 +
    address * 0.2 +
    proximity * 0.15 +
    (categoryMatch ? 0.1 : 0);
  const eligible = distance <= 120 && name >= 0.45 && score >= 0.62;
  return {
    score: Number(score.toFixed(3)),
    signals: {
      nameSimilarity: Number(name.toFixed(3)),
      addressSimilarity: Number(address.toFixed(3)),
      distanceMeters: Number(distance.toFixed(1)),
      categoryMatch,
      sourceA: input.sourceA,
      sourceB: input.sourceB,
    },
    eligible,
  };
}

interface NearbyRecord {
  id: string;
  source: string;
  name: string;
  address: string | null;
  category: string | null;
  lat: number;
  lon: number;
}

export async function findAndRecordMatch(sourceRecordId: string): Promise<string | null> {
  const rows = await query<NearbyRecord & { id: string }>(
    `SELECT a.id, a.source, a.name, a.address, a.category, a.lat, a.lon
     FROM source_place_records a
     JOIN source_place_records b ON b.id = $1
     WHERE a.id <> b.id
       AND a.source IN ('osm', 'serpapi') AND b.source IN ('osm', 'serpapi')
        AND a.source <> b.source
       AND a.last_seen_at > now() - interval '180 days'
       AND a.lat BETWEEN b.lat - 0.002 AND b.lat + 0.002
       AND a.lon BETWEEN b.lon - 0.002 AND b.lon + 0.002
     LIMIT 20`,
    [sourceRecordId],
  );
  const current = (
    await query<NearbyRecord>(
      "SELECT id, source, name, address, category, lat, lon FROM source_place_records WHERE id = $1",
      [sourceRecordId],
    )
  ).rows[0];
  if (!current) return null;

  let best: { id: string; score: number; signals: MatchSignals } | null = null;
  for (const candidate of rows.rows) {
    const scored = scoreMatch({
      nameA: current.name,
      nameB: candidate.name,
      addressA: current.address,
      addressB: candidate.address,
      categoryA: current.category,
      categoryB: candidate.category,
      latA: current.lat,
      lonA: current.lon,
      latB: candidate.lat,
      lonB: candidate.lon,
      sourceA: current.source,
      sourceB: candidate.source,
    });
    if (!scored.eligible) continue;
    if (!best || scored.score > best.score) {
      best = { id: candidate.id, score: scored.score, signals: scored.signals };
    }
  }
  if (!best) return null;
  const [a, b] = [sourceRecordId, best.id].sort();
  await query(
    `INSERT INTO place_matches (a_source_record_id, b_source_record_id, score, signals)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (a_source_record_id, b_source_record_id)
     DO UPDATE SET score = EXCLUDED.score, signals = EXCLUDED.signals, updated_at = now()
     WHERE place_matches.state = 'candidate'`,
    [a, b, best.score, JSON.stringify(best.signals)],
  );
  await query(
    `UPDATE run_places SET possible_duplicate = true
     WHERE source_record_id IN ($1, $2)
       AND run_id IN (
         SELECT run_id FROM run_places WHERE source_record_id IN ($1, $2)
       )`,
    [sourceRecordId, best.id],
  );
  return best.id;
}
