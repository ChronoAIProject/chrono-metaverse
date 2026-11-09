// 复制自 CMA web/src/test/setup.ts，内容未改动。
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Some utility suites deliberately run without jsdom.
const hasDom = typeof globalThis.window !== 'undefined';

if (hasDom && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

// Most component tests exercise the desktop shell; responsive tests set their own width.
if (hasDom) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

/*
 * Node's own `localStorage` global shadows jsdom's, and without a backing file
 * it is an empty object with none of the Storage methods on it. The appearance
 * preference guards against unavailable storage and would otherwise take that
 * fallback in every test.
 *
 * Backed by a Map rather than by the real thing: a test that remembers a
 * choice from the preceding test is one that passes for the wrong reason.
 */
const stored = new Map<string, string>();
if (hasDom) {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, String(value));
      },
      removeItem: (key: string) => {
        stored.delete(key);
      },
      clear: () => {
        stored.clear();
      },
      key: (index: number) => [...stored.keys()][index] ?? null,
      get length() {
        return stored.size;
      },
    } satisfies Storage,
  });
}

afterEach(() => {
  if (hasDom) {
    cleanup();
    sessionStorage.clear();
  }
  stored.clear();
});
