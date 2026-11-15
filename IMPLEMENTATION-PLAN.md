# Places Discovery — Product Rebuild and Delivery Plan

**Status:** Historical implementation plan; the official Google Places source has since been retired by product decision.  
**Repository mode:** Direct edits in place. This workspace has no Git metadata; no branches, commits, or rollback history are available.

> **Retirement note:** The official Google Places API source was removed from the product. Active sources are now OpenStreetMap and SerpApi Google Maps (including Google Maps URL/place-ID imports resolved through SerpApi). The Google Places material retained below is historical record of the original design and the reasons for retirement; it no longer describes shipped behavior.
>
> **Policy update (2026-11-10):** The owner pays SerpApi for the data and no longer uses the official Google Places API. SerpApi place records and stored reviews are now retained without automatic expiry and are exportable for this workspace's own use, including `reviews.csv`/`reviews.json` when the reviews export field is selected. Review images and photo URLs remain non-exportable. This is an owner product decision, not a legal determination; do not republish or resell third-party content without the necessary rights.

## Product goal (original; retained for historical context)

Provide a polished place-discovery workspace where users can browse country → region/state → county/district → city, search place categories or keywords within a selected administrative or drawn area, and search around a selected place. Results from Google Places and other providers remain distinguishable, with honest coverage, cost, and source explanations. SerpApi remains an optional discovery source and can supplement Google Place ID records with details/reviews. Saving and downloads should be dependable and policy-aware.

**Current source scope:** OSM and SerpApi Google Maps only. Official Google Places discovery/enrichment/export is retired. New source selections are rejected; existing historical database records and accounting data are preserved.

## Confirmed product choices

- Store and export SerpApi place records and stored reviews for this workspace's own use, as confirmed on 2026-11-10. This is the owner's product choice, **not a legal or provider-policy determination**. Keep attribution, retention controls, and privacy-aware handling visible; do not claim that downstream publication or resale is authorized.
- Keep SerpApi as both an optional discovery provider and a Place-ID supplement (the initial option was retained after explicit confirmation).
- Support both area/category searches and searches around a selected place.
- Treat this deployment as a **shared workspace**: signed-in users can access shared runs/library/export jobs unless existing behavior demonstrates otherwise; make this explicit in UX and verify authorization consistently. Do not impose per-user isolation without changing this product decision.
- User selected **aggregate daily/monthly Google Places budgets**, enforced atomically across concurrent runs. Because Google unit cost is currently unverified, these are request-count ceilings—not dollar-spend guarantees.
- When exact current provider cost is not verified/configured, display **cost unavailable**, never `$0`, and require explicit confirmation of the maximum request cap before dispatching paid calls. Reservations count potentially billed requests; release only when dispatch is proven not to have begun.
- Keep GeoNames as the global geography picker unless investigation establishes a safe additive source. A selectable geography is not a promise that a provider can enumerate every place there.
- No promise of “all places”: providers return ranked, capped, variable coverage. Never silently fan out across tiles, categories, pages, enrichment, or retries that may cost money.
- Keep API credentials server-side. Preserve OSM/provider provenance and honest boundary precision.

## Current repository evidence

- GeoNames data and APIs support the hierarchy; OSM Overpass resolves administrative polygons where available.
- Sources include OSM, Google Places API (New), and SerpApi Google Maps search/details/reviews.
- Search modes include radius, boundary, map rectangle, tiled, and import; map and geography controls exist.
- Search-runner persists source summaries/caveats; saved places/collections and asynchronous export jobs exist.
- Google Places currently has per-run controls, but Google cost depends on requested fields/SKU. Current rating fields can materially change cost; the configured per-request price defaults to zero, and no field-mask→SKU/versioned-price evidence was found. A zero-derived dollar estimate is not a reliable cost estimate.
- Google Text Search is ranked/capped, max 60 results over pages; Nearby Search has its own request/type/radius limitations. Current adapter needs endpoint-vs-area semantics review (notably radius restrictions).
- A0 audit found SerpApi's default `gl` fallback is fixed to Bangladesh when no country is specified (`src/server/config.ts`, `src/server/sources/serpapi.ts`); test country-aware locale behavior before claiming globally relevant localization.
- A0 audit found authenticated library/export routes do not appear scoped by session owner, and provider data is copied into saved snapshots until cleanup. Product must decide shared-workspace access vs per-session privacy and define provider-field vs user-authored note lifecycles before changing those behaviors.
- `npm run check` passed during the read-only A0 audit (126 passed, 3 skipped); no DB integration, E2E, migrations, or paid live provider calls were run.
- Latest observed worker failure was PostgreSQL `42725` caused by untyped parameter multiplication in final run SQL. It is fixed with explicit integer total persistence and a regression assertion. A fresh retry completed for Mont Belvieu: 12 places, 3 OSM and 9 SerpApi, SerpApi capped at 6 pages. Treat that only as a smoke-test fact, not a coverage promise.
- The app has not yet passed a real-browser full-flow QA in this session. The working tree has no Git metadata.

