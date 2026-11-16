# Places Discovery

Self-hosted places research workspace combining **OpenStreetMap (Overpass)** with **SerpApi Google Maps**. Built for small trusted teams that need honest provenance, explicit paid-request budgets, and exportable research data.

> **Coverage honesty:** OSM and SerpApi results are always displayed as separate layers and labelled by source. SerpApi Google Maps results are a sample of what that provider returned for the query — **not a complete inventory** of places in an area. Absence from a result set is not proof that a place does not exist.

## What it does

- Global geography cascade: country → region/state → county/district → city, backed by the bundled GeoNames dataset (no external geocoder).
- Three search scopes: radius in **kilometres** around a draggable map center (or any selected result via “Search around this place”), the selected region/county/city boundary when mapped in OSM, or the current map rectangle.
- When a matching OSM administrative relation exists, boundary searches use its real polygon for OSM. SerpApi has no polygon search, so it samples around the boundary center and filters to the boundary's bounding box — the run caveat states this explicitly.
- Separate OSM and SerpApi pin/cluster shapes with keyboard-focusable, numbered markers, card/marker sync, source filters, sorting, and fit-to-loaded-results. Each marker is a category pin (food, lodging, outdoors, health, education/culture, services, shopping, or a plain pin) carrying a small numbered badge on its shoulder; the number matches the list row, marker tooltip, and aria-label. Outside-area records stay in the run but are hidden from both the list and the map until you opt in with the shared “Show outside” toggle; source and text filters still operate on loaded results independently of map layers.
- Real distance and bounding-box filtering after each source responds, with filtered-out and duplicate counts reported per source.
- SerpApi pagination caps, daily/monthly budget reservations, duplicate-page detection, and partial-failure reporting.
- On-demand SerpApi place details using `place_id` (never automatically per marker).
- Explicit opt-in tiled SerpApi discovery with a bounded estimate/confirmation step; each cell is a separately queued run.
- Google Maps URL/place-ID imports resolved through SerpApi, plus OpenStreetMap discovery.
- Source-reported review totals are shown separately from stored review counts. Reviews are opt-in per view, budget-counted and temporarily retained; “Load available pages” follows pagination for at most 5 requests per click (20 pages maximum). It cannot promise all source reviews. Review text/authors are never exported.
- Persistent PostgreSQL storage, migration runner, saved searches with optional auto-refresh, saved places, collections, and conservative cross-source duplicate review with undo. Saved places can be removed per item, in bulk from a selection, or in full from the Saved places tab (all, or just the current filter). By default a removal only drops the saved snapshot, so the source record and its run results stay; an explicit “delete the source record” opt-in removes the place from results too. A collection can be emptied without deleting its saved places, and results cards and the details panel can unsave directly.
- Export jobs producing a ZIP with the data file (`csv`, `xlsx`, `geojson`, or `json`), `manifest.json`, and `ATTRIBUTION.txt`. CSV and Excel cells are protected against formula execution and GeoJSON coordinates are validated. Run migrations before using XLSX on existing installations.
- Single shared access key with named sessions, HTTP-only cookies, CSRF tokens, and a five-session cap.
- Server-side credentials: the SerpApi key is never sent to the browser.

## Architecture

| Component | Responsibility |
| --- | --- |
| `src/client` | React 19 + Vite 7 + Leaflet UI |
| `src/server/routes` | Fastify 5 JSON API, including `/api/geo/*` geography lookups |
| `src/server/services/search-runner.ts` | Source orchestration, caps, filtering, matching |
| `src/server/sources` | Overpass and SerpApi adapters |
| `src/server/geo` | GeoNames dataset loader and Overpass boundary resolution |
| `src/server/worker.ts` | Queued runs, auto-refresh, export jobs, stale-run recovery |
| `migrations/001_init.sql` | Full PostgreSQL 16 schema |
| `src/shared` | Types, categories, geo math, export allowlist |

Plain PostgreSQL `numeric`/`double precision` latitude and longitude with Haversine filtering are used instead of PostGIS. The dataset is small, the search radius is bounded, and this avoids an extra database extension in the deployment.

## Global geography data

