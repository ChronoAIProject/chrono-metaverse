/* 复制自 CMA web/src/theme/appearance.ts：只改了存储键、事件名和中文标签。 */
import { useSyncExternalStore } from 'react';

/**
 * Light or dark, and remembering which.
 *
 * Web_Style.md specifies both themes in full and defines how they resolve: the
 * light palette is declared on `body`, and dark restates only what differs
 * under `body[data-ds-dark-theme]`. This module only decides which attribute
 * to set; every colour still comes from that document.
 *
 * The palette carries no `prefers-color-scheme` block, so "system" is resolved
 * here rather than by the stylesheet — which means the operating system's
 * setting has to be watched rather than merely answered. See
 * `startAppearance`.
 *
 * Three states, not two. "System" is not the same as light or dark — it is the
 * absence of a choice, and collapsing it into one of them means a person who
 * never expressed a preference gets pinned to whatever the page loaded with.
 */

export type Appearance = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'metaverse:appearance';
let transientAppearance: Appearance | undefined;

/** Whether a stored value is one we understand. */
function isAppearance(value: unknown): value is Appearance {
  return value === 'light' || value === 'dark' || value === 'system';
}

function readAppearance(): Appearance | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isAppearance(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeAppearance(appearance: Appearance): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, appearance);
    transientAppearance = undefined;
  } catch {
    transientAppearance = appearance;
    // Applying the preference does not depend on remembering it.
  }
}

/**
 * The preference this browser last recorded.
 *
 * Storage can throw — private modes and blocked cookies both do it — and a
 * theme preference is never worth failing to render the page over.
 */
export function storedAppearance(): Appearance {
  // 与 CMA 相同：第一次访问默认深色（3D 场景在深色背景上更清楚），可以切换成浅色或跟随系统。
  return transientAppearance ?? readAppearance() ?? 'dark';
}

/**
 * Apply a preference to the document.
 *
 * Only what is being *shown* is written to the DOM — the choice itself lives
 * in storage. "System" is therefore resolved here rather than left for a
 * selector to answer, because the palette has no `prefers-color-scheme` block
 * to answer it with.
 *
 * `color-scheme` is set alongside the attribute and is not decoration: it is
 * what makes the browser's own surfaces — form controls, the canvas behind an
 * overscroll, the default scrollbar before ours loads — match the page. A dark
 * page with a white scrollbar is a page that flashes at its edges.
 */
export function applyAppearance(appearance: Appearance): void {
  const dark = effectiveAppearance(appearance) === 'dark';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document.body.toggleAttribute('data-ds-dark-theme', dark);
}

/** Record a preference, and apply it. */
export function setAppearance(appearance: Appearance): void {
  applyAppearance(appearance);
  writeAppearance(appearance);
  window.dispatchEvent(new Event('metaverse:appearance'));
}

/** What the page is actually showing, resolving "system" against the browser. */
export function effectiveAppearance(appearance: Appearance): 'light' | 'dark' {
  if (appearance !== 'system') {
    return appearance;
  }
  return systemQuery()?.matches === true ? 'dark' : 'light';
}

/** The media query "system" resolves against, or null where it is unsupported. */
function systemQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
}

/**
 * Apply the stored preference, and keep "system" honest.
 *
 * Called once at boot. Two things depend on it that nothing else does:
 *
 * A stored choice is only a stored choice until something applies it. Before
 * this existed nothing did, so choosing dark and reloading gave you light
 * back, and the only reason that was not obvious is that the stylesheet's own
 * media query happened to cover the people who had chosen nothing.
 *
 * And "system" now means watching. The palette selects on an attribute rather
 * than answering a media query, so somebody switching their operating system
 * to dark while the page is open gets nothing unless this listener re-resolves
 * it for them.
 *
 * Returns an unsubscribe, so a test can leave no listener behind.
 */
export function startAppearance(): () => void {
  applyAppearance(storedAppearance());

  const query = systemQuery();
  const reapply = () => {
    if (storedAppearance() === 'system') applyAppearance('system');
  };
  const storage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      transientAppearance = undefined;
      applyAppearance(storedAppearance());
    }
  };
  query?.addEventListener('change', reapply);
  window.addEventListener('storage', storage);
  return () => {
    query?.removeEventListener('change', reapply);
    window.removeEventListener('storage', storage);
  };
}

/** The order the control cycles through. */
export const APPEARANCE_ORDER: readonly Appearance[] = ['system', 'light', 'dark'];

/** Human label for a preference. */
export function appearanceLabel(appearance: Appearance): string {
  switch (appearance) {
    case 'light':
      return '浅色';
    case 'dark':
      return '深色';
    default:
      return '跟随系统';
  }
}

function subscribeAppearance(listener: () => void) {
  window.addEventListener('storage', listener);
  window.addEventListener('metaverse:appearance', listener);
  return () => {
    window.removeEventListener('storage', listener);
    window.removeEventListener('metaverse:appearance', listener);
  };
}
/** Keep retained account menus synchronized with browser-local preferences. */
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribeAppearance, storedAppearance);
}
