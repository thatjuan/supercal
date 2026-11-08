/**
 * The sink write budget: at most `perSecond` writes per second and `perMinute` per minute for one
 * provider user (Google `sub`), shared by every sink of that user in this process. Each worker
 * process keeps its own; Google's own limit (600 requests/min/user) leaves room for the rest.
 *
 *   const wait = budget.take(sub);   // 0: write now (recorded); otherwise ms until a write may go
 */
export type WriteBudget = { take(key: string): number };

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export function createWriteBudget({ perSecond = 5, perMinute = 300, now = Date.now }: { perSecond?: number; perMinute?: number; now?: () => number } = {}): WriteBudget {
  const writes = new Map<string, number[]>();
  return {
    take(key) {
      const at = now();
      const recent = (writes.get(key) ?? []).filter((t) => at - t < MINUTE);
      writes.set(key, recent);
      const minuteFull = recent.length >= perMinute ? recent[recent.length - perMinute] : undefined;
      if (minuteFull !== undefined) return minuteFull + MINUTE - at;
      const lastSecond = recent.filter((t) => at - t < SECOND);
      const secondFull = lastSecond.length >= perSecond ? lastSecond[lastSecond.length - perSecond] : undefined;
      if (secondFull !== undefined) return secondFull + SECOND - at;
      recent.push(at);
      return 0;
    },
  };
}
