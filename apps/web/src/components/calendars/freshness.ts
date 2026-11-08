import { Temporal } from '@js-temporal/polyfill';
import type { Calendar } from './data.ts';

/** "synced 2 min ago", "not synced yet" or a stale warning for a calendar's freshness, relative to `now`. */
export function freshnessText(freshness: Calendar['freshness'], now = Temporal.Now.instant()): string {
  if (freshness.stale) return 'stale: account needs attention';
  if (!freshness.lastSuccessAt) return 'not synced yet';
  const seconds = Math.max(0, Temporal.Instant.from(freshness.lastSuccessAt).until(now).total('seconds'));
  if (seconds < 45) return 'synced just now';
  if (seconds < 3600) return `synced ${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86_400) return `synced ${Math.round(seconds / 3600)} h ago`;
  return `synced ${Math.round(seconds / 86_400)} d ago`;
}
