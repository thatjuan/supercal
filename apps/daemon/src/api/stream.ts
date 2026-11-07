/**
 * `GET /api/v1/stream` (architecture §10): server-sent events telling the dashboard and API
 * consumers what changed in the caller's tenant. Events are invalidation hints; clients refetch.
 *
 * - `resources.changed` comes from the change log, never from NOTIFY payloads: a bus `change` for
 *   the tenant (or a bus reconnect) makes each subscriber read `changesSince` its own position, at
 *   most once per 250 ms. Its `id:` is that position, so `Last-Event-ID` resumes without loss, and a
 *   position below `tombstone_floor` gets `reset` instead.
 * - `account.status` and `feed.changed` arrive through `notifyEvent` and go to the owner and admins.
 * - Streams are revalidated every 60 s and closed at once on a bus `auth-revoked`. Clients reconnect
 *   and meet a 401/403 if they lost access.
 *
 * Bun's idle timeout would cut quiet streams, so the handler turns it off for this request with
 * `server.timeout(req, 0)` (available on Bun 1.3.4) and a `: ping` comment goes out every 15 s.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  calendarAccount,
  changesSince,
  connectionStatus,
  publicationState,
  sourceCalendar,
  tombstoneFloor,
  withTenant,
  type TenantTx,
} from '@supercal/db';
import { eq } from 'drizzle-orm';
import { hasRole } from '../auth/policy.ts';
import { resolvePrincipal, type Principal } from '../auth/principal.ts';
import type { Bus } from '../bus.ts';
import { createLogger } from '../log.ts';
import { createApiApp, ProblemError, problemResponses, TooManyRequests } from './kit/index.ts';

const log = createLogger({ component: 'stream' });

const Seq = z.string().regex(/^\d{1,19}$/, 'a change sequence number');

const ResourcesChanged = z
  .object({ type: z.literal('resources.changed'), seq: Seq, calendarIds: z.array(z.string()) })
  .openapi('ResourcesChangedEvent', { description: 'Events changed in these source calendars, up to `seq` (also the SSE `id:`)' });
const AccountStatus = z
  .object({ type: z.literal('account.status'), accountId: z.string(), status: z.enum(connectionStatus.enumValues), detail: z.string().optional() })
  .openapi('AccountStatusEvent', { description: 'A calendar account’s connection or sync status changed' });
const FeedChanged = z
  .object({ type: z.literal('feed.changed'), feedId: z.string() })
  .openapi('FeedChangedEvent', { description: 'A feed’s publications or credentials changed' });
const Reset = z.object({ type: z.literal('reset') }).openapi('ResetEvent', { description: 'Changes cannot be replayed from `Last-Event-ID`: refetch everything' });

export const StreamEvent = z.discriminatedUnion('type', [ResourcesChanged, AccountStatus, FeedChanged, Reset]).openapi('StreamEvent', {
  description: 'One server-sent event: `event:` is `type` and `data:` is this JSON. Only `resources.changed` sets `id:`.',
});
export type StreamEvent = z.infer<typeof StreamEvent>;

/** `signal` closes every open stream (on shutdown, since `server.stop()` waits for them); the intervals are for tests. */
export type StreamOptions = { signal?: AbortSignal; revalidateMs?: number; heartbeatMs?: number };

const COALESCE_MS = 250;
const PAGE_ROWS = 500;
const MAX_STREAMS_PER_USER = 20;
const MAX_PENDING_BYTES = 64 * 1024;

const getStream = createRoute({
  method: 'get',
  path: '/api/v1/stream',
  operationId: 'getStream',
  tags: ['Live updates'],
  description: 'Server-sent events for the current tenant. Resume with `Last-Event-ID` (or `?lastEventId=`); a `: ping` comment is sent every 15 s.',
  request: {
    headers: z.object({ 'last-event-id': Seq.optional() }),
    query: z.object({ lastEventId: Seq.optional().openapi({ description: 'For clients that cannot set `Last-Event-ID`; the header wins' }) }),
  },
  responses: {
    200: { description: 'An endless `text/event-stream` of `StreamEvent`s', content: { 'text/event-stream': { schema: StreamEvent } } },
    ...problemResponses(400, 401, 403, 429, 503),
  },
});

/** Source calendars whose events `principal` sees: their own accounts', or the whole tenant's for admins. */
const visibleCalendars = async (tx: TenantTx, principal: Principal) =>
  (
    await tx
      .select({ id: sourceCalendar.id })
      .from(sourceCalendar)
      .innerJoin(calendarAccount, eq(calendarAccount.id, sourceCalendar.accountId))
      .where(hasRole(principal, 'admin') ? undefined : eq(calendarAccount.ownerUserId, principal.userId))
  ).map((row) => row.id);

/** Where a new stream starts: `Last-Event-ID` if still replayable, else the current newest seq (with `reset` if it was not). */
async function startingPosition(principal: Principal, lastEventId: string | undefined) {
  return withTenant(principal.tenantId, async (tx) => {
    const { maxSeq } = await publicationState(tx, await visibleCalendars(tx, principal));
    if (lastEventId === undefined) return { position: maxSeq, reset: false };
    const last = BigInt(lastEventId);
    return last < (await tombstoneFloor(tx)) ? { position: maxSeq, reset: true } : { position: last, reset: false };
  });
}

