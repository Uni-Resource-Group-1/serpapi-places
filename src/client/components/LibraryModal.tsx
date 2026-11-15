import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type {
  Collection,
  DuplicateCandidate,
  SavedPlace,
  SavedSearch,
  SearchCriteria,
  Source,
} from "../../shared/types.js";
import { api, ApiError } from "../api.js";
import { formatDateTime, formatDistance, formatRelative, sourceLabel } from "../format.js";
import { Modal } from "./Modal.js";
import { Badge, EmptyState, Spinner } from "./Feedback.js";

type LibraryTab = "places" | "collections" | "searches" | "duplicates";

const TABS: Array<{ id: LibraryTab; label: string }> = [
  { id: "places", label: "Saved places" },
  { id: "collections", label: "Collections" },
  { id: "searches", label: "Saved searches" },
  { id: "duplicates", label: "Duplicate review" },
];

const REFRESH_OPTIONS = [
  { value: 0, label: "Manual" },
  { value: 15, label: "15 min" },
  { value: 60, label: "1 hour" },
  { value: 360, label: "6 hours" },
  { value: 1440, label: "1 day" },
];

interface LibraryModalProps {
  initialTab?: LibraryTab;
  onClose: () => void;
  onNotify: (kind: "info" | "success" | "error", message: string) => void;
  onDataChanged: () => void;
  onLoadSearch: (criteria: SearchCriteria) => void;
  onRunQueued: (runId: string) => void;
  onExportCollection: (collectionId: string) => void;
  onExportPlaces: (savedPlaceIds: string[]) => void;
}

