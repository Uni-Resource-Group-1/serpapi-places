import type { AppConfig } from "../config.js";
import { one, query, transaction } from "../db.js";
import { AppError, SourceError, errorMessage } from "../errors.js";
import { getSerpApiDetails, getSerpApiReviews } from "../sources/serpapi.js";
import { resolveSerpApiKey } from "./serpapi-credentials.js";
import { audit } from "./audit.js";
import { reserveSerpApiCalls } from "./usage.js";

interface RecordRow {
  id: string;
  source: "osm" | "serpapi";
  name: string;
  address: string | null;
  category: string | null;
  lat: number;
  lon: number;
  fields: Record<string, unknown>;
  field_provenance: Record<string, { source: string; retrievedAt: string }>;
  details_status: string;
  details_fetched_at: Date | null;
}

function mergeFields(
  current: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  return { ...current, ...update };
}

export async function refreshPlaceDetails(
  sourceRecordId: string,
  actor: string,
  appConfig: AppConfig,
): Promise<{ fetched: boolean; credits: number; fields: Record<string, unknown> }> {
  const record = await one<RecordRow>("SELECT * FROM source_place_records WHERE id = $1 AND source IN ('osm', 'serpapi') AND (expires_at IS NULL OR expires_at > now())", [sourceRecordId]);
  if (!record) throw new AppError(404, "not_found", "Place not found");
  if (record.source === "osm") {
    return { fetched: true, credits: 0, fields: record.fields };
  }
  if (!(await resolveSerpApiKey(appConfig))) {
    throw new AppError(503, "serpapi_not_configured", "SerpApi is not configured on this server.");
  }
  const budget = await reserveSerpApiCalls(1, appConfig);
  if (!budget.allowed) {
    throw new AppError(
      429,
      "budget_limit",
      budget.reason === "monthly"
        ? "The monthly SerpApi budget is exhausted. Adjust limits in Settings or wait for the next UTC month."
        : "The daily SerpApi budget is exhausted. Try again tomorrow or adjust limits in Settings.",
    );
  }
  const history = await one<{ id: string }>(
    `INSERT INTO enrichment_history
      (source_record_id, kind, status, credits_estimated, requested_by)
     VALUES ($1, 'details', 'success', 1, $2)
     RETURNING id`,
    [sourceRecordId, actor],
  );
  const started = Date.now();
  try {
    const result = await getSerpApiDetails(record.fields, appConfig);
    const fields = mergeFields(record.fields, result.fields);
    const provenance = { ...record.field_provenance, ...result.provenance };
    await query(
      `UPDATE source_place_records SET
         fields = $2::jsonb,
         field_provenance = $3::jsonb,
         name = CASE WHEN $4 <> '' THEN $4 ELSE name END,
         address = COALESCE($5, address),
         category = COALESCE($6, category),
         lat = COALESCE($7, lat),
         lon = COALESCE($8, lon),
         details_status = 'fetched',
         details_fetched_at = now(),
         last_fetched_at = now()
       WHERE id = $1`,
      [
        sourceRecordId,
        JSON.stringify(fields),
        JSON.stringify(provenance),
        result.name,
        result.address,
        result.category,
        result.lat,
        result.lon,
      ],
    );
    if (history) {
      await query(
        `UPDATE enrichment_history SET status = 'success', fields_returned = $2,
           credits_actual = 1, finished_at = now()
         WHERE id = $1`,
        [history.id, Object.keys(result.fields).length],
      );
    }
    await audit({
      actor,
      action: "place.details_fetched",
      targetType: "source_place",
      targetId: sourceRecordId,
      metadata: { source: "serpapi", credits: 1, durationMs: Date.now() - started },
    });
    return { fetched: true, credits: 1, fields };
  } catch (error) {
    const message = error instanceof SourceError ? error.message : errorMessage(error);
    if (history) {
      await query(
        `UPDATE enrichment_history SET status = 'error', error_code = $2, error_message = $3,
           credits_actual = 1, finished_at = now()
         WHERE id = $1`,
        [history.id, error instanceof SourceError ? error.code : "details_error", message.slice(0, 600)],
      );
    }
    await query(
      `UPDATE source_place_records SET details_status = CASE
         WHEN details_status = 'fetched' THEN details_status ELSE 'failed' END
       WHERE id = $1`,
      [sourceRecordId],
    );
    await audit({
      actor,
      action: "place.details_failed",
      targetType: "source_place",
      targetId: sourceRecordId,
      metadata: { source: "serpapi", credits: 1 },
    });
    throw new AppError(502, "details_failed", message, { retryable: true });
  }
}

