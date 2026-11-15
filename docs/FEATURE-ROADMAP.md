# Places Discovery: feature roadmap

Planning input: independent repo reviews by Claude Opus 5.5 and GPT-6.1 Sol (November 2026). This is a proposed sequence, not a commitment to incur SerpApi charges or deploy external services.

## Baseline and guardrails

- Preserve separate OSM/SerpApi attribution, the server-side SerpApi key, bounded requests and review pagination, export policy, retention, and explicit approximate-vs-polygon boundary wording.
- Add browser-level tests for geography selection and map motion, keyboard combobox interaction, mobile map controls, review pagination and XLSX export. Current Vitest coverage does not exercise Leaflet in a real browser.
- Fix search-quality edge cases before enabling automation: escape OSM keyword regex metacharacters, handle missing geography centers honestly, avoid cross-country locale defaults after selecting a point, and review the dependency advisories.
- The directory has no git history. Obtain approval before initializing a repository or creating a baseline commit; isolate hot files by owner if agents edit in parallel.

## Priorities

| Priority | Feature | Scope and acceptance gate |
| --- | --- | --- |
| 1 | Shared map/list filters | One filter state for cards, map markers, counts and Fit. Search text, sources, saved/duplicate state and viewport filters operate on loaded results with visible counts and Reset. Do not suggest that a filtered or missing provider result means the place does not exist. |
| 2 | Precise location entry | Keyboard-editable latitude/longitude and rectangle, paste full map URLs, move map separately from changing search center, and a clear longitude/antimeridian policy. Country/locale resolution for clicked points must not assume Bangladesh. No paid geocoder by default. |
| 3 | Better search quality | Show per-run request/cost estimate and depth before a paid search; improve OSM regex safety, multilingual names and category precision. Explain why each result matched and label provider-ranked matches honestly. |
| 4 | Rich filters and ranking | Rating, review count, price, cuisine/type, website, accessibility and weighted sort. Missing provider data remains visible by default and is counted separately; OSM ratings are usually unknown. Persist versioned filters and enforce export policy on filtered exports. |
| 5 | Collections and comparisons | Bulk-save with retention-aware status, display collections on the map, compare 2–4 places with provenance, and compare runs using historical snapshots. Not returned ≠ closed. |
| 6 | Saved-search monitoring | In-app notifications for new/changed/not-returned results, with source-success gates, baseline resets after criteria changes, pause/resume, auto-refresh budget share, and no persistent SerpApi review content. External webhooks require separate policy approval. |

Dependencies: (1) before (4), (5), (6); (2) before country-aware search quality; (3)–(5) before alerts. Precise location entry and search-quality server changes can proceed in independent lanes, but App.tsx and MapView.tsx need a single integration owner.

## Decisions before implementation

1. Should an OSM-only saved search be allowed to refresh automatically, and how often?
2. What fraction of the daily SerpApi budget may automation use? Default proposal: at most 50%.
3. May hashed SerpApi identifiers persist beyond the configured provider retention period for deduplicating alerts? Verify policy before storing any such value.
4. Are outbound webhooks allowed? Default: disabled, with counts only if later approved.
5. Should filters apply only to loaded places or should all pages be fetched before results appear? Show loaded/total counts in either case.

Each phase requires unit/component coverage plus mocked-provider Playwright smoke tests; paid live searches require explicit operator confirmation and a stated request cap.
