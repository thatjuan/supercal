/**
 * The virtual calendar builder: pick two or more source calendars (any accounts), order them by
 * priority, then name, colour, privacy and filters. It validates the source count itself and shows
 * the server's source problems (such as a sink calendar) inline; the route does the saving.
 */
import type { Problem } from '@supercal/api-client';
import { useState, type FormEvent } from 'react';
import { Button } from '../ui/button.tsx';
import { ColorChip } from '../ui/calendar-color.tsx';
import { Input } from '../ui/field.tsx';
import { Icon } from '../ui/icon.tsx';
import { fieldErrors, ProblemAlert } from '../ui/problem-alert.tsx';
import { HOSTED_GROUP, type AccountGroup, type Calendar } from './data.ts';
import { Checkbox, FALLBACK_COLOR, SettingsFields } from './settings-fields.tsx';
import { DEFAULT_FILTERS, diffSettings, EPOCH_NOTE, withPriorities, type Settings, type Source } from './settings.ts';
import { SortableList } from './sortable-list.tsx';

export const NEEDS_TWO = 'Pick at least two calendars to merge';

/** The id of the group a calendar is listed under; a hosted calendar's `accountId` is null. */
const groupOf = (calendar: Calendar | undefined) => (calendar?.kind === 'hosted' ? HOSTED_GROUP : (calendar?.accountId ?? ''));

export type VirtualDraft = { settings: Settings & { sources: Source[] }; hideIndividuals: boolean };

type Props = {
  groups: AccountGroup[];
  /** The publication being edited; omitted when creating one. */
  initial?: Settings & { sources: Source[] };
  onSubmit: (draft: VirtualDraft) => void;
  onCancel: () => void;
  pending: boolean;
  problem: Problem | null;
  notice?: string | null;
};

const EMPTY: Settings = { name: '', color: null, privacy: 'full', filters: DEFAULT_FILTERS, keepAlarms: false };

export function VirtualBuilder({ groups, initial, onSubmit, onCancel, pending, problem, notice }: Props) {
  const [settings, setSettings] = useState<Settings>(initial ?? EMPTY);
  const [order, setOrder] = useState<string[]>(() => [...(initial?.sources ?? [])].sort((a, b) => a.priority - b.priority).map((s) => s.calendarId));
  const [search, setSearch] = useState('');
  const [hideIndividuals, setHideIndividuals] = useState(false);
  const [tried, setTried] = useState(false);

  const calendars = new Map(groups.flatMap((g) => g.rows.map((r) => [r.calendar.id, r.calendar] as const)));
  const accountName = new Map(groups.map((g) => [g.id, g.title]));
  // ICS calendars often have no colour; the one the user gave their publication is the better hint.
  const colorOf = new Map(groups.flatMap((g) => g.rows.map((r) => [r.calendar.id, r.passthrough?.color ?? r.calendar.color ?? FALLBACK_COLOR] as const)));
  const sources = withPriorities(order);
  const draft = { ...settings, sources };
  const sourceError = (tried && order.length < 2 ? NEEDS_TWO : undefined) ?? (fieldErrors(problem).sources !== undefined ? (problem?.detail ?? fieldErrors(problem).sources) : undefined);
  const bumpsEpoch = initial ? diffSettings(initial, draft).bumpsEpoch : false;

  const toggle = (id: string, on: boolean) => setOrder((current) => (on ? [...current, id] : current.filter((c) => c !== id)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (order.length < 2 || settings.name.trim() === '') return;
    onSubmit({ settings: draft, hideIndividuals });
  };

  const needle = search.trim().toLowerCase();
  const visible = groups
    .map((g) => ({ ...g, rows: g.rows.filter((r) => !needle || r.calendar.name.toLowerCase().includes(needle) || g.title.toLowerCase().includes(needle)) }))
    .filter((g) => g.rows.length > 0);

  return (
    <form noValidate onSubmit={submit} className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="grid gap-4 rounded-[14px] border border-line bg-surface p-5 shadow-xs">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Calendars to merge</h2>
          <p className="text-sm text-ink-2">Pick two or more, from any account.</p>
        </div>
        <label className="relative block">
          <span className="sr-only">Search calendars</span>
          <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search calendars" className="pl-9" />
        </label>
        <div className="grid max-h-80 gap-3 overflow-y-auto pr-1">
          {visible.map((group) => (
            <fieldset key={group.id} className="grid gap-1">
              <legend className="mb-1 text-[13px] font-medium text-ink-3">{group.title}</legend>
              {group.rows.map(({ calendar }) => (
                <Checkbox
                  key={calendar.id}
                  checked={order.includes(calendar.id)}
                  onChange={(on) => toggle(calendar.id, on)}
                  label={
                    <span className="inline-flex items-center gap-2">
                      <ColorChip color={colorOf.get(calendar.id) ?? FALLBACK_COLOR} className="size-3.5" />
                      {calendar.name}
                    </span>
                  }
                />
              ))}
            </fieldset>
          ))}
          {visible.length === 0 && <p className="text-sm text-ink-3">No calendars match “{search}”.</p>}
        </div>

        <div className="grid gap-1.5">
          <h3 className="text-sm font-semibold">Priority</h3>
          <p className="text-[13px] text-ink-3">
            When the same event is in several of these calendars, the organizer’s copy wins, then the newest version, then the calendar higher in this list. Drag to reorder.
          </p>
          {order.length > 0 ? (
            <SortableList
              label="Source priority"
              items={order}
              keyOf={(id) => id}
              labelOf={(id) => calendars.get(id)?.name ?? id}
              onReorder={setOrder}
              className="rounded-[10px] border border-line px-2"
            >
              {(id) => <SourceLabel calendar={calendars.get(id)} color={colorOf.get(id) ?? FALLBACK_COLOR} account={accountName.get(groupOf(calendars.get(id)))} />}
            </SortableList>
          ) : (
            <p className="rounded-[10px] border border-dashed border-line-strong px-3 py-3 text-sm text-ink-3">Calendars you pick appear here.</p>
          )}
          {sourceError && (
            <p role="alert" className="text-[13px] text-danger">
              {sourceError}
            </p>
          )}
        </div>
      </section>

      <section className="grid gap-5 rounded-[14px] border border-line bg-surface p-5 shadow-xs">
        {notice && (
          <p role="alert" className="rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
            {notice}
          </p>
        )}
        {problem && fieldErrors(problem).sources === undefined && <ProblemAlert problem={problem} showFieldErrors />}
        <SettingsFields
          value={settings}
          onChange={setSettings}
          fallbackColor={colorOf.get(order[0] ?? '') ?? null}
          nameError={tried && settings.name.trim() === '' ? 'Give it a name' : fieldErrors(problem).name}
        />
        <Checkbox
          label="Also hide the individual calendars"
          hint="Turns off their own publications in this feed, so only the merged calendar shows."
          checked={hideIndividuals}
          onChange={setHideIndividuals}
        />
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
          {bumpsEpoch && (
            <p role="note" className="mr-auto text-[13px] text-ink-2">
              {EPOCH_NOTE}
            </p>
          )}
          <Button onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Saving…' : initial ? 'Save' : 'Create virtual calendar'}
          </Button>
        </footer>
      </section>
    </form>
  );
}

function SourceLabel({ calendar, color, account }: { calendar: Calendar | undefined; color: string; account: string | undefined }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-sm">
      <ColorChip color={color} className="size-3.5" />
      <span className="truncate">{calendar?.name ?? 'Unknown calendar'}</span>
      {account && <span className="truncate text-ink-3">· {account}</span>}
    </span>
  );
}
