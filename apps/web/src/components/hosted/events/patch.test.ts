import { describe, expect, test } from 'vitest';
import { eventForm, type EventForm, type JSEvent } from './form.ts';
import { canSplit, eventPatch, occurrenceEvent, occurrencePatch, overrideKey, overridePatch } from './patch.ts';

const ZONE = 'Europe/Berlin';
const event = (fields: Partial<JSEvent> = {}): JSEvent => ({ '@type': 'Event', version: '2.0', uid: 'e1', title: 'Standup', start: '2026-11-16T09:00:00', duration: 'PT1H', timeZone: ZONE, ...fields });
const edit = (before: JSEvent, change: Partial<EventForm>) => ({ ...eventForm(before, ZONE), ...change });

describe('eventPatch', () => {
  test('an untouched form changes nothing, however the event wrote its values', () => {
    const before = event({ duration: 'PT3600S', status: 'confirmed', recurrenceRule: { frequency: 'weekly', interval: 1 }, alerts: { 1: { action: 'display', trigger: { '@type': 'OffsetTrigger', offset: '-PT10M' } } } });
    expect(eventPatch(before, eventForm(before, ZONE))).toEqual({});
  });

  test('holds only the changed top-level keys', () => {
    expect(eventPatch(event({ description: 'Notes' }), edit(event({ description: 'Notes' }), { title: 'Sync' }))).toEqual({ title: 'Sync' });
  });

  test('cleared fields are null', () => {
    const before = event({ description: 'Notes', locations: { main: { name: 'Room' } }, mainLocationId: 'main' });
    expect(eventPatch(before, edit(before, { description: '', location: '' }))).toEqual({ description: null, locations: null, mainLocationId: null });
  });

  test('never touches attendees, X- or vendor properties', () => {
    const before = event({ participants: { p1: { calendarAddress: 'mailto:a@example.invalid' } }, keywords: { work: true }, 'example.com:custom': 1 });
    const patch = eventPatch(before, edit(before, { title: 'Sync', location: 'Room', description: 'New', status: 'tentative' }));
    expect(Object.keys(patch).sort()).toEqual(['description', 'locations', 'mainLocationId', 'status', 'title']);
    expect(patch.locations).toEqual({ main: { name: 'Room' } });
  });

  test('a custom rule stays out of the patch, even when the start moves', () => {
    const before = event({ recurrenceRule: { frequency: 'monthly', byDay: [{ day: 'mo', nthOfPeriod: 1 }] } });
    const patch = eventPatch(before, edit(before, { startTime: '10:00', endTime: '11:00' }));
    expect(patch).toEqual({ start: '2026-11-16T10:00:00' });
  });

  test('renaming a location keeps its id, its details and the other locations', () => {
    const before = event({ locations: { a: { name: 'Room', description: 'Second floor' }, b: { name: 'Lobby' } }, mainLocationId: 'a' });
    expect(eventPatch(before, edit(before, { location: 'Hall' }))).toEqual({ locations: { a: { name: 'Hall', description: 'Second floor' }, b: { name: 'Lobby' } } });
  });

  test('reminders it cannot show survive a change to the ones it can', () => {
    const absolute = { action: 'display', trigger: { '@type': 'AbsoluteTrigger', when: '2026-11-16T08:00:00Z' } } as const;
    const before = event({ alerts: { x: absolute } });
    expect(eventPatch(before, edit(before, { reminders: [{ id: '', offset: '-PT10M' }] }))).toEqual({
      alerts: { x: absolute, a1: { trigger: { '@type': 'OffsetTrigger', offset: '-PT10M' }, action: 'display' } },
    });
  });

  test('moving a series moves its overrides, so a deleted occurrence stays deleted', () => {
    const before = event({ recurrenceRule: { frequency: 'weekly' }, recurrenceOverrides: { '2026-11-23T09:00:00': { excluded: true }, '2026-11-30T09:00:00': { title: 'Moved', updated: '2026-11-01T00:00:00Z' } } });
    expect(eventPatch(before, edit(before, { startTime: '10:00', endTime: '11:00' }))).toEqual({
      start: '2026-11-16T10:00:00',
      recurrenceOverrides: { '2026-11-23T10:00:00': { excluded: true }, '2026-11-30T10:00:00': { title: 'Moved' } },
    });
  });
});

describe('overrideKey', () => {
  test.each([
    ['2026-11-19T09:00:00', '2026-11-19T09:00:00'],
    ['2026-11-19T09:00:00Z', '2026-11-19T09:00:00'],
    ['2026-11-19', '2026-11-19T00:00:00'],
  ])('%s is %s', (recurrenceId, key) => expect(overrideKey(recurrenceId)).toBe(key));
});

describe('overridePatch', () => {
  const key = '2026-11-19T09:00:00';
  const value = { start: '2026-11-19T10:00:00' };
  test('a pointer when the map exists', () => expect(overridePatch(event({ recurrenceOverrides: {} }), key, value)).toEqual({ [`recurrenceOverrides/${key}`]: value }));
  test('the whole map when it does not, since a pointer into it would fail', () => expect(overridePatch(event(), key, value)).toEqual({ recurrenceOverrides: { [key]: value } }));
});

describe('occurrencePatch', () => {
  const key = '2026-11-23T09:00:00';
  const series = event({ recurrenceRule: { frequency: 'weekly' } });
  const form = (from: JSEvent, change: Partial<EventForm>) => ({ ...eventForm(occurrenceEvent(from, key), ZONE), ...change });

  test('holds only what differs from the series', () => {
    expect(occurrencePatch(series, key, form(series, { startTime: '10:00', endTime: '11:00' }))).toEqual({ recurrenceOverrides: { [key]: { start: '2026-11-23T10:00:00' } } });
  });

  test('starts from an existing override, and leaves out what the server sets', () => {
    const moved = { ...series, recurrenceOverrides: { [key]: { start: '2026-11-23T10:00:00', updated: '2026-11-01T00:00:00Z', sequence: 2 } } };
    expect(occurrencePatch(moved, key, form(moved, { title: 'Retro' }))).toEqual({ [`recurrenceOverrides/${key}`]: { start: '2026-11-23T10:00:00', title: 'Retro' } });
  });

  test('a top-level change replaces the pointers below it', () => {
    const withLocation = event({ recurrenceRule: { frequency: 'weekly' }, locations: { main: { name: 'Room' } }, recurrenceOverrides: { [key]: { 'locations/main/name': 'Hall' } } });
    expect(form(withLocation, {}).location).toBe('Hall');
    expect(occurrencePatch(withLocation, key, form(withLocation, { location: 'Lobby' }))).toEqual({ [`recurrenceOverrides/${key}`]: { locations: { main: { name: 'Lobby' } } } });
  });

  test('changing nothing patches nothing', () => expect(occurrencePatch(series, key, form(series, {}))).toEqual({}));

  test('undoing the only difference removes the override', () => {
    const renamed = { ...series, recurrenceOverrides: { [key]: { title: 'Retro' } } };
    expect(occurrencePatch(renamed, key, form(renamed, { title: 'Standup' }))).toEqual({ [`recurrenceOverrides/${key}`]: null });
  });
});

test('only an occurrence after the first can be split', () => {
  const series = event({ recurrenceRule: { frequency: 'weekly' } });
  expect(canSplit(series, '2026-11-16T09:00:00')).toBe(false);
  expect(canSplit(series, '2026-11-23T09:00:00')).toBe(true);
  expect(canSplit(event(), '2026-11-23T09:00:00')).toBe(false);
});
