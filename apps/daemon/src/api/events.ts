/** Direct calendar event API: JSCalendar 2.0, pinned to draft-ietf-calext-jscalendarbis-22. */
import { isDeepStrictEqual } from 'node:util';
import { createRoute, z } from '@hono/zod-openapi';
import { Temporal } from '@js-temporal/polyfill';
import { addMissingTimezones, applyPatch, fromJSCalendar, InvalidPatchError, InvalidSplitError, JSCalendar, JSEvent, LocalDateTime, objectNameFor, parseCalendar, PRODID, recurrenceId, setProp, serializeCalendar, splitEvent, toJSCalendar, UnknownTimeZoneError, type EventResource, type JCalComponent } from '@supercal/core';
import { calendarAccount, changesSince, resource, resourcesIn, sourceObject, tombstoneFloor, withTenant, type SourceCalendar, type TenantTx } from '@supercal/db';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { bodyLimit } from 'hono/body-limit';
import { stream } from 'hono/streaming';
import { type Principal } from '../auth/principal.ts';
import { requireAccess } from '../hosted/access.ts';
import { readResources } from '../hosted/read.ts';
import { deleteObject, HostedWriteError, lockHostedCalendar, writeObject, type HostedWriteCode } from '../hosted/objects.ts';
import { expandCalendarResources, Occurrence, occurrenceWindow } from './occurrences.ts';
import { audit, BadRequest, createApiApp, ifMatchHeaders, NotFound, ProblemError, problemJson, problemResponses, requireIfMatch, typeId } from './kit/index.ts';