## Open risk requiring a hard fail-closed gate

Owner chose to keep Google content persistable/exportable, but current information does not establish an authoritative basis for Google-derived Place IDs to be enriched by SerpApi, stored, displayed on Leaflet, retained, combined with other-provider data, or redistributed. Treat each operation and field separately: Place ID lookup, SerpApi details, SerpApi reviews, persistence, UI display, retention/deletion, and export. Until an authoritative owner-provided contractual/policy basis is reviewed, unresolved operations must remain disabled/default-deny in server behavior (not merely hidden in the UI), and production release remains blocked. Work may proceed on policy-independent UX, OSM discovery, geography, tests, and fail-closed controls; do not enable risky data paths as an implementation shortcut.

## Architecture / dependency sequence

```text
A0. Read-only baseline and provider/terms/cost evidence inventory
   ↓
A1. Owner/legal decision gate for provider operations (unresolved stays default-deny)
   ├── B. Geography/boundary implementation (policy-independent portions may proceed)
   ├── C. Category/query-planner/provider adapter implementation (only approved operations enabled)
   └── D. Save/export lifecycle and fail-closed policy implementation
         ↓
E. Unified run contracts, per-provider budgets and observability
         ↓
F. Search-flow integration and UI polish
         ↓
G. Browser + disposable-DB + release verification
```

B/C/D audits and policy-independent implementation may run in parallel after A0. Any Google or SerpApi cross-provider persistence/display/review/export path is gated by A1; absent approval, code must enforce disabled/default-deny behavior server-side. Integrate hot shared files (`search-runner.ts`, shared types, `App.tsx`, `SearchPanel.tsx`) through one owner and explicit conflict control.

## Work packages and gates

### A — Baseline and product/provider contract
- Run and record `npm run check`; inspect README, feature roadmap, configuration, migrations, test setup, user flows, exports, provider terms/docs.
- Map each source's discovery, details, reviews, field masks, billing unit, caps, pagination, retry behavior, storage, attribution, retention, and export permission.
- Set observable requirements for “all places” copy (must instead say returned/sampled/capped), user approvals for any paid fan-out, policy-controlled persistence/download, and failures/retries.
- Do not issue paid live provider requests.
- **Exit:** evidence baseline and risk ledger recorded in this plan or a canonical product doc; no unsupported completeness/policy claims.

### B — Global geography and scope semantics
- Audit selection data coverage, attribution, missing hierarchy levels/centers, and names differing from OSM; state explicitly that global picker coverage does not imply uniform source availability or provider coverage.
- Define boundary resolution/matching precision, geometry validation, antimeridian behavior, and safe map-area fallback. Exercise named representative cases: US (full hierarchy), Bangladesh (district naming/admin hierarchy), Japan (different administrative naming), a country with missing intermediate levels, non-Latin/alternate-name lookup, unavailable OSM polygon, missing center, and antimeridian-crossing user bounds.
- Ensure selecting geography focuses the map; map pans/zooms/clicks never silently mutate selected admin level or boundary intent. A missing or ambiguous polygon must be visible as bbox/map-area precision, not silently represented as the exact administrative area.
- Add nearby-selected-place scope using a selected result's valid coordinates and an explicit radius/cost cap; selection should not cause a provider request.
- **Exit:** hierarchy and nearby-area behavior have named unit/component/browser fixtures; assertions cover visible fallback precision and intended provider scope; no false guarantee that GeoNames/OSM boundaries equal provider coverage.

