/** Loading and writing one hosted event. Each write sends the `If-Match` of the version it started from, so a stale one fails with 412 instead of overwriting. */
import type { components, operations } from '@supercal/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { client, keyPath } from '../../../api.ts';
import type { JSEvent } from './form.ts';

export type CalendarOccurrence = operations['calendarOccurrences']['responses'][200]['content']['application/json']['items'][number];
/** An event as read: one Event, or a Group when a CalDAV client stored several instances with no master. */
export type JSCalendar = components['schemas']['JSCalendar'];
export type LoadedEvent = { data: JSCalendar; etag: string };

const EVENT_PATH = '/api/v1/calendars/{id}/events/{uid}';

/** The second part is the API path, so the live stream refreshes it with the other calendar queries. */
export const eventKey = (id: string, uid: string) => ['hosted-event', EVENT_PATH, id, uid];

export async function fetchEvent(id: string, uid: string): Promise<LoadedEvent> {
  const { data, error, response } = await client.GET(EVENT_PATH, { params: { path: { id, uid } } });
  if (error) throw error;
  return { data, etag: response.headers.get('etag') ?? '' };
}

export async function createEvent(id: string, body: JSEvent) {
  const { error } = await client.POST('/api/v1/calendars/{id}/events', { params: { path: { id } }, body });
  if (error) throw error;
}

export async function patchEvent(id: string, uid: string, etag: string, patch: Record<string, unknown>) {
  const { error } = await client.PATCH(EVENT_PATH, { params: { path: { id, uid }, header: { 'if-match': etag } }, body: patch });
  if (error) throw error;
}

/** Splits the series at `at`. The server gives the later part a new UID and applies `patch` to it. */
export async function splitEvent(id: string, uid: string, etag: string, at: string, patch?: Record<string, unknown>) {
  const { data, error } = await client.POST('/api/v1/calendars/{id}/events/{uid}/split', { params: { path: { id, uid }, header: { 'if-match': etag } }, body: { at, ...(patch && { patch }) } });
  if (error) throw error;
  return data;
}

export async function deleteEvent(id: string, uid: string, etag: string) {
  const { error } = await client.DELETE(EVENT_PATH, { params: { path: { id, uid }, header: { 'if-match': etag } } });
  if (error) throw error;
}

/** Deleting "this and following": split, then delete the later part. */
export async function deleteFollowing(id: string, uid: string, etag: string, at: string) {
  const { next } = await splitEvent(id, uid, etag, at);
  if (next.event.uid) await deleteEvent(id, next.event.uid, next.etag);
}

/** Refreshes this calendar's queries after our own write. */
export function useRefreshEvents() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ predicate: (query) => keyPath(query.queryKey).startsWith('/api/v1/calendars/{id}') });
}
