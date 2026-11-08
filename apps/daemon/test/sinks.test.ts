/**
 * Google sinks against a mocked Google over a scratch database: incremental consent, the strict
 * creation order and discovery's skip, idempotent retries, incremental and full reconciles, the
 * write budget, `calendar_missing` and removal. Every request the suite sends to Google passes the
 * interceptor in `handle`, which records any event write that could invite someone.
 */
import { auditLog, closeDb, connectDb, member, migrate, organization, publication, publicationSource, sink, sinkEvent, sourceCalendar, syncTarget, user, type AccountId, type PublicationId, type SinkId, type SourceCalendarId, type SyncTargetId, type TenantId } from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { createGoogleAdapter, createGuardedFetch } from '@supercal/providers';
import { mockGoogle, type MockRequest } from '@supercal/providers/test/google-mock';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { createApi } from '../src/api/index.ts';
import type { ApiEnv, Principal } from '../src/auth/principal.ts';
import { idleBus } from '../src/bus.ts';
import { createLogger } from '../src/log.ts';
import { registry } from '../src/ops/metrics.ts';
import { createWriteBudget } from '../src/sinks/budget.ts';
import { SINK_SCOPE } from '../src/sinks/google.ts';
import { wakeSinks } from '../src/sinks/wake.ts';
import { createSyncDeps, syncHandlers } from '../src/sync/index.ts';
import { claim, complete, StopTargetError, type Job } from '../src/sync/scheduler.ts';
import { testAuth, testSecrets } from './auth-fixture.ts';

const tenantId = `org_${crypto.randomUUID()}` as TenantId;
const userId = `user_sinks_${crypto.randomUUID().slice(0, 8)}`;
const principal: Principal = { kind: 'user', userId, tenantId, role: 'member', via: 'session', isOperator: false };
const injectPrincipal = createMiddleware<ApiEnv>(async (c, next) => {
  c.set('principal', principal);
  await next();
});

const READ_SCOPES = 'openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly';
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const idToken = `${b64({ alg: 'none' })}.${b64({ iss: 'https://accounts.google.com', aud: 'client-id', sub: 'sub-1', email: 'sub-1@example.test' })}.sig`;

type Body = Record<string, unknown> & { id: string; summary?: string };

/** The mocked Google: source calendars' events, the sink calendars Supercal creates, and knobs tests turn. */
const google = {
  scope: READ_SCOPES,
  sources: new Map<string, Body[]>([
    ['work@example.test', []],
    ['bulk@example.test', []],
  ]),
  calendars: new Map<string, Map<string, Body>>(),
  /** What Google stores as each sink calendar's description, and lists back. */
  descriptions: new Map<string, string>(),
  /** Event-write requests (POST/PUT/DELETE on a sink calendar's events), in order. */
  writes: [] as { method: string; id: string; status: number }[],
  /** Answers the next insert with 503 after storing it, like a response lost to a timeout. */
  loseNextInsertResponse: false,
  /** Checked on every event write; the interceptor records violations here. */
  violations: [] as string[],
  /** Whether a `sink` row named the calendar when its first event was written. */
  rowBeforeFirstWrite: new Map<string, boolean>(),
};

const at = (day: number, hour: number) => `2026-11-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+01:00`;
const event = (id: string, summary: string, day = 9, extra: Record<string, unknown> = {}): Body => ({
  id,
  etag: `"${summary}"`,
  iCalUID: `${id}@example.test`,
  status: 'confirmed',
  summary,
  start: { dateTime: at(day, 9), timeZone: 'Europe/Paris' },
  end: { dateTime: at(day, 10), timeZone: 'Europe/Paris' },
  ...extra,
});

/** Records anything in an event write that could send mail or create a conference. */
function intercept(req: MockRequest) {
  if (!/\/calendars\/[^/]+\/events/.test(req.path) || req.method === 'GET') return;
  if (req.query.get('sendUpdates') !== 'none') google.violations.push(`${req.method} ${req.path} without sendUpdates=none`);
  if (req.method === 'DELETE') return;
  const body = JSON.parse(req.body) as Record<string, unknown>;
  for (const field of ['attendees', 'organizer', 'conferenceData']) if (field in body) google.violations.push(`${req.method} ${req.path} sends ${field}`);
}