export interface StoredReviewPage {
  reviews: Array<{
    id: string;
    authorName: string | null;
    rating: number | null;
    dateText: string | null;
    snippet: string | null;
    likes: number | null;
    fetchedAt: string;
  }>;
  page: number;
  hasNext: boolean;
  nextPageToken: string | null;
  fetchedAt: string | null;
  reviewsEnabled: boolean;
}

export async function loadReviews(sourceRecordId: string): Promise<StoredReviewPage> {
  const rows = await query<{
    id: string;
    author_name: string | null;
    rating: string | null;
    date_text: string | null;
    snippet: string | null;
    likes: number | null;
    fetched_at: Date;
    page: number;
  }>(
    `SELECT id, author_name, rating, date_text, snippet, likes, fetched_at, page
     FROM place_reviews WHERE source_record_id = $1
       AND (expires_at IS NULL OR expires_at > now())
       AND EXISTS (SELECT 1 FROM source_place_records s WHERE s.id = $1
         AND (s.expires_at IS NULL OR s.expires_at > now()))
     ORDER BY page, fetched_at DESC, id`,
    [sourceRecordId],
  );
  const latest = rows.rows.reduce<Date | null>(
    (max, row) => (!max || row.fetched_at > max ? row.fetched_at : max),
    null,
  );
  return {
    reviews: rows.rows.map((row) => ({
      id: row.id,
      authorName: row.author_name,
      rating: row.rating === null ? null : Number(row.rating),
      dateText: row.date_text,
      snippet: row.snippet,
      likes: row.likes,
      fetchedAt: row.fetched_at.toISOString(),
    })),
    page: Math.max(1, ...rows.rows.map((row) => row.page)),
    hasNext: false,
    nextPageToken: null,
    fetchedAt: latest?.toISOString() ?? null,
    reviewsEnabled: true,
  };
}

export interface StoredExportReview {
  sourceRecordId: string;
  placeSourceId: string;
  placeName: string;
  authorName: string | null;
  rating: number | null;
  dateText: string | null;
  snippet: string | null;
  likes: number | null;
  fetchedAt: string;
  page: number;
}

/** Read already-stored reviews for export. This never calls SerpApi. */
export async function fetchStoredReviewsForRecords(sourceRecordIds: string[]): Promise<StoredExportReview[]> {
  if (sourceRecordIds.length === 0) return [];
  const rows = await query<{
    source_record_id: string;
    place_source_id: string;
    place_name: string;
    author_name: string | null;
    rating: string | null;
    date_text: string | null;
    snippet: string | null;
    likes: number | null;
    fetched_at: Date;
    page: number;
  }>(
    `SELECT r.source_record_id, s.source_id AS place_source_id, s.name AS place_name,
            r.author_name, r.rating, r.date_text, r.snippet, r.likes, r.fetched_at, r.page
     FROM place_reviews r
     JOIN source_place_records s ON s.id = r.source_record_id
     WHERE r.source_record_id = ANY($1::uuid[])
       AND (r.expires_at IS NULL OR r.expires_at > now())
     ORDER BY s.name, r.page, r.fetched_at DESC, r.id`,
    [sourceRecordIds],
  );
  return rows.rows.map((row) => ({
    sourceRecordId: row.source_record_id,
    placeSourceId: row.place_source_id,
    placeName: row.place_name,
    authorName: row.author_name,
    rating: row.rating === null ? null : Number(row.rating),
    dateText: row.date_text,
    snippet: row.snippet,
    likes: row.likes,
    fetchedAt: row.fetched_at.toISOString(),
    page: row.page,
  }));
}

