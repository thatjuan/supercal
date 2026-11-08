import { Temporal } from '@js-temporal/polyfill';
import { textValue } from './accessors.ts';
import type { EventResource } from './model.ts';
import { expandOccurrences, type TimeWindow } from './time.ts';

export type BusyInterval = { start: Temporal.Instant; end: Temporal.Instant; status: 'busy' | 'tentative' };

/** Merged busy time clipped to the window; busy takes precedence over tentative. */
export function freeBusy(resources: EventResource[], window: TimeWindow, calendarZone: string): { intervals: BusyInterval[]; truncated: boolean } {
  const edges: { time: Temporal.Instant; busy: number; tentative: number }[] = [];
  let truncated = false;
  for (const resource of resources) {
    const expanded = expandOccurrences(resource, window, calendarZone);
    truncated ||= expanded.truncated;
    for (const occurrence of expanded.occurrences) {
      const component = occurrence.component;
      const status = textValue(component, 'status')?.toUpperCase();
      if (status === 'CANCELLED' || textValue(component, 'transp')?.toUpperCase() === 'TRANSPARENT') continue;
      const start = Temporal.Instant.compare(occurrence.start, window.from) < 0 ? window.from : occurrence.start;
      const end = Temporal.Instant.compare(occurrence.end, window.to) > 0 ? window.to : occurrence.end;
      if (Temporal.Instant.compare(start, end) >= 0) continue;
      const busy = status === 'TENTATIVE' ? 0 : 1;
      edges.push({ time: start, busy, tentative: 1 - busy }, { time: end, busy: -busy, tentative: busy - 1 });
    }
  }
  edges.sort((a, b) => Temporal.Instant.compare(a.time, b.time));
  const intervals: BusyInterval[] = [];
  let busy = 0, tentative = 0;
  for (let i = 0; i < edges.length;) {
    const start = edges[i]!.time;
    do { busy += edges[i]!.busy; tentative += edges[i]!.tentative; i++; } while (i < edges.length && edges[i]!.time.equals(start));
    const end = edges[i]?.time;
    if (!end || (!busy && !tentative)) continue;
    const status = busy ? 'busy' : 'tentative';
    const previous = intervals.at(-1);
    if (previous?.status === status && previous.end.equals(start)) previous.end = end;
    else intervals.push({ start, end, status });
  }
  return { intervals, truncated };
}