const frame = (event: StreamEvent) =>
  `${event.type === 'resources.changed' ? `id: ${event.seq}\n` : ''}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

type Subscriber = { principal: Principal; position: bigint; wake(): void; send(event: StreamEvent): void; close(): void };

/** Builds the stream route over `bus`. One instance per process holds every open stream. */
export function streamRoutes(bus: Bus, { signal, revalidateMs = 60_000, heartbeatMs = 15_000 }: StreamOptions = {}) {
  const subscribers = new Set<Subscriber>();
  const openPerUser = new Map<string, number>();

  bus.on('change', ({ tenantId, maxSeq }) => {
    for (const s of subscribers) if (s.principal.tenantId === tenantId && maxSeq > s.position) s.wake();
  });
  bus.on('reconnected', () => subscribers.forEach((s) => s.wake()));
  bus.on('event', ({ tenantId, ownerUserId, event }) => {
    for (const s of subscribers)
      if (s.principal.tenantId === tenantId && (s.principal.userId === ownerUserId || hasRole(s.principal, 'admin'))) s.send(event);
  });
  bus.on('auth-revoked', ({ userId }) => {
    for (const s of subscribers) if (s.principal.userId === userId) s.close();
  });
  signal?.addEventListener('abort', () => subscribers.forEach((s) => s.close()), { once: true });

  return createApiApp().openapi(getStream, async (c) => {
    const principal = c.var.principal;
    if (signal?.aborted) throw new ProblemError(503, 'Shutting down');
    const open = openPerUser.get(principal.userId) ?? 0;
    if (open >= MAX_STREAMS_PER_USER) throw new TooManyRequests(`At most ${MAX_STREAMS_PER_USER} open streams per user`);
    // Count the slot before any await, so concurrent connects cannot overshoot the limit.
    openPerUser.set(principal.userId, open + 1);
    const release = () => {
      const left = (openPerUser.get(principal.userId) ?? 1) - 1;
      if (left > 0) openPerUser.set(principal.userId, left);
      else openPerUser.delete(principal.userId);
    };

    let start: Awaited<ReturnType<typeof startingPosition>>;
    try {
      start = await startingPosition(principal, c.req.valid('header')['last-event-id'] ?? c.req.valid('query').lastEventId);
    } catch (error) {
      release();
      throw error;
    }

    const encoder = new TextEncoder();
    const headers = c.req.raw.headers;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let pending = false;
    let lastRun = 0;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      subscribers.delete(subscriber);
      release();
      clearTimeout(timer);
      clearInterval(heartbeat);
      clearInterval(revalidation);
    };

    // The queue bound only bites where the runtime applies backpressure: Bun 1.3.4 drains response
    // streams into its own unbounded buffer, so this cannot see bytes stuck in a slow socket.
    const write = (text: string) => {
      if (closed) return;
      controller.enqueue(encoder.encode(text));
      if ((controller.desiredSize ?? 0) < 0) {
        log.info('closing slow stream', { userId: principal.userId });
        subscriber.close();
      }
    };

    /** Sends one `resources.changed` per page of changes after `position`, then advances it. */
    const catchUp = async () => {
      timer = undefined;
      running = true;
      pending = false;
      lastRun = Date.now();
      try {
        await withTenant(principal.tenantId, async (tx) => {
          const ids = await visibleCalendars(tx, principal);
          for (let more = true; more && !closed; ) {
            const page = await changesSince(tx, ids, subscriber.position, PAGE_ROWS);
            more = page.hasMore;
            const calendarIds = [...new Set(page.rows.map((row) => row.sourceCalendarId))];
            if (calendarIds.length > 0) write(frame({ type: 'resources.changed', seq: page.maxSeq.toString(), calendarIds }));
            subscriber.position = page.maxSeq;
          }
        });
      } catch (error) {
        // The position stays at the last page sent: the next change or bus reconnect retries from it.
        log.warn('stream catch-up failed', { error });
      } finally {
        running = false;
        if (pending) subscriber.wake();
      }
    };

    const subscriber: Subscriber = {
      principal,
      position: start.position,
      wake() {
        pending = true;
        if (closed || running || timer) return;
        timer = setTimeout(catchUp, Math.max(0, lastRun + COALESCE_MS - Date.now()));
      },
      send: (event) => write(frame(event)),
      close() {
        if (closed) return;
        cleanup();
        controller.close();
      },
    };

    const heartbeat = setInterval(() => write(': ping\n\n'), heartbeatMs);
    const revalidation = setInterval(async () => {
      const current = await resolvePrincipal(c.var.auth, headers).catch(() => null);
      const same =
        current?.userId === principal.userId && current.tenantId === principal.tenantId && hasRole(current, 'admin') === hasRole(principal, 'admin');
      if (!same) subscriber.close();
    }, revalidateMs);

    const body = new ReadableStream<Uint8Array>(
      {
        start(ctl) {
          controller = ctl;
        },
        cancel: cleanup,
      },
      new ByteLengthQueuingStrategy({ highWaterMark: MAX_PENDING_BYTES }),
    );
    write(': connected\n\n');
    if (start.reset) subscriber.send({ type: 'reset' });
    subscribers.add(subscriber);
    // Catch up once now: replays after `Last-Event-ID`, and covers changes committed while starting.
    subscriber.wake();

    // Bun hands its server to `fetch` as the env; in-process `app.request` calls have none.
    const server: unknown = c.env;
    if (server instanceof Object && 'timeout' in server && typeof server.timeout === 'function') server.timeout(c.req.raw, 0);

    return new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' },
    });
  });
}