### C — Category, discovery, and Place-ID supplement contracts
- Add/verify first-class categories for parks, gardens, playgrounds, shops and useful shop subtypes; separate UI taxonomy from OSM tags, Google place-type/query mappings, and SerpApi query phrases.
- Fix provider endpoint semantics: Text Search rectangle restriction vs Nearby Search circular restriction; type filters and unsupported categories must be surfaced, not silently broadened.
- Define the explicit supplemental flow: Google Places result → validated Google Place ID → separately confirmed SerpApi details/reviews action. Do not treat the Google record as a SerpApi discovery record. Record field-level provider provenance, retrieval time, identity linkage, conflict precedence, and separate request/cost/expiry state. Keep unsupported/missing Place IDs ineligible and safely explain why.
- Cross-provider lookup, storage, display, retention and export are each separately default-deny until A1 policy approval. Tests must demonstrate no hidden/indirect path bypasses these server-side gates.
- Keep source result sets/provenance independently inspectable; dedupe only with explicit identity rules and retain source attribution.
- Per-source pagination is bounded, no hidden retries or automatic category/tile fan-out. Any user-approved multi-query plan shows maximum calls and estimated cost first.
- **Exit:** fixtures cover each provider mapping, invalid/unsupported mapping, Place ID linkage, field provenance/conflicts, duplicate IDs, missing IDs, unknown paid outcomes, and denied policy-gate paths; cost math tests include field-mask SKU configuration.

### D — Save, collection, and download lifecycle
- Exercise duplicate/concurrent saves, collection membership, notes, provider-record expiry, and failed/retried requests; define what is durable app-authored data vs provider content.
- Server-enforce source export policy and field allowlists for every format. Place and stored review data are exportable for this workspace's own use; keep images and photo URLs out of exports. Guard CSV/XLSX formula injection, file/path traversal, and expired/missing exports.
- Define lifecycle separately for provider snapshots versus user-authored notes and collection membership when provider records expire; do not silently erase user-authored content or keep restricted provider fields beyond their approved lifetime.
- Verify authentication and the approved shared-workspace authorization model consistently for reading/saving places, collection changes, export jobs, and artifact downloads. Because the owner chose a shared workspace, cross-session access is expected only if the shared-workspace contract explicitly covers that resource; test allowed and denied actions accordingly. Export creation/retry must be idempotent, artifacts expire and clean up, and retries must not redispatch discovery.
- Ensure job states and download UX clearly communicate queued/running/failed/expired and provide a safe recovery path.
- Keep retention controls explicit (`SERPAPI_STORAGE_DAYS`, `SERPAPI_REVIEW_RETENTION_DAYS`; zero means no automatic expiry) and retain the attribution/no-redistribution notice.
- **Exit:** unit + disposable-DB tests exercise save/export lifecycle, cross-session denial, idempotency, artifact expiry/cleanup, and omission/policy invariants.

### E — Run contract, budgets and observability
- For each provider and endpoint, define separate hard per-run and daily/monthly request/spend caps, atomic concurrent reservations where enforceable, and a versioned pricing assumption with source URL and checked-at date. Persist the applied pricing/mask version on each run for auditability.
- Google estimates must map the exact request field mask and endpoint to the highest applicable SKU, configured price, and page/request maximum. If current price or SKU cannot be established, disclose that dollar cost is unavailable (never `$0`) and require explicit user confirmation of the maximum request cap before dispatch; never label an uncertain estimate as a maximum cost.
- SerpApi request caps and Google request/SKU caps are independent. Enrichment and review calls have their own explicit action caps and confirmation. Unknown paid outcomes are conservatively accounted and never automatically retried.
- Preserve informative user-visible provider errors; log root causes without secrets or sensitive payloads. Generic worker failure state should link to safe structured error codes.
- **Exit:** mocked boundary/cap tests prove zero dispatch beyond each provider's confirmed limit; per-endpoint SKU and pricing fixtures; concurrency reservations; 42725 regression; unknown-outcome safety checks.

