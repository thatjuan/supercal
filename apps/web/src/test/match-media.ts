import { vi } from 'vitest';

/** jsdom has no `matchMedia`; `useTheme` (behind every event block) needs one. Call in `beforeEach`. */
export const stubMatchMedia = () =>
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