const Event = JSEvent.clone().openapi('JSEvent', { description: 'JSCalendar 2.0 Event per draft-ietf-calext-jscalendarbis-22; unknown properties are preserved.' });
const ReadEvent = JSCalendar.clone().openapi('JSCalendar', { description: 'JSCalendar 2.0 per draft-ietf-calext-jscalendarbis-22. Several detached recurrence instances read as a Group per mapping draft-ietf-calext-jscalendar-icalendar-29 §2.1.2.' });
const Envelope = z.object({ etag: z.string(), event: ReadEvent });
const Change = z.union([Envelope.extend({ uid: z.string(), deleted: z.literal(false) }), z.object({ uid: z.string(), deleted: z.literal(true) })]);
const params = z.object({ id: typeId('cal') });
const eventParams = params.extend({ uid: z.string().min(1) });
const Patch = z.record(z.string(), z.unknown()).openapi('PatchObject');
const json = <T extends z.ZodType>(description: string, schema: T) => ({ description, content: { 'application/json': { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ required: true as const, content: { 'application/json': { schema } } });
const tags = ['Events'];
const description = 'Uses JSCalendar 2.0 per draft-ietf-calext-jscalendarbis-22. Reads include imported calendars; writes require a hosted calendar.';
const errors = problemResponses(400, 401, 403, 404, 409, 412, 413, 422);
const rangeFields = { from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) };
const list = createRoute({ method: 'get', path: '/api/v1/calendars/{id}/events', operationId: 'listEvents', tags, description,
  request: { params, query: z.object({ from: rangeFields.from.optional(), to: rangeFields.to.optional(), limit: z.coerce.number().int().min(1).max(100).default(100), cursor: z.string().optional() }) },
  responses: { 200: json('Events ordered by UID; span filtering is coarse', z.object({ items: z.array(Envelope), nextCursor: z.string().nullable() })), ...errors } });
const get = createRoute({ method: 'get', path: '/api/v1/calendars/{id}/events/{uid}', operationId: 'getEvent', tags, description,
  request: { params: eventParams, headers: z.object({ 'if-none-match': z.string().optional() }) }, responses: { 200: json('Event; ETag is shared with writable CalDAV', ReadEvent), 304: { description: 'Not modified' }, ...errors } });
const create = createRoute({ method: 'post', path: '/api/v1/calendars/{id}/events', operationId: 'createEvent', tags, description,
  request: { params, body: body(Event) }, responses: { 201: json('Created event', ReadEvent), ...errors } });
const put = createRoute({ method: 'put', path: '/api/v1/calendars/{id}/events/{uid}', operationId: 'putEvent', tags, description,
  request: { params: eventParams, headers: ifMatchHeaders, body: body(Event) }, responses: { 200: json('Replaced event', ReadEvent), 201: json('Created event', ReadEvent), ...errors } });
const patch = createRoute({ method: 'patch', path: '/api/v1/calendars/{id}/events/{uid}', operationId: 'patchEvent', tags, description,
  request: { params: eventParams, headers: ifMatchHeaders, body: body(Patch) }, responses: { 200: json('Patched event', ReadEvent), ...errors } });
const remove = createRoute({ method: 'delete', path: '/api/v1/calendars/{id}/events/{uid}', operationId: 'deleteEvent', tags, description,
  request: { params: eventParams, headers: ifMatchHeaders }, responses: { 204: { description: 'Deleted event' }, ...errors } });
const split = createRoute({ method: 'post', path: '/api/v1/calendars/{id}/events/{uid}/split', operationId: 'splitEvent', tags, description,
  request: { params: eventParams, headers: ifMatchHeaders, body: body(z.object({ at: LocalDateTime, uid: z.string().min(1).optional(), patch: Patch.optional() })) },
  responses: { 201: json('Atomically split this and following occurrences', z.object({ original: Envelope, next: Envelope })), ...errors } });
const occurrences = createRoute({ method: 'get', path: '/api/v1/calendars/{id}/occurrences', operationId: 'calendarOccurrences', tags, description,
  request: { params, query: z.object(rangeFields) }, responses: { 200: json('UTC occurrences; at most 366 days and 5,000 items', z.object({ items: z.array(Occurrence), truncated: z.boolean() })), ...errors } });
const changes = createRoute({ method: 'get', path: '/api/v1/calendars/{id}/changes', operationId: 'calendarChanges', tags, description,
  request: { params, query: z.object({ since: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(500) }) },
  responses: { 200: json('Incremental changes; omit since to restart without tombstones', z.object({ changes: z.array(Change), next: z.string(), hasMore: z.boolean() })), ...problemResponses(400, 401, 403, 404, 410) } });
const exportCalendar = createRoute({ method: 'get', path: '/api/v1/calendars/{id}/export.ics', operationId: 'exportCalendar', tags,
  request: { params }, responses: { 200: { description: 'All live events as one iCalendar', content: { 'text/calendar': { schema: z.string() } } }, ...errors } });
const importCalendar = createRoute({ method: 'post', path: '/api/v1/calendars/{id}/import', operationId: 'importCalendar', tags,
  request: { params, query: z.object({ onConflict: z.enum(['skip', 'replace']).default('skip') }), body: { required: true, content: { 'text/calendar': { schema: z.string() } } } },
  responses: { 200: json('Each UID is imported in one transaction; invalid events are reported individually', z.object({ created: z.int(), updated: z.int(), skipped: z.int(), failed: z.array(z.object({ uid: z.string(), reason: z.string() })) })), ...errors } });

const hostedErrors = {
  'invalid-calendar-data': { status: 422, slug: 'invalid-calendar-data' }, 'unsupported-component': { status: 422, slug: 'unsupported-component' },
  'invalid-object': { status: 422, slug: 'invalid-object' }, 'too-large': { status: 413, slug: 'too-large' }, 'uid-conflict': { status: 409, slug: 'uid-conflict' },
  quota: { status: 409, slug: 'event-quota' }, 'precondition-failed': { status: 412, slug: 'precondition-failed' }, 'not-found': { status: 404, slug: 'not-found' },
} satisfies Record<HostedWriteCode, { status: 404 | 409 | 412 | 413 | 422; slug: string }>;
function eventError(error: Error): ProblemError {
  if (error instanceof ProblemError) return error;
  if (error instanceof HostedWriteError) { const mapped = hostedErrors[error.code]; return new ProblemError(mapped.status, error.message, undefined, mapped.slug); }
  if (error instanceof InvalidPatchError) return new BadRequest([{ path: error.pointer, message: error.message }]);
  if (error instanceof z.ZodError) return new BadRequest(error.issues.map((e) => ({ path: e.path.join('/'), message: e.message })));
  if (error instanceof InvalidSplitError) return new ProblemError(422, error.message);
  throw error;
}
async function calendarOf(tx: TenantTx, principal: Principal, id: SourceCalendar['id'], write = false) {
  if (write) await lockHostedCalendar(tx, id);
  const { calendar } = await requireAccess(tx, principal, id, write ? 'write' : 'read');
  const [account] = await tx.select({ provider: calendarAccount.provider }).from(calendarAccount).where(eq(calendarAccount.id, calendar.accountId));
  if (write && account?.provider !== 'hosted') throw new ProblemError(409, 'Calendar is not hosted', undefined, 'calendar-not-hosted');
  if (write && calendar.state !== 'active') throw new ProblemError(409, 'Restore the deleted calendar before writing events');
  return calendar;
}
async function reads<T extends { data: EventResource | null }>(tx: TenantTx, principal: Principal, calendar: SourceCalendar, rows: T[]) {
  const { access } = await requireAccess(tx, principal, calendar.id, 'read');
  return readResources(calendar, access, rows);
}
/** Exported calendars use Supercal's PRODID; expose that calendar-level property on JSON entries. */
function apiEvent(data: EventResource): ReturnType<typeof toJSCalendar> {
  const event = toJSCalendar(data);
  return event['@type'] === 'Event' ? { ...event, prodId: PRODID } : { ...event, entries: event.entries.map((entry) => ({ ...entry, prodId: PRODID })) };
}
async function findEvent(tx: TenantTx, calendar: SourceCalendar, uid: string) {
  const [row] = await tx.select().from(resource).where(and(eq(resource.sourceCalendarId, calendar.id), eq(resource.uid, uid), eq(resource.deleted, false)));
  return row?.data ? { ...row, data: row.data } : null;
}
async function loadEvent(tx: TenantTx, calendar: SourceCalendar, uid: string) {
  const row = await findEvent(tx, calendar, uid); if (!row) throw new NotFound('No such event'); return row;
}
const tag = (row: { revision: string }) => `"${row.revision}"`;
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function decode(v: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(v) || Buffer.from(v, 'base64url').toString('base64url') !== v) throw new Error('Malformed token');
  return JSON.parse(Buffer.from(v, 'base64url').toString('utf8')) as unknown;
}
const Cursor = z.object({ v: z.literal(1), uid: z.string() });
const SyncToken = z.object({ v: z.literal(1), e: z.int().nonnegative(), s: z.string().regex(/^\d+$/) });
const syncExpired = () => new ProblemError(410, 'Restart sync without since', undefined, 'sync-token-expired');
function serverEvent(event: JSEvent, previous: EventResource | null, now: Temporal.Instant): JSEvent {
  const old = previous && toJSCalendar(previous);
  const before = old?.['@type'] === 'Event' ? old : null;
  const timingChanged = before && ['start', 'duration', 'timeZone', 'recurrenceRule'].some((field) => !isDeepStrictEqual(before[field], event[field]));
  return { ...event, prodId: PRODID, updated: now.toString({ smallestUnit: 'second' }), created: before?.created ?? now.toString({ smallestUnit: 'second' }), sequence: before ? (before.sequence ?? 0) + (timingChanged ? 1 : 0) : 0 };
}
/** REST imports keep source extensions while applying the same metadata policy as JSON writes. */
function stampImported(data: EventResource, previous: EventResource | null, now: Temporal.Instant): EventResource {
  const stamp = (component: JCalComponent): JCalComponent => {
    const rid = recurrenceId(component);
    const old = rid ? previous?.overrides.find((candidate) => recurrenceId(candidate) === rid) : previous?.master;
    const event = toJSCalendar({ ...data, master: component, overrides: [] });
    if (event['@type'] !== 'Event') throw new Error('Component must convert to Event');
    const server = JSEvent.parse(serverEvent(event, old && previous ? { ...previous, master: old, overrides: [] } : null, now));
    let result = component;
    for (const [name, value] of [['created', server.created!], ['last-modified', server.updated!], ['dtstamp', server.updated!]] as const) result = setProp(result, [name, {}, 'date-time', value]);
    return setProp(result, ['sequence', {}, 'integer', server.sequence!]);
  };
  return { ...data, master: data.master && stamp(data.master), overrides: data.overrides.map(stamp) };
}
async function store(tx: TenantTx, calendar: SourceCalendar, data: EventResource, options: { ifMatch?: string; createOnly?: boolean } = {}) {
  const [object] = await tx.select().from(sourceObject).where(and(eq(sourceObject.sourceCalendarId, calendar.id), eq(sourceObject.groupUid, data.uid)));
  if (options.createOnly && object) throw new HostedWriteError('uid-conflict', 'UID already exists');
  let payload: string;
  try { payload = serializeCalendar({ props: [], resources: [addMissingTimezones(data)] }); } catch (error) {
    if (error instanceof RangeError || error instanceof UnknownTimeZoneError) throw new HostedWriteError('invalid-calendar-data', error.message);
    throw error;
  }
  const result = await writeObject(tx, calendar, { objectName: object?.providerObjectId ?? await objectNameFor(data.uid), payload,
    ...(options.ifMatch !== undefined && { ifMatch: options.ifMatch }), ...(options.createOnly && { ifNoneMatch: '*' }) });
  return { ...result, event: apiEvent(data) };
}
function sameUid(path: string, event: JSEvent) {
  if (event.uid !== undefined && event.uid !== path) throw new BadRequest([{ path: 'uid', message: 'Body UID must match the path UID' }]);
  return { ...event, uid: path };
}

