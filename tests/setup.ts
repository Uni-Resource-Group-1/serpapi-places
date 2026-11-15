import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

process.env.APP_ACCESS_KEY = "test-access-key-not-for-production-0001";
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://places:places@127.0.0.1:5432/places_discovery_test";
process.env.LOG_LEVEL = "silent";

if (typeof document !== "undefined") {
  const { cleanup } = await import("@testing-library/react");
  afterEach(() => {
    cleanup();
  });
}

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