async function handle(req: MockRequest): Promise<Response> {
  intercept(req);
  const path = decodeURIComponent(req.path);
  if (path === '/token') {
    const form = new URLSearchParams(req.body);
    if (form.get('grant_type') === 'refresh_token') return Response.json({ access_token: 'access-refreshed', expires_in: 3600 });
    return Response.json({ access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-1', scope: google.scope, id_token: idToken });
  }
  if (path === '/calendar/v3/users/me/calendarList')
    return Response.json({ items: [...google.sources.keys(), ...google.calendars.keys()].map((id) => ({ id, summary: id, timeZone: 'Europe/Paris', description: google.descriptions.get(id) })) });
  if (path === '/calendar/v3/users/me/calendarList/primary') return Response.json({ id: 'sub-1@example.test', timeZone: 'Europe/Paris' });
  if (path === '/calendar/v3/calendars' && req.method === 'POST') {
    const body = JSON.parse(req.body) as { summary: string; description: string; timeZone: string };
    const id = `sink-${google.calendars.size + 1}@group.calendar.google.com`;
    google.calendars.set(id, new Map());
    google.descriptions.set(id, body.description);
    return Response.json({ id, ...body });
  }
  const match = /^\/calendar\/v3\/calendars\/([^/]+)(?:\/events(?:\/([^/]+))?)?$/.exec(path);
  if (!match) return new Response(null, { status: 404 });
  const [, calendarId = '', eventId] = match;
  const source = google.sources.get(calendarId);
  if (source) return Response.json({ items: source, nextSyncToken: `token-${Date.now()}` });
  const events = google.calendars.get(calendarId);
  if (!path.includes('/events')) {
    if (req.method === 'DELETE') google.calendars.delete(calendarId);
    return new Response(null, { status: events ? 204 : 404 });
  }
  const answer = (status: number, id: string, body: unknown = {}) => {
    google.writes.push({ method: req.method, id, status });
    return status === 204 ? new Response(null, { status }) : Response.json(body, { status });
  };
  if (!events) return answer(404, eventId ?? '');
  if (req.method === 'POST') {
    const body = JSON.parse(req.body) as Body;
    if (!google.rowBeforeFirstWrite.has(calendarId)) {
      const rows = await unsafeDb().select({ id: sink.id }).from(sink).where(eq(sink.providerCalendarId, calendarId));
      google.rowBeforeFirstWrite.set(calendarId, rows.length > 0);
    }
    if (events.has(body.id)) return answer(409, body.id);
    events.set(body.id, body);
    if (google.loseNextInsertResponse) {
      google.loseNextInsertResponse = false;
      return answer(503, body.id);
    }
    return answer(200, body.id, body);
  }
  if (!eventId || !events.has(eventId)) return answer(404, eventId ?? '');
  if (req.method === 'PUT') {
    events.set(eventId, JSON.parse(req.body) as Body);
    return answer(200, eventId, events.get(eventId));
  }
  events.delete(eventId);
  return answer(204, eventId);
}

const mock = mockGoogle(handle);
const adapter = createGoogleAdapter({ ...mock.options, push: false });
let clock = Date.now();
const deps = createSyncDeps({
  secrets: testSecrets,
  fetch: createGuardedFetch({ allow: [] }),
  log: createLogger({}, () => {}),
  adapters: { google: adapter },
  google: mock.options,
  sinkBudget: createWriteBudget({ perSecond: Infinity, perMinute: 300, now: () => clock }),
});
const handlers = syncHandlers(deps);
let scratch: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let fixture: ReturnType<typeof testAuth> | undefined;
let app: ReturnType<typeof createApi>;

async function targetOf(kind: 'events' | 'discover' | 'sink', targetId: string): Promise<SyncTargetId> {
  const [row] = await unsafeDb().select({ id: syncTarget.id }).from(syncTarget).where(and(eq(syncTarget.kind, kind), eq(syncTarget.targetId, targetId)));
  if (!row) throw new Error(`no ${kind} target for ${targetId}`);
  return row.id;
}

/** Claims `id` now and runs it through its handler, as the scheduler does; returns the error, if any. */
async function runNow(id: SyncTargetId): Promise<unknown> {
  await unsafeDb().update(syncTarget).set({ nextRunAt: sql`clock_timestamp()` }).where(eq(syncTarget.id, id));
  const [job]: Job[] = await claim('test', { leaseMs: 30_000, limit: 1, ids: [id] });
  if (!job) throw new Error(`could not claim ${id}`);
  try {
    await complete(job, { ok: true, ...(await handlers[job.kind](job, new AbortController().signal)) });
    return undefined;
  } catch (error) {
    await complete(job, { ok: false, error });
    return error;
  }
}

const request = (path: string, init?: { method: string; body?: unknown }) =>
  app.request(path, { method: init?.method ?? 'GET', headers: { 'content-type': 'application/json' }, ...(init?.body !== undefined && { body: JSON.stringify(init.body) }) });

/** Connected account, its calendars' publications, and the sink under test. */
type Published = { calendar: SourceCalendarId; publication: PublicationId };
const ids = { account: '' as AccountId, work: {} as Published, bulk: {} as Published, sink: '' as SinkId, calendar: '' };

async function publicationOf(calendarId: SourceCalendarId): Promise<PublicationId> {
  const [row] = await unsafeDb().select({ id: publicationSource.publicationId }).from(publicationSource).where(eq(publicationSource.sourceCalendarId, calendarId));
  if (!row) throw new Error(`no publication for ${calendarId}`);
  return row.id;
}

/** Ingests the source calendar, then runs the sink once; returns the sink run's error and the event writes it made. */
async function ingestAndMirror(calendar: SourceCalendarId, sinkId: string = ids.sink) {
  expect(await runNow(await targetOf('events', calendar))).toBeUndefined();
  const before = google.writes.length;
  const error = await runNow(await targetOf('sink', sinkId));
  return { error, writes: google.writes.slice(before) };
}

/** Connects the Google account through the OAuth flow, as #15 does, and returns its id. */
async function connect(): Promise<AccountId> {
  const start = await request('/api/v1/accounts/oauth/google/start', { method: 'POST', body: { returnTo: '/accounts' } });
  const state = new URL(((await start.json()) as { authorizationUrl: string }).authorizationUrl).searchParams.get('state') ?? '';
  const back = await app.request(`/api/v1/oauth/google/callback?${new URLSearchParams({ code: 'c', state })}`);
  return (new URL(back.headers.get('location') ?? '').searchParams.get('accountId') ?? '') as AccountId;
}

/** The current `supercal_sink_writes_total` for `outcome`. */
const sinkWrites = async (outcome: string) => Number(new RegExp(`^supercal_sink_writes_total\\{outcome="${outcome}"\\} (\\d+)$`, 'm').exec(await registry.render())?.[1] ?? 0);

const mirrored = (calendar = ids.calendar) => [...(google.calendars.get(calendar)?.values() ?? [])];

describe.skipIf(!testDatabaseUrl)('Google sinks', () => {
  beforeAll(async () => {
    scratch = await scratchDatabase('sinks');
    await migrate(scratch.url);
    connectDb(scratch.url);
    fixture = testAuth('invite', scratch.url);
    app = createApi(
      {
        auth: fixture.auth,
        secrets: testSecrets,
        bus: idleBus,
        adapters: { google: adapter },
        googleApi: mock.options,
        oauth: { stateSecret: 'state-secret', google: { clientId: 'client-id', clientSecret: 'client-secret', authorizeUrl: `${mock.url}/auth`, tokenUrl: `${mock.url}/token` } },
      },
      injectPrincipal,
    );
    const now = new Date();
    await unsafeDb().insert(organization).values({ id: tenantId, name: 'T', slug: tenantId, createdAt: now });
    await unsafeDb().insert(user).values({ id: userId, name: 'Sam', email: 'sam@example.com', updatedAt: now });
    await unsafeDb().insert(member).values({ id: crypto.randomUUID(), organizationId: tenantId, userId, role: 'member', createdAt: now });

    google.sources.set('work@example.test', [
      event('standup', 'Standup', 9, { recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'] }),
      { ...event('standup_x', 'Standup (moved)', 16), iCalUID: 'standup@example.test', recurringEventId: 'standup', originalStartTime: { dateTime: at(16, 9), timeZone: 'Europe/Paris' } },
      event('review', 'Design review', 10, {
        description: 'Agenda',
        organizer: { email: 'boss@example.com' },
        attendees: [{ email: 'sub-1@example.test', responseStatus: 'accepted' }, { email: 'boss@example.com', responseStatus: 'accepted' }],
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
      }),
    ]);
    google.sources.set('bulk@example.test', Array.from({ length: 1000 }, (_, i) => event(`bulk${i}`, `Bulk ${i}`, 1 + (i % 28))));

    ids.account = await connect();
    const calendars = await unsafeDb().select().from(sourceCalendar).where(eq(sourceCalendar.accountId, ids.account));
    for (const key of ['work', 'bulk'] as const) {
      const calendar = calendars.find((c) => c.providerCalendarId === `${key}@example.test`);
      if (!calendar) throw new Error(`no ${key} calendar`);
      ids[key] = { calendar: calendar.id, publication: await publicationOf(calendar.id) };
    }
  });

  afterEach(() => {
    expect(google.violations).toEqual([]);
  });

  afterAll(async () => {
    mock.stop();
    await fixture?.close();
    await closeDb();
    await scratch?.drop();
  });

  test('without the sink scope, creating is a 409 needs-consent; declining leaves the account read-only', async () => {
    const res = await request('/api/v1/sinks', { method: 'POST', body: { publicationId: ids.work.publication, accountId: ids.account, returnTo: '/feeds' } });
    expect(res.status).toBe(409);
    const problem = (await res.json()) as { type: string; authorizationUrl: string };
    expect(problem.type).toEndWith('/needs-consent');
    const consent = new URL(problem.authorizationUrl);
    expect(consent.searchParams.get('scope')?.split(' ')).toContain(SINK_SCOPE);
    expect(consent.searchParams.get('include_granted_scopes')).toBe('true');
    expect(consent.searchParams.get('login_hint')).toBe('sub-1@example.test');

    // The user unticks the new scope: nothing changes and no calendar is created.
    const declined = await app.request(`/api/v1/oauth/google/callback?${new URLSearchParams({ code: 'c', state: consent.searchParams.get('state') ?? '' })}`);
    expect(new URL(declined.headers.get('location') ?? '').searchParams.get('error')).toBe('consent_declined');
    expect(google.calendars.size).toBe(0);
    expect((await request('/api/v1/sinks', { method: 'POST', body: { publicationId: ids.work.publication, accountId: ids.account } })).status).toBe(409);
  });

  test('after consent the sink row and its target exist before any event write, and discovery skips the calendar', async () => {
    google.scope = `${READ_SCOPES} ${SINK_SCOPE}`;
    const ask = await request('/api/v1/sinks', { method: 'POST', body: { publicationId: ids.work.publication, accountId: ids.account } });
    const consent = new URL(((await ask.json()) as { authorizationUrl: string }).authorizationUrl);
    const granted = await app.request(`/api/v1/oauth/google/callback?${new URLSearchParams({ code: 'c', state: consent.searchParams.get('state') ?? '' })}`);
    expect(new URL(granted.headers.get('location') ?? '').searchParams.get('accountId')).toBe(ids.account);

    const created = await request('/api/v1/sinks', { method: 'POST', body: { publicationId: ids.work.publication, accountId: ids.account } });
    expect(created.status).toBe(201);
    const view = (await created.json()) as { id: SinkId; calendarId: string; status: string };
    ids.sink = view.id;
    ids.calendar = view.calendarId;
    expect(view.status).toBe('syncing');
    expect(google.writes).toEqual([]);
    const [row] = await unsafeDb().select().from(sink).where(eq(sink.id, view.id));
    expect(row).toMatchObject({ providerSubject: 'sub-1', providerCalendarId: view.calendarId, timeZone: 'Europe/Paris', status: 'active' });
    const [target] = await unsafeDb().select({ cursor: syncTarget.cursor }).from(syncTarget).where(eq(syncTarget.id, await targetOf('sink', view.id)));
    expect(target?.cursor).toEqual({ epoch: null, seq: '0' });

    // Google now lists the sink calendar; discovery must not ingest it.
    expect(await runNow(await targetOf('discover', ids.account))).toBeUndefined();
    const sources = await unsafeDb().select({ id: sourceCalendar.providerCalendarId }).from(sourceCalendar).where(eq(sourceCalendar.accountId, ids.account));
    expect(sources.map((s) => s.id).sort()).toEqual(['bulk@example.test', 'work@example.test']);

    const { error, writes } = await ingestAndMirror(ids.work.calendar);
    expect(error).toBeUndefined();
    expect(google.rowBeforeFirstWrite.get(ids.calendar)).toBe(true);
    expect(writes.map((w) => w.method)).toEqual(['POST', 'POST', 'POST']);
  });

  test('mirrored events are appointments: no people, the join URL in the description, own reminders off', async () => {
    const events = mirrored();
    const review = events.find((e) => e.summary === 'Design review');
    expect(review).toMatchObject({ description: 'Agenda\n\nJoin: https://meet.google.com/abc-defg-hij', reminders: { useDefault: false } });
    expect(review?.extendedProperties).toEqual({ private: { supercalSink: ids.sink, supercalUid: 'review@example.test', supercalRevision: expect.any(String) } });
    const master = events.find((e) => e.summary === 'Standup');
    const moved = events.find((e) => e.summary === 'Standup (moved)');
    expect(master?.recurrence).toEqual(['RRULE:FREQ=WEEKLY;COUNT=4']);
    expect(moved).toMatchObject({ recurringEventId: master?.id, originalStartTime: { dateTime: '2026-11-16T09:00:00', timeZone: 'Europe/Paris' } });
    for (const e of events) expect(e.id).toMatch(/^[0-9a-v]{26}$/);

    const res = await request(`/api/v1/sinks/${ids.sink}`);
    expect(await res.json()).toMatchObject({ status: 'up_to_date', counts: { events: 2 }, error: null, lastWriteAt: expect.any(String) });
  });

  test('one changed source event is exactly one Google write, and a bus change wakes only a sink that is behind', async () => {
    const work = google.sources.get('work@example.test') ?? [];
    google.sources.set('work@example.test', work.map((e) => (e.id === 'review' ? { ...e, etag: '"v2"', summary: 'Design review (v2)' } : e)));
    expect(await runNow(await targetOf('events', ids.work.calendar))).toBeUndefined();
    expect(await wakeSinks(tenantId)).toEqual([await targetOf('sink', ids.sink)]);

    const before = google.writes.length;
    const counted = await sinkWrites('ok');
    expect(await runNow(await targetOf('sink', ids.sink))).toBeUndefined();
    expect(google.writes.slice(before)).toEqual([{ method: 'PUT', id: expect.any(String), status: 200 }]);
    expect(await sinkWrites('ok')).toBe(counted + 1);
    expect(await wakeSinks(tenantId)).toEqual([]);
  });

  test('an insert whose response was lost is retried as 409 then update, without a duplicate', async () => {
    const work = google.sources.get('work@example.test') ?? [];
    google.sources.set('work@example.test', [...work, event('retro', 'Retro', 12)]);
    google.loseNextInsertResponse = true;
    const failures = await sinkWrites('error');
    const first = await ingestAndMirror(ids.work.calendar);
    expect(first.error).toBeInstanceOf(Error);
    expect(await sinkWrites('error')).toBe(failures + 1);
    const retried = await runNow(await targetOf('sink', ids.sink));
    expect(retried).toBeUndefined();
    const retro = google.writes.filter((w) => w.id === mirrored().find((e) => e.summary === 'Retro')?.id);
    expect(retro.map((w) => [w.method, w.status])).toEqual([
      ['POST', 503],
      ['POST', 409],
      ['PUT', 200],
    ]);
    expect(mirrored().filter((e) => e.summary === 'Retro')).toHaveLength(1);
  });

  test('an epoch bump (privacy now busy-only) reconciles fully: every title is Busy and nothing is left behind', async () => {
    await unsafeDb()
      .update(publication)
      .set({ privacy: 'busy-only', epoch: sql`${publication.epoch} + 1` })
      .where(eq(publication.id, ids.work.publication));
    expect(await runNow(await targetOf('sink', ids.sink))).toBeUndefined();
    const events = mirrored();
    expect(events.map((e) => e.summary)).toEqual(['Busy', 'Busy', 'Busy', 'Busy']);
    expect(events.some((e) => typeof e.description === 'string')).toBe(false);
    const ledger = await unsafeDb().select().from(sinkEvent).where(eq(sinkEvent.sinkId, ids.sink));
    expect(ledger).toHaveLength(3);
  });

  test('1,000 initial events are written over several runs, never more than 300 a minute', async () => {
    clock += 61_000;
    const created = await request('/api/v1/sinks', { method: 'POST', body: { publicationId: ids.bulk.publication, accountId: ids.account } });
    const bulk = (await created.json()) as { id: SinkId; calendarId: string };
    expect(await runNow(await targetOf('events', ids.bulk.calendar))).toBeUndefined();

    const target = await targetOf('sink', bulk.id);
    const state = async () =>
      (await unsafeDb().select({ cursor: syncTarget.cursor, inMs: sql`extract(epoch from ${syncTarget.nextRunAt} - clock_timestamp()) * 1000`.mapWith(Number) }).from(syncTarget).where(eq(syncTarget.id, target)))[0];
    const perRun: number[] = [];
    while (mirrored(bulk.calendarId).length < 1000 && perRun.length < 10) {
      const before = google.writes.length;
      expect(await runNow(target)).toBeUndefined();
      perRun.push(google.writes.length - before);
      // A run the budget cut short keeps its cursor and comes back when the minute frees, not at the 10-minute poll.
      const after = await state();
      if (mirrored(bulk.calendarId).length < 1000) {
        expect(after?.cursor).toEqual({ epoch: null, seq: '0' });
        expect(after?.inMs).toBeLessThan(61_000);
      }
      clock += 60_000;
    }
    expect(perRun).toEqual([300, 300, 300, 100]);
    expect(new Set(mirrored(bulk.calendarId).map((e) => e.id)).size).toBe(1000);
    expect((await state())?.cursor).not.toEqual({ epoch: null, seq: '0' });
    expect((await request(`/api/v1/sinks/${bulk.id}?deleteCalendar=true`, { method: 'DELETE' })).status).toBe(204);
  }, 60_000);

  test('a calendar deleted in Google stops the sink as calendar_missing', async () => {
    google.calendars.delete(ids.calendar);
    const work = google.sources.get('work@example.test') ?? [];
    google.sources.set('work@example.test', work.map((e) => (e.id === 'retro' ? { ...e, etag: '"v2"', end: { dateTime: at(12, 11), timeZone: 'Europe/Paris' } } : e)));
    const missing = await sinkWrites('calendar_missing');
    const { error } = await ingestAndMirror(ids.work.calendar);
    expect(error).toBeInstanceOf(StopTargetError);
    expect(await sinkWrites('calendar_missing')).toBe(missing + 1);
    const res = await request(`/api/v1/sinks/${ids.sink}`);
    expect(await res.json()).toMatchObject({ status: 'calendar_missing' });
    const [target] = await unsafeDb().select({ parked: sql<boolean>`${syncTarget.nextRunAt} = 'infinity'` }).from(syncTarget).where(eq(syncTarget.targetId, ids.sink));
    expect(target?.parked).toBe(true);
  });

  test('removing a sink drops its row and target, deletes the calendar on request, and is audited', async () => {
    const list = (await (await request('/api/v1/sinks')).json()) as { items: { id: string }[] };
    expect(list.items.map((s) => s.id)).toEqual([ids.sink]);
    // The calendar is already gone in Google, which counts as deleted.
    expect((await request(`/api/v1/sinks/${ids.sink}?deleteCalendar=true`, { method: 'DELETE' })).status).toBe(204);
    expect(await unsafeDb().select().from(sink)).toEqual([]);
    expect(await unsafeDb().select().from(syncTarget).where(eq(syncTarget.kind, 'sink'))).toEqual([]);
    expect(google.calendars.size).toBe(0);
    const actions = await unsafeDb().select({ action: auditLog.action }).from(auditLog).where(sql`${auditLog.action} like 'sink.%'`);
    expect(actions.map((a) => a.action).sort()).toEqual(['sink.create', 'sink.create', 'sink.delete', 'sink.delete']);
  });

  test('a mirror whose sink row is gone is still not a source: not after deleting the publication, nor after disconnect and reconnect', async () => {
    const created = await request('/api/v1/sinks', { method: 'POST', body: { publicationId: ids.bulk.publication, accountId: ids.account } });
    const { id, calendarId } = (await created.json()) as { id: SinkId; calendarId: string };
    expect((await request(`/api/v1/publications/${ids.bulk.publication}`, { method: 'DELETE' })).status).toBe(204);
    expect(await unsafeDb().select().from(sink).where(eq(sink.id, id))).toEqual([]);
    expect(google.calendars.has(calendarId)).toBe(true);

    const sources = async () => (await unsafeDb().select({ id: sourceCalendar.providerCalendarId }).from(sourceCalendar)).map((s) => s.id);
    expect(await runNow(await targetOf('discover', ids.account))).toBeUndefined();
    expect(await sources()).not.toContain(calendarId);

    expect((await request(`/api/v1/accounts/${ids.account}`, { method: 'DELETE' })).status).toBe(204);
    await connect();
    expect(await sources()).toContain('work@example.test');
    expect(await sources()).not.toContain(calendarId);
  });
});
