import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ExportJob, SavedPlaceSummary } from "../../src/shared/types.js";

const exportJobs = vi.fn();
const savedPlaceSummaries = vi.fn();
const deleteExportJob = vi.fn();
const createExport = vi.fn();

vi.mock("../../src/client/api.js", () => {
  class ApiError extends Error {}
  return {
    ApiError,
    downloadExport: vi.fn(),
    api: { exportJobs, savedPlaceSummaries, deleteExportJob, createExport },
  };
});

const { ExportModal } = await import("../../src/client/components/ExportModal.js");

function summary(overrides: Partial<SavedPlaceSummary> = {}): SavedPlaceSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Sultan's Dine",
    source: "osm",
    category: "Restaurant",
    address: "Road 11, Banani",
    note: null,
    savedAt: "2026-01-01T00:00:00.000Z",
    hasHours: true,
    hasPopularTimes: false,
    ...overrides,
  };
}

function job(overrides: Partial<ExportJob> = {}): ExportJob {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    scope: "run",
    scopeId: "run-1",
    selectionCount: null,
    format: "csv",
    fields: ["name"],
    sources: ["osm"],
    insideOnly: false,
    status: "completed",
    rowCount: 12,
    omittedSources: [],
    error: null,
    createdAt: "2026-01-02T00:00:00.000Z",
    finishedAt: "2026-01-02T00:00:05.000Z",
    expiresAt: null,
    fileName: null,
    downloadCount: 0,
    lastDownloadedAt: null,
    downloadUrl: "/api/export-jobs/22222222-2222-4222-8222-222222222222/download",
    manifest: null,
    ...overrides,
  };
}

function renderModal() {
  return render(
    <ExportModal
      runs={[]}
      collections={[]}
      defaultTarget={null}
      serpapiExportEnabled={false}
      onClose={() => undefined}
      onNotify={() => undefined}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  exportJobs.mockResolvedValue({ jobs: [job()] });
  savedPlaceSummaries.mockResolvedValue({ places: [summary()] });
  deleteExportJob.mockResolvedValue({ id: "x", deleted: true, fileDeleted: true, fileCleanupFailed: false });
});

describe("ExportModal saved-place picker", () => {
  it("lists saved places and lets the user select one for export", async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText(/export from/i), { target: { value: "saved" } });
    const option = await screen.findByRole("checkbox", { name: /Sultan's Dine/ });
    expect(screen.getByRole("group", { name: "Choose saved places" })).toBeInTheDocument();
    expect(option).not.toBeChecked();
    fireEvent.click(option);
    expect(option).toBeChecked();
    expect(screen.getByText(/1 saved place ·/i)).toBeInTheDocument();
  });

  it("filters places by the search box", async () => {
    savedPlaceSummaries.mockResolvedValue({
      places: [summary(), summary({ id: "33333333-3333-4333-8333-333333333333", name: "Banani Coffee" })],
    });
    renderModal();
    fireEvent.change(screen.getByLabelText(/export from/i), { target: { value: "saved" } });
    await screen.findByRole("checkbox", { name: /Sultan's Dine/ });
    fireEvent.change(screen.getByLabelText(/find saved places/i), { target: { value: "coffee" } });
    expect(screen.queryByRole("checkbox", { name: /Sultan's Dine/ })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Banani Coffee/ })).toBeInTheDocument();
  });
});

describe("ExportModal history deletion", () => {
  it("deletes an export after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderModal();
    const item = (await screen.findByText(/Search run/)).closest("li");
    expect(item).not.toBeNull();
    fireEvent.click(within(item as HTMLElement).getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(deleteExportJob).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222"));
    await waitFor(() => expect(screen.queryByText(/Search run/)).not.toBeInTheDocument());
    confirmSpy.mockRestore();
  });

  it("does not delete when the user cancels confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderModal();
    const item = (await screen.findByText(/Search run/)).closest("li");
    fireEvent.click(within(item as HTMLElement).getByRole("button", { name: /^delete$/i }));
    expect(deleteExportJob).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});