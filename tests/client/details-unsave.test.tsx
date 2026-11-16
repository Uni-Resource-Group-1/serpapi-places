import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Place, SavedPlace } from "../../src/shared/types.js";

const mocks = vi.hoisted(() => ({
  placeRequest: vi.fn(),
  deleteSavedPlace: vi.fn(),
}));

vi.mock("../../src/client/api.js", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    place: mocks.placeRequest,
    deleteSavedPlace: mocks.deleteSavedPlace,
  },
}));

import { DetailsPanel } from "../../src/client/components/DetailsPanel.js";

function place(): Place {
  return {
    id: "place-1",
    source: "osm",
    sourceType: "osm_node",
    sourceId: "osm-1",
    sourceUrl: "https://www.openstreetmap.org/node/1",
    name: "Delete Test Cafe",
    address: "1 Example Street",
    category: "Cafe",
    lat: 23.78,
    lon: 90.41,
    distanceMeters: null,
    insideArea: null,
    areaCheck: null,
    fields: {},
    provenance: {},
    detailsStatus: "fetched",
    detailsFetchedAt: null,
    retrievedAt: "2026-01-01T00:00:00.000Z",
    saved: true,
    possibleDuplicate: false,
    reviews: { available: false, fetched: 0, lastFetchedAt: null },
  };
}

function savedPlace(): SavedPlace {
  return {
    id: "saved-1",
    place: place(),
    note: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    collections: [],
  };
}

function renderDetails() {
  mocks.placeRequest.mockResolvedValue(place());
  mocks.deleteSavedPlace.mockResolvedValue(undefined);
  return render(
    <DetailsPanel
      placeId="place-1"
      savedPlaces={[savedPlace()]}
      collections={[]}
      reviewsEnabled={false}
      onClose={() => undefined}
      onChanged={() => undefined}
      onNotify={() => undefined}
      onOpenDuplicates={() => undefined}
      onSearchHere={() => undefined}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("DetailsPanel destructive unsave", () => {
  it("requires an explicit confirmation that states the consequence before deleting", async () => {
    renderDetails();
    fireEvent.click(await screen.findByRole("button", { name: "Unsave…" }));
    // First click only reveals the destructive option; nothing is deleted yet.
    fireEvent.click(screen.getByRole("button", { name: "Unsave and delete…" }));
    expect(mocks.deleteSavedPlace).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/cannot be undone/i);

    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
    expect(mocks.deleteSavedPlace).toHaveBeenCalledWith("saved-1", { destroySource: true });
  });

  it("lets the user back out of the destructive confirmation without deleting", async () => {
    renderDetails();
    fireEvent.click(await screen.findByRole("button", { name: "Unsave…" }));
    fireEvent.click(screen.getByRole("button", { name: "Unsave and delete…" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("button", { name: "Yes, delete" })).not.toBeInTheDocument();
    expect(mocks.deleteSavedPlace).not.toHaveBeenCalled();
  });
});