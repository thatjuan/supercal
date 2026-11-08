/**
 * Light and dark themes. The preference (`system`, `light` or `dark`) is stored in localStorage
 * and applied as `<html data-theme>`; `system` removes the attribute so `prefers-color-scheme`
 * decides. `index.html` applies the stored value before first paint.
 */
import { useSyncExternalStore } from 'react';
import type { Theme } from './lib/color.ts';

export type ThemePreference = Theme | 'system';

const STORAGE_KEY = 'supercal.theme';
const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

let preference = readPreference();

/** Stores `next` and applies it to the document. */
export function setThemePreference(next: ThemePreference) {
  preference = next;
  try {
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage can be unavailable (private windows); the choice then lasts for this page only.
  }
  if (next === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  listeners.forEach((notify) => notify());
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  const query = darkQuery();
  query.addEventListener('change', notify);
  return () => {
    listeners.delete(notify);
    query.removeEventListener('change', notify);
  };
}

const resolve = (): Theme => (preference === 'system' ? (darkQuery().matches ? 'dark' : 'light') : preference);

/** The stored preference and the theme actually showing (for colour maths such as `eventColors`). */
export function useTheme() {
  const current = useSyncExternalStore(subscribe, () => preference);
  const resolved = useSyncExternalStore(subscribe, resolve);
  return { preference: current, resolved, setPreference: setThemePreference };
}