Geography is bundled at build time from [GeoNames](https://www.geonames.org/) public data:

| File | Contents |
| --- | --- |
| `src/server/geo/data/countries.json` | 252 countries |
| `src/server/geo/data/regions.json` | 3,865 admin-1 regions/states |
| `src/server/geo/data/counties.json` | 47,760 admin-2 counties/districts |
| `src/server/geo/data/cities.json` | 171,800 cities and towns (population ≥ 1,000) |

The JSON is committed so the app runs without network access. Regenerate it with `npm run geo:build` (downloads into `.cache/geonames`); `npm run build` copies it into `dist/server/geo/data`.

GeoNames data is licensed **CC BY 4.0**. Attribution is shown in the geography UI, returned by the geography API, and documented here. Boundary polygons are resolved at search time from OpenStreetMap via Overpass and cached in memory.

Authenticated lookup endpoints:

| Endpoint | Returns |
| --- | --- |
| `GET /api/geo/countries` | `{ code, name }[]` |
| `GET /api/geo/regions?country=BD` | Regions/states for a country |
| `GET /api/geo/counties?region=BD.81` | Counties/districts for a region |
| `GET /api/geo/cities?county=BD.81.3026` (or `?region=BD.81`) | Cities for a county or region |

## Local development

Requirements: Node.js ≥ 22.12 and PostgreSQL ≥ 16.

```bash
cp .env.example .env
# Fill APP_ACCESS_KEY, POSTGRES_PASSWORD, and DATABASE_URL (or use Docker Compose).

npm ci
npm run dev        # API :3001, worker, and Vite :5173
```

Migrations run automatically when the API starts. For a built deployment:

```bash
npm run build
npm run migrate
npm start          # API
npm run worker     # separate process
```

Test and quality gates:

```bash
npm run check      # typecheck + lint + unit tests + production build
npm run test:db    # requires RUN_DB_TESTS=1 and TEST_DATABASE_URL
```

## Configuration

All credentials and policy flags live in the server environment. The SerpApi key can also be saved from **Settings**, encrypted at rest with `SETTINGS_ENCRYPTION_KEY`; the environment value remains the fallback. See [`.env.example`](.env.example) for the complete list.

Key defaults:

| Setting | Default | Notes |
| --- | --- | --- |
| SerpApi monthly limit | 250 | Editable in the Settings UI within hard caps |
| SerpApi daily limit | 50 | Counters reset at UTC day boundary |
| SerpApi pages per run | 6 | Hard cap 10 |
| Results per source per run | 120 | Hard cap 500 |
| Radius cap | 20 km | Server-enforced |
| Map-area cap | 400 km² | Server-enforced |
| SerpApi reviews | enabled | Stored reviews are downloadable; 0 retention days = no automatic expiry |
| SerpApi exports | enabled | `SERPAPI_EXPORT_ENABLED=true` for this workspace's own use |
| Page cache TTL | 0 s | Every run is a fresh paid request unless raised deliberately |

The API rejects values above the hard caps even if they are submitted directly. The Settings UI exposes the same limits so the owner can choose a budget rather than relying on an assumed one.

## Deployment behind Traefik

The stack is designed to sit behind an existing Traefik instance without changing it. For a Hostinger VPS walkthrough (DNS, `.env`, TLS, verification), see [`docs/DEPLOY-HOSTINGER.md`](docs/DEPLOY-HOSTINGER.md).

1. Copy `.env.example` to `.env`, set `APP_ACCESS_KEY`, `POSTGRES_PASSWORD`, `SERPAPI_API_KEY` (or leave it empty and enter the key in Settings after first sign-in), `SETTINGS_ENCRYPTION_KEY`, `APP_ORIGIN`, `APP_HOST`, and the Traefik values.
2. Confirm the external Traefik network name (`TRAEFIK_NETWORK`, default `traefik`) and cert resolver (`TRAEFIK_CERT_RESOLVER`, default `letsencrypt`).
3. Build and start only this project's services:

   ```bash
   docker compose build
   docker compose up -d
   ```

4. Verify `https://serpapiplaces.dhakafareast.tech/health/ready` returns `{"status":"ready"}`.

Names are project-scoped (`serp-places-api`, `serp-places-worker`, `serp-places-db`, `serp_places_*` volumes, `serp-places` routers/services) to avoid disturbing other applications. Only the API joins the Traefik network; PostgreSQL and the worker stay on the internal network.

**Deployment target:** `https://serpapiplaces.dhakafareast.tech` on Hostinger VPS behind Traefik. Keep the SerpApi budget and data-policy flags reviewed before enabling live traffic.

## Backups and restore

Back up the database and the export-data volume together:

```bash
docker compose exec -T db pg_dump -U places -Fc places_discovery > backups/places-$(date +%F).dump
docker run --rm -v serp_places_data:/data -v "$PWD/backups:/backup" alpine \
  tar czf /backup/serp-places-data-$(date +%F).tar.gz -C /data .
```

Restore into a fresh database:

```bash
docker compose stop api worker
docker compose exec -T db dropdb -U places --if-exists places_discovery
docker compose exec -T db createdb -U places places_discovery
cat backups/places-YYYY-MM-DD.dump | docker compose exec -T db pg_restore -U places -d places_discovery --clean --if-exists
docker run --rm -v serp_places_data:/data -v "$PWD/backups:/backup" alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/serp-places-data-YYYY-MM-DD.tar.gz -C /data'
docker compose start api worker
```

Repository files such as `migrations/` are part of the image and do not need a separate data backup. The SerpApi key is in `.env`; back it up through your secrets process, never in the database dump.

## Rollback

1. Keep the previous image tag before deploying: `docker tag serp-places:latest serp-places:previous`.
2. To roll back: `docker compose stop api worker`, retag the previous image as `serp-places:latest`, then `docker compose up -d api worker`.
3. Schema changes are forward-only. If a rollback crosses a migration, restore the database backup taken before the deploy instead of editing migration history.
4. Confirm `/health/ready` and a read-only search before re-enabling saved-search auto-refresh.

## Data policy and rights

Google Maps URL/place-ID imports use SerpApi details and are subject to the existing paid-request budget. Opt-in tiled SerpApi plans sample each bounded rectangle cell. No provider keys are sent to the browser. The retired Google Places API source is not available for new searches.

This workspace now stores and exports SerpApi place data and stored reviews for its own use. The policy changed because the operator pays SerpApi for the data and no longer uses the official Google Places API. What the code can do is not a legal determination:

- SerpApi records and stored reviews have no automatic expiry by default (`SERPAPI_STORAGE_DAYS=0`, `SERPAPI_REVIEW_RETENTION_DAYS=0`). Set a positive day count to expire them.
- SerpApi place rows are included in CSV, XLSX, GeoJSON, and JSON exports.
- When the `reviews` export field is selected, the archive adds `reviews.csv` or `reviews.json` with the stored author name, rating, date, review text, likes, and fetch time.
- Review images and photo URLs remain non-exportable.
- Exports retain attribution and record the data-policy note in `manifest.json`.

SerpApi's terms cover the lawful collection of public search data and include a U.S. Legal Shield for qualifying plans, but they do not transfer rights to republish or resell third-party content. Review text and reviewer names may carry their authors' rights and privacy interests. Treat exports as internal research data; confirm the necessary rights before publishing, reselling, or redistributing them.

## Known limitations

- Database integration tests are guarded by `RUN_DB_TESTS=1` and `TEST_DATABASE_URL` and were not run against the local development database. Do not point them at a database with data you need to keep.
- The local SerpApi key returned a successful Google Maps search during development. Overpass returned a Dhaka District relation for boundary lookup; a complete live boundary run through both sources has not yet been confirmed.
- Geography is bundled from GeoNames; there is no external geocoder. OSM names/administrative levels differ globally from GeoNames: an unmatched region/county/city falls back to an approximate radius (or supplied bounding box), with a run caveat. SerpApi samples a map view rather than covering every point within a large boundary.
- Production deployment targets a Hostinger VPS behind Traefik at `serpapiplaces.dhakafareast.tech`; see `docs/DEPLOY-HOSTINGER.md`.

## License and attribution

OpenStreetMap data is © OpenStreetMap contributors and available under the ODbL. Basemap attribution must remain visible. SerpApi results must retain their attribution and source label in every view and export. Place-name and coordinate data is derived from [GeoNames](https://www.geonames.org/), licensed CC BY 4.0.