function criteriaSummary(criteria: SearchCriteria): string {
  return [
    criteria.keyword || criteria.category,
    criteria.area || criteria.city,
    criteria.mode === "radius" ? `${Math.round(criteria.radiusMeters)} m` : "map area",
    criteria.sources.map((source) => source === "osm" ? "OSM" : "SerpApi").join(" + "),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function LibraryModal({
  initialTab = "places",
  onClose,
  onNotify,
  onDataChanged,
  onLoadSearch,
  onRunQueued,
  onExportCollection,
  onExportPlaces,
}: LibraryModalProps) {
  const [tab, setTab] = useState<LibraryTab>(initialTab);
  const [places, setPlaces] = useState<SavedPlace[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [searches, setSearches] = useState<SavedSearch[]>([]);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);
  const [duplicateState, setDuplicateState] = useState("candidate");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});
  const [textFilter, setTextFilter] = useState("");
  const [newCollectionName, setNewCollectionName] = useState("");
  const [newCollectionDescription, setNewCollectionDescription] = useState("");
  const [bulkCollection, setBulkCollection] = useState("");
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [confirmItem, setConfirmItem] = useState<string | null>(null);
  const [confirmCollection, setConfirmCollection] = useState<string | null>(null);
  const [confirmSearch, setConfirmSearch] = useState<string | null>(null);
  const [editingCollection, setEditingCollection] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [saved, searchResult] = await Promise.all([api.savedPlaces(), api.savedSearches()]);
      setPlaces(saved.places);
      setCollections(saved.collections);
      setSearches(searchResult.searches);
      const dupes = await api.duplicates(duplicateState);
      setDuplicates(dupes.duplicates);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not load the library.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab !== "duplicates") return;
    let cancelled = false;
    api
      .duplicates(duplicateState)
      .then((result) => {
        if (!cancelled) setDuplicates(result.duplicates);
      })
      .catch((caught) => {
        if (!cancelled) onNotify("error", caught instanceof ApiError ? caught.message : "Could not load duplicates.");
      });
    return () => {
      cancelled = true;
    };
  }, [duplicateState, tab, onNotify]);

  const filteredPlaces = useMemo(() => {
    const needle = textFilter.trim().toLowerCase();
    if (!needle) return places;
    return places.filter((item) =>
      `${item.place.name} ${item.note ?? ""} ${item.place.address ?? ""}`.toLowerCase().includes(needle),
    );
  }, [places, textFilter]);

  const collectionsByPlace = useMemo(() => {
    const map = new Map<string, Collection[]>();
    for (const collection of collections) {
      for (const saved of places) {
        if (saved.collections.some((entry) => entry.id === collection.id)) {
          const list = map.get(saved.id) ?? [];
          list.push(collection);
          map.set(saved.id, list);
        }
      }
    }
    return map;
  }, [collections, places]);

  const act = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    try {
      await action();
      onDataChanged();
    } catch (caught) {
      onNotify("error", caught instanceof ApiError ? caught.message : "The action failed.");
    } finally {
      setBusy(null);
    }
  };

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const saveNote = (saved: SavedPlace) =>
    act(`note:${saved.id}`, async () => {
      const note = noteDraft[saved.id] ?? saved.note ?? "";
      await api.updateSavedPlaceNote(saved.id, note.trim() ? note.trim() : null);
      setPlaces((current) =>
        current.map((item) => (item.id === saved.id ? { ...item, note: note.trim() ? note.trim() : null } : item)),
      );
      onNotify("success", "Note saved.");
    });

  const removeSaved = (saved: SavedPlace) =>
    act(`delete:${saved.id}`, async () => {
      await api.deleteSavedPlace(saved.id);
      setPlaces((current) => current.filter((item) => item.id !== saved.id));
      setSelected((current) => {
        const next = new Set(current);
        next.delete(saved.id);
        return next;
      });
      setConfirmItem(null);
      onNotify("info", "Saved place removed.");
    });

  const bulkDelete = () =>
    act("bulk-delete", async () => {
      const ids = [...selected];
      if (ids.length === 0) return;
      const result = await api.bulkDeleteSavedPlaces(ids);
      setPlaces((current) => current.filter((item) => !selected.has(item.id)));
      setSelected(new Set());
      setConfirmBulk(false);
      onNotify("info", `${result.deleted} saved place${result.deleted === 1 ? "" : "s"} removed.`);
    });

  const bulkAddToCollection = () =>
    act("bulk-add", async () => {
      if (!bulkCollection || selected.size === 0) return;
      const result = await api.addCollectionItems(bulkCollection, [...selected]);
      setPlaces((current) =>
        current.map((item) => {
          if (!selected.has(item.id)) return item;
          const collection = collections.find((entry) => entry.id === bulkCollection);
          if (!collection || item.collections.some((entry) => entry.id === collection.id)) return item;
          return { ...item, collections: [...item.collections, { id: collection.id, name: collection.name }] };
        }),
      );
      onNotify("success", `${result.added} place${result.added === 1 ? "" : "s"} added to the collection.`);
      setBulkCollection("");
      setSelected(new Set());
    });

  const removeFromCollection = (savedPlaceId: string, collectionId: string) =>
    act(`remove:${savedPlaceId}:${collectionId}`, async () => {
      await api.removeCollectionItem(collectionId, savedPlaceId);
      setPlaces((current) =>
        current.map((item) =>
          item.id === savedPlaceId
            ? { ...item, collections: item.collections.filter((entry) => entry.id !== collectionId) }
            : item,
        ),
      );
      setCollections((current) =>
        current.map((entry) =>
          entry.id === collectionId ? { ...entry, itemCount: Math.max(0, entry.itemCount - 1) } : entry,
        ),
      );
    });

  const createCollection = () =>
    act("create-collection", async () => {
      if (!newCollectionName.trim()) return;
      const created = await api.createCollection(
        newCollectionName.trim(),
        newCollectionDescription.trim() || null,
      );
      setCollections((current) => [created, ...current]);
      setNewCollectionName("");
      setNewCollectionDescription("");
      onNotify("success", "Collection created.");
    });

  const renameCollection = (collection: Collection) =>
    act(`rename:${collection.id}`, async () => {
      if (!editingName.trim()) return;
      await api.updateCollection(collection.id, { name: editingName.trim() });
      setCollections((current) =>
        current.map((entry) => (entry.id === collection.id ? { ...entry, name: editingName.trim() } : entry)),
      );
      setEditingCollection(null);
      onNotify("success", "Collection renamed.");
    });

  const deleteCollection = (collection: Collection) =>
    act(`delete-collection:${collection.id}`, async () => {
      await api.deleteCollection(collection.id);
      setCollections((current) => current.filter((entry) => entry.id !== collection.id));
      setPlaces((current) =>
        current.map((item) => ({
          ...item,
          collections: item.collections.filter((entry) => entry.id !== collection.id),
        })),
      );
      setConfirmCollection(null);
      onNotify("info", "Collection deleted. Saved places were kept.");
    });

  const updateSearchRefresh = (search: SavedSearch, value: number) =>
    act(`refresh:${search.id}`, async () => {
      const updated = await api.updateSavedSearch(search.id, { refreshIntervalMinutes: value });
      setSearches((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      onNotify("success", "Refresh interval updated.");
    });

  const runSearch = (search: SavedSearch) =>
    act(`run:${search.id}`, async () => {
      const result = await api.runSavedSearch(search.id);
      onNotify("info", "Saved search queued.");
      onRunQueued(result.runId);
      onClose();
    });

  const deleteSearch = (search: SavedSearch) =>
    act(`delete-search:${search.id}`, async () => {
      await api.deleteSavedSearch(search.id);
      setSearches((current) => current.filter((item) => item.id !== search.id));
      setConfirmSearch(null);
      onNotify("info", "Saved search deleted.");
    });

  const decide = (candidate: DuplicateCandidate, decision: "approved" | "rejected" | "candidate") =>
    act(`decision:${candidate.id}`, async () => {
      await api.decideDuplicate(candidate.id, decision);
      setDuplicates((current) =>
        duplicateState === "candidate" && decision !== "candidate"
          ? current.filter((item) => item.id !== candidate.id)
          : current.map((item) => (item.id === candidate.id ? { ...item, state: decision } : item)),
      );
      onNotify(
        "success",
        decision === "approved"
          ? "Match approved. Source records stay separate; the link is recorded for review."
          : decision === "rejected"
            ? "Match rejected. This decision can be undone by resetting the candidate."
            : "Match reset to candidate for another review.",
      );
    });

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = TABS.findIndex((entry) => entry.id === tab);
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = TABS[(index + direction + TABS.length) % TABS.length];
    if (next) setTab(next.id);
  };

  const allVisibleSelected = filteredPlaces.length > 0 && filteredPlaces.every((item) => selected.has(item.id));

  return (
    <Modal
      title="Saved library"
      subtitle="Saved places use snapshots, collections group them, and duplicate decisions stay reversible."
      onClose={onClose}
      size="large"
    >
      <div className="tabs" role="tablist" aria-label="Library sections" onKeyDown={onTabKeyDown}>
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`panel-${entry.id}`}
            tabIndex={tab === entry.id ? 0 : -1}
            className={`tab${tab === entry.id ? " tab--active" : ""}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
            {entry.id === "places" ? <span className="tab__count">{places.length}</span> : null}
            {entry.id === "searches" ? <span className="tab__count">{searches.length}</span> : null}
            {entry.id === "duplicates" ? <span className="tab__count">{duplicates.length}</span> : null}
          </button>
        ))}
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <div className="modal-loading" role="status">
          <Spinner label="Loading library" /> Loading saved work…
        </div>
      ) : null}

      {!loading && tab === "places" ? (
        <div role="tabpanel" id="panel-places" aria-labelledby="tab-places">
          {places.length === 0 ? (
            <EmptyState title="No saved places yet">
              <p>Save places from search results or from the details panel. Notes and collections are optional.</p>
            </EmptyState>
          ) : (
            <>
              <div className="library-toolbar">
                <label className="field field--inline">
                  <span>Filter</span>
                  <input
                    type="search"
                    value={textFilter}
                    placeholder="Name or note"
                    onChange={(event) => setTextFilter(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  onClick={() => {
                    if (allVisibleSelected) setSelected(new Set());
                    else setSelected(new Set(filteredPlaces.map((item) => item.id)));
                  }}
                >
                  {allVisibleSelected ? "Clear selection" : "Select all visible"}
                </button>
              </div>

              {selected.size > 0 ? (
                <div className="bulk-bar" role="region" aria-label="Bulk actions">
                  <strong>{selected.size} selected</strong>
                  <button
                    type="button"
                    className="button button--primary button--small"
                    onClick={() => onExportPlaces([...selected])}
                    disabled={busy !== null}
                  >
                    Export selected
                  </button>
                  {collections.length > 0 ? (
                    <>
                      <select value={bulkCollection} onChange={(event) => setBulkCollection(event.target.value)}>
                        <option value="">Add to collection…</option>
                        {collections.map((collection) => (
                          <option key={collection.id} value={collection.id}>
                            {collection.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="button button--secondary button--small"
                        onClick={bulkAddToCollection}
                        disabled={!bulkCollection || busy !== null}
                      >
                        Add
                      </button>
                    </>
                  ) : null}
                  {confirmBulk ? (
                    <>
                      <button
                        type="button"
                        className="button button--danger button--small"
                        onClick={bulkDelete}
                        disabled={busy !== null}
                      >
                        Confirm delete ({selected.size})
                      </button>
                      <button type="button" className="button button--ghost button--small" onClick={() => setConfirmBulk(false)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button type="button" className="button button--ghost button--small" onClick={() => setConfirmBulk(true)}>
                      Remove selected
                    </button>
                  )}
                </div>
              ) : null}

              <ul className="saved-list">
                {filteredPlaces.map((saved) => (
                  <li key={saved.id} className="saved-item">
                    <div className="saved-item__head">
                      <input
                        type="checkbox"
                        checked={selected.has(saved.id)}
                        onChange={() => toggleSelected(saved.id)}
                        aria-label={`Select ${saved.place.name}`}
                      />
                      <Badge tone={saved.place.source}>{saved.place.source === "osm" ? "OSM" : "SerpApi"}</Badge>
                      <div className="saved-item__title">
                        <strong>{saved.place.name}</strong>
                        <span>
                          {saved.place.category ?? "Uncategorised"} · {formatDistance(saved.place.distanceMeters)} ·
                          saved {formatDateTime(saved.createdAt)}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="icon-button icon-button--small"
                        onClick={() => onExportPlaces([saved.id])}
                        aria-label={`Export ${saved.place.name}`}
                        title="Export this place"
                      >
                        ⭳
                      </button>
                      <button
                        type="button"
                        className="icon-button icon-button--small"
                        onClick={() =>
                          confirmItem === saved.id ? removeSaved(saved) : setConfirmItem(saved.id)
                        }
                        aria-label={
                          confirmItem === saved.id ? `Confirm removal of ${saved.place.name}` : `Remove ${saved.place.name}`
                        }
                        title={confirmItem === saved.id ? "Press again to confirm" : "Remove saved place"}
                      >
                        {confirmItem === saved.id ? "!" : "✕"}
                      </button>
                    </div>
                    <p className="saved-item__address">{saved.place.address ?? "No address from source"}</p>
                    <div className="saved-item__note">
                      <label className="field">
                        <span>Note</span>
                        <textarea
                          rows={2}
                          maxLength={2000}
                          value={noteDraft[saved.id] ?? saved.note ?? ""}
                          onChange={(event) =>
                            setNoteDraft((current) => ({ ...current, [saved.id]: event.target.value }))
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="button button--secondary button--small"
                        onClick={() => saveNote(saved)}
                        disabled={busy !== null}
                      >
                        Save note
                      </button>
                    </div>
                    <div className="saved-item__collections">
                      {(collectionsByPlace.get(saved.id) ?? []).map((collection) => (
                        <span key={collection.id} className="tag">
                          {collection.name}
                          <button
                            type="button"
                            onClick={() => removeFromCollection(saved.id, collection.id)}
                            aria-label={`Remove from ${collection.name}`}
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
              {filteredPlaces.length === 0 ? <p className="empty-inline">No saved places match this filter.</p> : null}
            </>
          )}
        </div>
      ) : null}

      {!loading && tab === "collections" ? (
        <div role="tabpanel" id="panel-collections" aria-labelledby="tab-collections">
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              void createCollection();
            }}
          >
            <div className="field">
              <label htmlFor="collection-name">New collection</label>
              <input
                id="collection-name"
                value={newCollectionName}
                maxLength={120}
                placeholder="e.g. Lunch candidates"
                onChange={(event) => setNewCollectionName(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="collection-description">Description (optional)</label>
              <input
                id="collection-description"
                value={newCollectionDescription}
                maxLength={1000}
                onChange={(event) => setNewCollectionDescription(event.target.value)}
              />
            </div>
            <button type="submit" className="button button--primary button--small" disabled={!newCollectionName.trim() || busy !== null}>
              Create collection
            </button>
          </form>

          {collections.length === 0 ? (
            <EmptyState title="No collections yet">
              <p>Create a collection, then add saved places in bulk from the Saved places tab.</p>
            </EmptyState>
          ) : (
            <ul className="collection-list">
              {collections.map((collection) => (
                <li key={collection.id} className="collection-item">
                  <div className="collection-item__head">
                    {editingCollection === collection.id ? (
                      <input
                        value={editingName}
                        maxLength={120}
                        aria-label={`New name for ${collection.name}`}
                        onChange={(event) => setEditingName(event.target.value)}
                      />
                    ) : (
                      <strong>{collection.name}</strong>
                    )}
                    <span className="collection-item__count">{collection.itemCount} places</span>
                  </div>
                  {collection.description ? <p>{collection.description}</p> : null}
                  <p className="field__hint">Updated {formatRelative(collection.updatedAt)}</p>
                  <div className="button-row">
                    {editingCollection === collection.id ? (
                      <>
                        <button
                          type="button"
                          className="button button--secondary button--small"
                          onClick={() => renameCollection(collection)}
                          disabled={busy !== null}
                        >
                          Save name
                        </button>
                        <button type="button" className="button button--ghost button--small" onClick={() => setEditingCollection(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        onClick={() => {
                          setEditingCollection(collection.id);
                          setEditingName(collection.name);
                        }}
                      >
                        Rename
                      </button>
                    )}
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={() => {
                        onExportCollection(collection.id);
                        onClose();
                      }}
                    >
                      Export
                    </button>
                    {confirmCollection === collection.id ? (
                      <>
                        <button
                          type="button"
                          className="button button--danger button--small"
                          onClick={() => deleteCollection(collection)}
                          disabled={busy !== null}
                        >
                          Confirm delete
                        </button>
                        <button type="button" className="button button--ghost button--small" onClick={() => setConfirmCollection(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button type="button" className="button button--ghost button--small" onClick={() => setConfirmCollection(collection.id)}>
                        Delete
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {!loading && tab === "searches" ? (
        <div role="tabpanel" id="panel-searches" aria-labelledby="tab-searches">
          {searches.length === 0 ? (
            <EmptyState title="No saved searches yet">
              <p>Use “Save this search” in the sidebar to keep criteria and an optional refresh interval.</p>
            </EmptyState>
          ) : (
            <ul className="search-list">
              {searches.map((search) => (
                <li key={search.id} className="search-item">
                  <div className="search-item__head">
                    <strong>{search.name}</strong>
                    <Badge tone={search.lastRunAt ? "ok" : "neutral"}>
                      {search.lastRunAt ? `Ran ${formatRelative(search.lastRunAt)}` : "Never run"}
                    </Badge>
                  </div>
                  <p className="search-item__criteria">{criteriaSummary(search.criteria)}</p>
                  <div className="search-item__row">
                    <label className="field field--inline">
                      <span>Refresh</span>
                      <select
                        value={search.refreshIntervalMinutes}
                        onChange={(event) => updateSearchRefresh(search, Number(event.target.value))}
                        disabled={busy !== null}
                      >
                        {REFRESH_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {search.refreshIntervalMinutes > 0 ? (
                      <span className="field__hint">Automatic refreshes consume SerpApi budget.</span>
                    ) : null}
                  </div>
                  <div className="button-row">
                    <button type="button" className="button button--secondary button--small" onClick={() => runSearch(search)} disabled={busy !== null}>
                      Run now
                    </button>
                    <button
                      type="button"
                      className="button button--ghost button--small"
                      onClick={() => {
                        onLoadSearch(search.criteria);
                        onClose();
                      }}
                    >
                      Load criteria
                    </button>
                    {confirmSearch === search.id ? (
                      <>
                        <button type="button" className="button button--danger button--small" onClick={() => deleteSearch(search)} disabled={busy !== null}>
                          Confirm delete
                        </button>
                        <button type="button" className="button button--ghost button--small" onClick={() => setConfirmSearch(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button type="button" className="button button--ghost button--small" onClick={() => setConfirmSearch(search.id)}>
                        Delete
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {!loading && tab === "duplicates" ? (
        <div role="tabpanel" id="panel-duplicates" aria-labelledby="tab-duplicates">
          <div className="library-toolbar">
            <label className="field field--inline">
              <span>Status</span>
              <select value={duplicateState} onChange={(event) => setDuplicateState(event.target.value)}>
                <option value="candidate">Candidates</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
              </select>
            </label>
            <p className="field__hint">
              Matches are suggestions. Source records stay separate; reviewing only records a link or rejection.
            </p>
          </div>
          {duplicates.length === 0 ? (
            <EmptyState title={`No ${duplicateState} matches`}>
              <p>
                Cross-source duplicates are detected conservatively by name, address, category, and proximity. No
                source records are merged automatically.
              </p>
            </EmptyState>
          ) : (
            <ul className="duplicate-list">
              {duplicates.map((candidate) => (
                <li key={candidate.id} className="duplicate-item">
                  <div className="duplicate-item__head">
                    <strong>Match score {(candidate.score * 100).toFixed(0)}%</strong>
                    <Badge tone={candidate.state === "approved" ? "ok" : candidate.state === "rejected" ? "error" : "warn"}>
                      {candidate.state}
                    </Badge>
                  </div>
                  <div className="duplicate-pair">
                    {[candidate.a, candidate.b].map((side) => (
                      <div key={side.id} className="duplicate-side">
                        <Badge tone={side.source as Source}>{sourceLabel(side.source)}</Badge>
                        <strong>{side.name}</strong>
                        <span>{side.address ?? "No address"}</span>
                        <span>{side.category ?? "Uncategorised"}</span>
                      </div>
                    ))}
                  </div>
                  <p className="field__hint">
                    Name similarity {String(candidate.signals.nameSimilarity ?? "—")} · distance{" "}
                    {typeof candidate.signals.distanceMeters === "number"
                      ? `${Math.round(candidate.signals.distanceMeters)} m`
                      : "—"}{" "}
                    · category match {candidate.signals.categoryMatch ? "yes" : "no"} ·{" "}
                    {formatDateTime(candidate.createdAt)}
                  </p>
                  <div className="button-row">
                    {candidate.state !== "approved" ? (
                      <button type="button" className="button button--secondary button--small" onClick={() => decide(candidate, "approved")} disabled={busy !== null}>
                        Approve
                      </button>
                    ) : null}
                    {candidate.state !== "rejected" ? (
                      <button type="button" className="button button--ghost button--small" onClick={() => decide(candidate, "rejected")} disabled={busy !== null}>
                        Reject
                      </button>
                    ) : null}
                    {candidate.state !== "candidate" ? (
                      <button type="button" className="button button--ghost button--small" onClick={() => decide(candidate, "candidate")} disabled={busy !== null}>
                        Undo decision
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </Modal>
  );
}

export type { LibraryTab };