export const eventRoutes = createApiApp();
eventRoutes.onError((error, c) => problemJson(c, eventError(error)));
eventRoutes.use('/api/v1/calendars/:id/import', bodyLimit({ maxSize: 8 * 1024 * 1024, onError: () => { throw new ProblemError(413, 'Calendar import exceeds 8 MiB'); } }));
eventRoutes
  .openapi(list, async (c) => {
    const query = c.req.valid('query');
    const result = await withTenant(c.var.principal.tenantId, async (tx) => {
      const calendar = await calendarOf(tx, c.var.principal, c.req.valid('param').id);
      let after: string | undefined;
      if (query.cursor) { try { after = Cursor.parse(decode(query.cursor)).uid; } catch { throw new BadRequest([{ path: 'cursor', message: 'Invalid cursor' }]); } }
      if (query.from && query.to && Date.parse(query.from) >= Date.parse(query.to)) throw new BadRequest([{ path: 'to', message: 'to must follow from' }]);
      const overlap = query.from || query.to ? sql`${resource.span} && tstzrange(${query.from ?? null}::timestamptz, ${query.to ?? null}::timestamptz)` : undefined;
      const rows = await tx.select().from(resource).where(and(eq(resource.sourceCalendarId, calendar.id), eq(resource.deleted, false), after === undefined ? undefined : gt(resource.uid, after), overlap)).orderBy(asc(resource.uid)).limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const visible = await reads(tx, c.var.principal, calendar, page);
      return { items: visible.flatMap((row) => row.data ? [{ etag: tag(row), event: apiEvent(row.data) }] : []), nextCursor: rows.length > query.limit ? encode({ v: 1, uid: page.at(-1)!.uid }) : null };
    });
    return c.json(result, 200);
  })
  .openapi(get, async (c) => {
    const result = await withTenant(c.var.principal.tenantId, async (tx) => {
      const calendar = await calendarOf(tx, c.var.principal, c.req.valid('param').id);
      const row = await loadEvent(tx, calendar, c.req.valid('param').uid);
      const [visible] = await reads(tx, c.var.principal, calendar, [row]);
      if (!visible) throw new NotFound('No such event');
      return visible;
    });
    const etag = tag(result);
    const matches = c.req.header('if-none-match')?.split(',').map((v) => v.trim().replace(/^W\//, ''));
    if (matches?.includes(etag) || matches?.includes('*')) return c.body(null, 304, { ETag: etag });
    return c.json(apiEvent(result.data), 200, { ETag: etag });
  })
  .openapi(create, async (c) => {
    const result = await withTenant(c.var.principal.tenantId, async (tx) => {
      const calendar = await calendarOf(tx, c.var.principal, c.req.valid('param').id, true);
      const now = Temporal.Now.instant(), event = { ...c.req.valid('json'), uid: c.req.valid('json').uid ?? crypto.randomUUID() };
      const result = await store(tx, calendar, fromJSCalendar(serverEvent(event, null, now), null, now), { createOnly: true });
      await audit(tx, c.var.principal, 'event.create', { type: 'calendar', id: calendar.id }, { uid: result.uid });
      return result;
    });
    return c.json(result.event, 201, { ETag: result.etag, Location: `/api/v1/calendars/${c.req.valid('param').id}/events/${encodeURIComponent(result.uid)}` });
  })
  .openapi(put, async (c) => {
    const result = await withTenant(c.var.principal.tenantId, async (tx) => {
      const calendar = await calendarOf(tx, c.var.principal, c.req.valid('param').id, true);
      const event = sameUid(c.req.valid('param').uid, c.req.valid('json'));
      const previous = await findEvent(tx, calendar, event.uid);
      if (previous) requireIfMatch(c, tag(previous));
      else if (c.req.header('if-match')) throw new ProblemError(412, 'No current event matches If-Match');
      const now = Temporal.Now.instant();
      const result = await store(tx, calendar, fromJSCalendar(serverEvent(event, previous?.data ?? null, now), null, now));
      await audit(tx, c.var.principal, previous ? 'event.update' : 'event.create', { type: 'calendar', id: calendar.id }, { uid: event.uid });
      return result;
    });
    return c.json(result.event, result.created ? 201 : 200, { ETag: result.etag, Location: c.req.path });
  })
  .openapi(patch, async (c) => {
    const result = await withTenant(c.var.principal.tenantId, async (tx) => {
      const calendar = await calendarOf(tx, c.var.principal, c.req.valid('param').id, true);
      const previous = await loadEvent(tx, calendar, c.req.valid('param').uid);
      requireIfMatch(c, tag(previous));
      if (!previous.data.master) throw new ProblemError(409, 'Detached instances have no master to patch', undefined, 'event-has-no-master');
      const old = toJSCalendar(previous.data);
      if (old['@type'] !== 'Event') throw new Error('Master must convert to Event');
      const event = sameUid(previous.uid, applyPatch(old, c.req.valid('json')));
      const now = Temporal.Now.instant();
      const result = await store(tx, calendar, fromJSCalendar(serverEvent(event, previous.data, now), previous.data, now));
      await audit(tx, c.var.principal, 'event.update', { type: 'calendar', id: calendar.id }, { uid: result.uid });
      return result;
    });
    return c.json(result.event, 200, { ETag: result.etag });
  })
  .openapi(remove, async (c) => {
    await withTenant(c.var.principal.tenantId, async (tx) => {
      const calendar = await calendarOf(tx, c.var.principal, c.req.valid('param').id, true), previous = await loadEvent(tx, calendar, c.req.valid('param').uid);
      requireIfMatch(c, tag(previous));
      if (!previous.objectName) throw new NotFound('No stored object');
      await deleteObject(tx, calendar, { objectName: previous.objectName });
      await audit(tx, c.var.principal, 'event.delete', { type: 'calendar', id: calendar.id }, { uid: previous.uid });
    });
    return c.body(null, 204);
  })
  .openapi(split, async (c) => {
    const result = await withTenant(c.var.principal.tenantId, async (tx) => {
      const calendar = await calendarOf(tx, c.var.principal, c.req.valid('param').id, true), previous = await loadEvent(tx, calendar, c.req.valid('param').uid);
      requireIfMatch(c, tag(previous));
      const input = c.req.valid('json'), now = Temporal.Now.instant();
      const parts = splitEvent(previous.data, input.at, input.uid ?? crypto.randomUUID(), now);
      const next = toJSCalendar(parts.next);
      if (next['@type'] !== 'Event') throw new Error('Split next must have a master');
      const patched = sameUid(parts.next.uid, applyPatch(next, input.patch ?? {}));
      const data = fromJSCalendar(serverEvent(patched, null, now), parts.next, now);
      const nextResult = await store(tx, calendar, data, { createOnly: true });
      const originalResult = await store(tx, calendar, parts.original);
      await audit(tx, c.var.principal, 'event.split', { type: 'calendar', id: calendar.id }, { uid: previous.uid, nextUid: nextResult.uid });
      return { original: { etag: originalResult.etag, event: originalResult.event }, next: { etag: nextResult.etag, event: nextResult.event } };
    });
    return c.json(result, 201);
  })
  .openapi(occurrences, async (c) => {
    const window = occurrenceWindow(c.req.valid('query'));
    const result = await withTenant(c.var.principal.tenantId, async (tx) => {
      const calendar = await calendarOf(tx, c.var.principal, c.req.valid('param').id);
      const result = expandCalendarResources(await reads(tx, c.var.principal, calendar, await resourcesIn(tx, [calendar.id], window)), window, calendar.timezone ?? 'UTC');
      for (const uid of result.skipped) c.var.sync.log.warn('could not expand object', { calendarId: calendar.id, uid });
      return { items: result.items, truncated: result.truncated };
    });
    return c.json(result, 200);
  })
  .openapi(changes, async (c) => {
    const input = c.req.valid('query');
    const result = await withTenant(c.var.principal.tenantId, async (tx) => {
      const calendar = await calendarOf(tx, c.var.principal, c.req.valid('param').id);
      let after = 0n;
      if (input.since !== undefined) {
        try { const token = SyncToken.parse(decode(input.since)); if (token.e !== calendar.syncEpoch) throw syncExpired(); after = BigInt(token.s); } catch { throw syncExpired(); }
        if (after < await tombstoneFloor(tx)) throw syncExpired();
      }
      const page = await changesSince(tx, [calendar.id], after, input.limit);
      const visible = new Map((await reads(tx, c.var.principal, calendar, page.rows)).map((row) => [row.uid, row.data]));
      const changes = page.rows.flatMap<z.infer<typeof Change>>((row) => {
        const data = visible.get(row.uid);
        // Incremental readers must discard cached events that the member projection now hides.
        if (row.deleted || !data) return input.since !== undefined ? [{ uid: row.uid, deleted: true }] : [];
        return [{ uid: row.uid, deleted: false, etag: tag(row), event: apiEvent(data) }];
      });
      return { changes, next: encode({ v: 1, e: calendar.syncEpoch, s: page.maxSeq.toString() }), hasMore: page.hasMore };
    });
    return c.json(result, 200);
  })
  .openapi(exportCalendar, async (c) => {
    const rows = await withTenant(c.var.principal.tenantId, async (tx) => { const calendar = await calendarOf(tx, c.var.principal, c.req.valid('param').id); return reads(tx, c.var.principal, calendar, await resourcesIn(tx, [calendar.id])); });
    c.header('Content-Type', 'text/calendar; charset=utf-8');
    return stream(c, async (output) => {
      const empty = serializeCalendar({ props: [], resources: [] });
      const header = empty.replace(/END:VCALENDAR\r\n$/, '');
      await output.write(header);
      const timezones = new Set<string>();
      for (const row of rows) {
        const data = { ...row.data, timezones: Object.fromEntries(Object.entries(row.data.timezones).filter(([id]) => !timezones.has(id))) };
        Object.keys(data.timezones).forEach((id) => timezones.add(id));
        await output.write(serializeCalendar({ props: [], resources: [data] }).slice(header.length).replace(/END:VCALENDAR\r\n$/, ''));
      }
      await output.write('END:VCALENDAR\r\n');
    });
  })
  .openapi(importCalendar, async (c) => {
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new ProblemError(413, 'Calendar import exceeds 8 MiB');
    const parsed = parseCalendar(raw);
    if (!parsed.resources.length && !parsed.errors.some((e) => e.component === 'vevent')) throw new ProblemError(422, 'Calendar contains no VEVENT');
    const result = await withTenant(c.var.principal.tenantId, async (tx) => {
      const calendar = await calendarOf(tx, c.var.principal, c.req.valid('param').id, true);
      const result = { created: 0, updated: 0, skipped: 0, failed: parsed.errors.map((e) => ({ uid: e.uid ?? '', reason: e.message })) };
      const invalidUids = new Set(parsed.errors.flatMap((e) => e.uid ? [e.uid] : []));
      for (const data of parsed.resources) {
        if (invalidUids.has(data.uid)) continue;
        const previous = await findEvent(tx, calendar, data.uid);
        if (previous && c.req.valid('query').onConflict === 'skip') { result.skipped++; continue; }
        try {
          // A savepoint isolates a rejected object while the enclosing transaction keeps the import atomic.
          const written = await tx.transaction((savepoint) => {
            try { return store(savepoint as TenantTx, calendar, stampImported(data, previous?.data ?? null, Temporal.Now.instant())); } catch (error) {
              if (error instanceof RangeError || error instanceof UnknownTimeZoneError || error instanceof z.ZodError) throw new HostedWriteError('invalid-calendar-data', error.message);
              throw error;
            }
          });
          if (written.created) result.created++; else result.updated++;
        } catch (error) {
          if (!(error instanceof HostedWriteError)) throw error;
          result.failed.push({ uid: data.uid, reason: error.code });
        }
      }
      await audit(tx, c.var.principal, 'calendar.import', { type: 'calendar', id: calendar.id }, { uids: parsed.resources.map((r) => r.uid) });
      return result;
    });
    return c.json(result, 200);
  });