export async function fetchReviews(
  sourceRecordId: string,
  page: number,
  nextPageToken: string | null,
  actor: string,
  appConfig: AppConfig,
): Promise<StoredReviewPage> {
  if (!appConfig.serpapi.reviewsEnabled) {
    throw new AppError(
      403,
      "reviews_disabled",
      "Reviews are disabled by the source policy on this server. The owner must approve review retention and display before enabling them.",
    );
  }
  const record = await one<RecordRow>("SELECT * FROM source_place_records WHERE id = $1 AND source IN ('osm', 'serpapi') AND (expires_at IS NULL OR expires_at > now())", [sourceRecordId]);
  if (!record) throw new AppError(404, "not_found", "Place not found");
  if (record.source !== "serpapi") {
    throw new AppError(400, "reviews_unavailable", "Reviews are only available for SerpApi records.");
  }
  if (!(await resolveSerpApiKey(appConfig))) {
    throw new AppError(503, "serpapi_not_configured", "SerpApi is not configured on this server.");
  }
  const budget = await reserveSerpApiCalls(1, appConfig);
  if (!budget.allowed) {
    throw new AppError(
      429,
      "budget_limit",
      budget.reason === "monthly"
        ? "The monthly SerpApi budget is exhausted. Adjust limits in Settings or wait for the next UTC month."
        : "The daily SerpApi budget is exhausted. Try again tomorrow or adjust limits in Settings.",
    );
  }
  const history = await one<{ id: string }>(
    `INSERT INTO enrichment_history
      (source_record_id, kind, page, status, credits_estimated, requested_by)
     VALUES ($1, 'reviews', $2, 'success', 1, $3)
     RETURNING id`,
    [sourceRecordId, page, actor],
  );
  const started = Date.now();
  try {
    const result = await getSerpApiReviews(record.fields, page, nextPageToken, appConfig);
    const expiresAt =
      appConfig.serpapi.reviewRetentionDays > 0
        ? new Date(Date.now() + appConfig.serpapi.reviewRetentionDays * 86_400_000)
        : null;
    await transaction(async (client) => {
      for (const review of result.reviews) {
        await client.query(
          `INSERT INTO place_reviews
             (source_record_id, page, review_key, author_name, rating, date_text, snippet, likes, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (source_record_id, review_key) DO UPDATE SET
             page = EXCLUDED.page,
             author_name = EXCLUDED.author_name,
             rating = EXCLUDED.rating,
             date_text = EXCLUDED.date_text,
             snippet = EXCLUDED.snippet,
             likes = EXCLUDED.likes,
             fetched_at = now(),
             expires_at = EXCLUDED.expires_at`,
          [
            sourceRecordId,
            page,
            review.reviewKey,
            review.authorName,
            review.rating,
            review.dateText,
            review.snippet,
            review.likes,
            expiresAt,
          ],
        );
      }
      if (history) {
        await client.query(
          `UPDATE enrichment_history SET status = 'success', fields_returned = $2,
             credits_actual = 1, finished_at = now()
           WHERE id = $1`,
          [history.id, result.reviews.length],
        );
      }
    });
    await audit({
      actor,
      action: "place.reviews_fetched",
      targetType: "source_place",
      targetId: sourceRecordId,
      metadata: { page, reviews: result.reviews.length, credits: 1, durationMs: Date.now() - started },
    });
    const stored = await loadReviews(sourceRecordId);
    return { ...stored, page, hasNext: result.hasNext, nextPageToken: result.nextPageToken };
  } catch (error) {
    const message = error instanceof SourceError ? error.message : errorMessage(error);
    if (history) {
      await query(
        `UPDATE enrichment_history SET status = 'error', error_code = $2, error_message = $3,
           credits_actual = 1, finished_at = now()
         WHERE id = $1`,
        [history.id, error instanceof SourceError ? error.code : "reviews_error", message.slice(0, 600)],
      );
    }
    await audit({
      actor,
      action: "place.reviews_failed",
      targetType: "source_place",
      targetId: sourceRecordId,
      metadata: { page, credits: 1 },
    });
    throw new AppError(502, "reviews_failed", message, { retryable: true });
  }
}