### F — End-to-end experience and polish
- Deliver the flow: geography/scope → category/keyword → providers/cost estimate → explicit confirmation where needed → live status → source-separated results/map/details → save → download.
- Improve empty/loading/error/partial/capped states and explain exactly why returned results are partial.
- Review typography, spacing, responsive layout, keyboard/focus behavior, semantic labels, map/list selection, and reduced motion. Preserve app's visual direction if one exists; avoid introducing unrelated product scope.
- **Exit:** key journeys work at desktop and mobile widths, keyboard-accessible interactions, and no contradictory coverage/source/cost language.

### G — Verification/release readiness
- Add mocked-provider Playwright flows for geography, category, nearby-place search, paid confirmation, partial results, save, and download; stub map tiles/providers deterministically.
- Run `npm run check`. Run DB integration suite only against a declared disposable database; do not run migrations against live/prod data.
- Review secrets/config hygiene, provider policy gates, attribution, export fields, and operation docs. Real paid smoke tests require a separate explicit cap/authorization.
- **Exit:** all required tests pass, a11y/manual review is recorded, and unresolved Google data-policy questions remain visible as release blockers.

## Acceptance criteria

- **AC-001 Geography:** Selecting country→region→county→city retains the hierarchy, map focus follows explicit selection, missing levels/geometry are labeled, and map manipulation alone does not change the selected area. Verify US full hierarchy, Bangladesh district hierarchy, Japan administrative naming, a missing-level country, alternate/non-Latin names, missing centers, unavailable geometry and antimeridian bounds using named fixtures + browser test. The picker is global; source coverage varies.
- **AC-002 Search scope:** User can search category/keyword inside chosen admin or drawn area and around an explicitly selected place with a displayed radius. Verify validation + browser flow.
- **AC-003 Categories/providers:** Parks, gardens, playgrounds, shops/subtypes map through provider-specific logic; source-specific results remain labeled and attributable. Verify adapter fixtures and UI.
- **AC-004 No completeness claims:** Results state provider, area precision, caps, failures and that search is not exhaustive. Verify serialization/UI states for capped/partial runs.
- **AC-005 Cost control:** For each provider/endpoint, user sees the exact max request/page count, Google field-mask→SKU mapping and versioned price assumption, or an explicit “cost unavailable” disclosure (not `$0`) plus a required maximum-request-cap confirmation before paid dispatch; separate hard request/spend caps prevent dispatch beyond approval under concurrent runs. Google request-count limits are explicitly not dollar-spend caps while pricing is unknown. Verify mocked endpoint/SKU pricing fixtures, unknown-price behavior, cap boundary/concurrency tests, and dispatch logs; no live charges in automated suite.
- **AC-006 Data/security:** API secrets remain server-side; logs and errors redact credentials. Verify source scan/config contract and adversarial tests.
- **AC-007 Save/download:** Authenticated saves/collections remain consistent through duplicate submissions and provider expiry; user-authored notes/collections follow a defined lifecycle; export jobs/downloads are owner-checked, idempotent, expiring/recoverable and policy-gated, and include SerpApi place data plus stored reviews when requested, without images/photo URLs. Verify unit + disposable DB + browser download/expiry test.
- **AC-008 Resilience:** Provider errors, worker exceptions, boundary ambiguity and unknown paid request outcome surface actionable states without accidental duplicate paid calls. Verify mocked failure tests and operational log inspection.
- **AC-009 UX/accessibility:** Core search/save/download interactions work with keyboard and screen reader semantics at desktop/mobile widths, with useful loading/empty/error status. Verify browser QA + manual review.
- **AC-010 Export policy:** SerpApi place and stored review records are exportable for this workspace's own use while `SERPAPI_EXPORT_ENABLED=true`; images/photo URLs remain excluded; attribution and no-redistribution notices are present. Verify the gate, manifest policy text, and review file generation.

## Rollback / change control

No Git repository or commit history is available, so normal code rollback cannot be guaranteed. Before schema or broad refactors: create a separate verified backup/snapshot of any persistent DB, apply forward-only migrations, test from a disposable DB, and maintain a file-level patch/backup outside the working tree. Do not run destructive migration or paid-provider tests without explicit approval. Work in small, verifiable slices and preserve current behavior where no approved criterion requires changing it.
