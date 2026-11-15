import type { PoolClient } from "pg";
import type { AppConfig } from "../config.js";
import { query, transaction } from "../db.js";
import type { ParsedPlace } from "../sources/types.js";

export interface StoredSourceRecord {
  id: string;
  canonicalPlaceId: string;
}

function expiryExpression(source: string, storageDays: number): string {
  if (storageDays <= 0) return "NULL";
  if (source !== "serpapi") return "NULL";
  return `now() + interval '1 day' * ${Math.max(1, Math.floor(storageDays))}`;
}

export async function saveSourcePlace(place: ParsedPlace, appConfig: AppConfig): Promise<StoredSourceRecord> {
  return transaction(async (client: PoolClient) => {
    const storageDays = appConfig.serpapi.storageDays;
    const expiry = expiryExpression(place.source, storageDays);
    const inserted = await client.query<{
      id: string;
      canonical_place_id: string | null;
    }>(
      `INSERT INTO source_place_records
        (source, source_type, source_id, source_url, name, address, category, lat, lon,
         fields, field_provenance, details_status, details_fetched_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, ${expiry})
       ON CONFLICT (source, source_type, source_id) DO UPDATE SET
         source_url = COALESCE(EXCLUDED.source_url, source_place_records.source_url),
         name = EXCLUDED.name,
         address = COALESCE(EXCLUDED.address, source_place_records.address),
         category = COALESCE(EXCLUDED.category, source_place_records.category),
         lat = EXCLUDED.lat,
         lon = EXCLUDED.lon,
         fields = CASE
           WHEN source_place_records.source = 'osm' THEN EXCLUDED.fields
           ELSE source_place_records.fields || EXCLUDED.fields
         END,
         field_provenance = source_place_records.field_provenance || EXCLUDED.field_provenance,
         details_status = CASE
           WHEN source_place_records.details_status = 'fetched' THEN 'fetched'
           ELSE EXCLUDED.details_status
         END,
         last_seen_at = now(),
         last_fetched_at = now(),
         expires_at = COALESCE(EXCLUDED.expires_at, source_place_records.expires_at)
       RETURNING id, canonical_place_id`,
      [
        place.source,
        place.sourceType,
        place.sourceId,
        place.sourceUrl,
        place.name,
        place.address,
        place.category,
        place.lat,
        place.lon,
        JSON.stringify(place.fields),
        JSON.stringify(place.provenance),
        place.detailsStatus,
        place.detailsStatus === "fetched" ? new Date().toISOString() : null,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("Failed to persist source place");

    let canonicalPlaceId = row.canonical_place_id;
    if (!canonicalPlaceId) {
      const canonical = await client.query<{ id: string }>(
        "INSERT INTO canonical_places (name) VALUES ($1) RETURNING id",
        [place.name],
      );
      canonicalPlaceId = canonical.rows[0]?.id ?? null;
      if (canonicalPlaceId) {
        await client.query("UPDATE source_place_records SET canonical_place_id = $1 WHERE id = $2", [
          canonicalPlaceId,
          row.id,
        ]);
      }
    }
    if (!canonicalPlaceId) throw new Error("Failed to create canonical place");
    return { id: row.id, canonicalPlaceId };
  });
}

export async function addRunPlace(
  runId: string,
  sourceRecordId: string,
  distanceMeters: number | null,
  position: number,
): Promise<boolean> {
  const result = await query(
    `INSERT INTO run_places (run_id, source_record_id, distance_m, position)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (run_id, source_record_id) DO NOTHING
     RETURNING source_record_id`,
    [runId, sourceRecordId, distanceMeters, position],
  );
  return result.rowCount === 1;
}

export async function updateRunPlaceDistances(runId: string): Promise<void> {
  await query(
    `UPDATE run_places rp
     SET distance_m = 6371008.8 * 2 * asin(sqrt(
       power(sin(radians(s.lat - r.center_lat) / 2), 2) +
       cos(radians(r.center_lat)) * cos(radians(s.lat)) *
       power(sin(radians(s.lon - r.center_lon) / 2), 2)
     ))
     FROM source_place_records s, search_runs r
     WHERE rp.run_id = $1 AND r.id = $1 AND s.id = rp.source_record_id
       AND r.center_lat IS NOT NULL AND r.center_lon IS NOT NULL`,
    [runId],
  );
}

