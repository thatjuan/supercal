/**
 * Publication settings as the forms edit them, and the PATCH an edit needs. Mirrors the server's
 * versioning rule (`publicationChangeKind` in packages/db): privacy, filters, reminders and sources
 * bump the epoch, which makes calendar apps re-download the calendar; name and colour do not.
 */
import type { components } from '@supercal/api-client';
import type { Publication } from './data.ts';

type Patch = components['schemas']['PublicationPatch'];
export type Source = { calendarId: string; priority: number };

/** What the settings forms edit. `sources` is set for virtual publications only. */
export type Settings = Pick<Publication, 'name' | 'color' | 'privacy' | 'filters' | 'keepAlarms'> & { sources?: Source[] };

export const settingsOf = (publication: Publication): Settings => ({
  name: publication.name,
  color: publication.color,
  privacy: publication.privacy,
  filters: publication.filters,
  keepAlarms: publication.keepAlarms,
  ...(publication.kind === 'virtual' && { sources: publication.sources }),
});

/** Fields whose change bumps the epoch; the rest (name, colour) are cosmetic. */
export const EPOCH_FIELDS = ['privacy', 'filters', 'keepAlarms', 'sources'] as const satisfies readonly (keyof Settings)[];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The fields of `draft` that differ from `base`, as a PATCH body, and whether saving it bumps the epoch. */
export function diffSettings(base: Settings, draft: Settings): { patch: Patch; bumpsEpoch: boolean } {
  const changed = (key: keyof Settings) => !same(base[key], draft[key]);
  const patch: Patch = {
    ...(changed('name') && { name: draft.name }),
    ...(changed('color') && { color: draft.color }),
    ...(changed('privacy') && { privacy: draft.privacy }),
    ...(changed('filters') && { filters: draft.filters }),
    ...(changed('keepAlarms') && { keepAlarms: draft.keepAlarms }),
    ...(changed('sources') && draft.sources && { sources: draft.sources }),
  };
  return { patch, bumpsEpoch: EPOCH_FIELDS.some(changed) };
}

/** Priorities from list position: the first source wins ties. */
export const withPriorities = (calendarIds: readonly string[]): Source[] => calendarIds.map((calendarId, priority) => ({ calendarId, priority }));

export const DEFAULT_FILTERS = { hideDeclined: false, hideCancelled: false, hideAllDay: false } as const;

/** The note shown beside Save when the edit bumps the epoch. */
export const EPOCH_NOTE = 'Calendar apps will re-download this calendar';
