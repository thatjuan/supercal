/**
 * The cross-replica notification bus (architecture §10): one dedicated LISTEN connection per
 * process, turning Postgres notifications into typed in-process events. Notifications are hints;
 * consumers keep their own change-log position and catch up on `reconnected`.
 *
 *   const bus = await startBus(config.DATABASE_URL, log);
 *   bus.on('change', ({ tenantId, maxSeq }) => …);
 *   bus.on('reconnected', () => catchUp());
 *
 * Publishers: `recordChanges` (change), `wake`, `notifyEvent` (account status and feed changes for
 * the live stream) and `publishAuthRevoked` (sign-out, membership removal, API-key deletion).
 */
import {
  calendarAccount,
  CHANGES_CHANNEL,
  connectionStatus,
  feed,
  parseId,
  type ControlTx,
  type FeedId,
  type DavLoginId,
  type IdPrefix,
  type SyncTargetId,
  type TenantId,
  type TenantTx,
} from '@supercal/db';
import { eq, sql as drizzleSql } from 'drizzle-orm';
import postgres from 'postgres';
import { z } from 'zod';
import type { Logger } from './log.ts';

/** Woken sync targets, payload `{"ids":["tgt_…",…]}`. Sent by `wake`. */
export const WAKE_CHANNEL = 'supercal_wake';
/** Rotated feed credentials, payload `{"f":"feed_…"}`. Sent by `notifyFeedCredentialsRotated`. */
export const FEED_CREDENTIALS_CHANNEL = 'supercal_feed_credentials_rotated';
/** Live-stream events, payload `{t, type, id, u, …}` where `u` is the owning user. Sent by `notifyEvent`. */
export const EVENTS_CHANNEL = 'supercal_events';
/** A user's authorization was revoked, payload `{"u":"<userId>"}`. Sent by `publishAuthRevoked`. */
export const AUTH_REVOKED_CHANNEL = 'supercal_auth_revoked';
/** Each bus NOTIFYs itself here to prove its LISTEN connection still receives. */
const PING_CHANNEL = 'supercal_bus_ping';
/** NOTIFY rejects payloads of 8000 bytes or more; stay well below. */
const WAKE_PAYLOAD_BYTES = 7000;
/** Status details are truncated to this many characters, keeping event payloads small. */
const DETAIL_CHARS = 1000;

const typeId = <P extends IdPrefix>(prefix: P) =>
  z.string().transform((raw, ctx) => parseId(prefix, raw) ?? (ctx.addIssue({ code: 'custom', message: `not a ${prefix} id` }), z.NEVER));

const eventHeader = { t: z.string().min(1), u: z.string().nullable() };
const eventPayload = z
  .discriminatedUnion('type', [
    z.object({
      ...eventHeader,
      type: z.literal('account.status'),
      id: typeId('acc'),
      status: z.enum(connectionStatus.enumValues),
      detail: z.string().optional(),
    }),
    z.object({ ...eventHeader, type: z.literal('feed.changed'), id: typeId('feed') }),
  ])
  .transform(({ t, u, ...e }) => ({
    tenantId: t as TenantId,
    /** Who may see it besides tenant admins; null when the account or feed is already gone. */
    ownerUserId: u,
    event:
      e.type === 'account.status'
        ? { type: e.type, accountId: e.id, status: e.status, ...(e.detail !== undefined && { detail: e.detail }) }
        : { type: e.type, feedId: e.id },
  }));

/**
 * Every channel the bus listens on: the event it emits and the schema that validates (and shapes)
 * its JSON payload. Adding an entry adds a typed event.
 */
const CHANNELS = {
  'dav-login-revoked': {
    channel: 'supercal_dav_login_revoked',
    payload: z.object({ id: typeId('dvl') }).transform(({ id }) => ({ loginId: id })),
  },
  change: {
    channel: CHANGES_CHANNEL,
    payload: z
      .object({ t: z.string().min(1), s: z.string().regex(/^\d+$/), c: z.number().optional() })
      .transform(({ t, s, c }) => ({ tenantId: t as TenantId, maxSeq: BigInt(s), ...(c !== undefined && { sentAt: c }) })),
  },
  wake: {
    channel: WAKE_CHANNEL,
    payload: z.object({ ids: z.array(typeId('tgt')) }).transform(({ ids }) => ({ targetIds: ids })),
  },
  event: { channel: EVENTS_CHANNEL, payload: eventPayload },
  'auth-revoked': {
    channel: AUTH_REVOKED_CHANNEL,
    payload: z.object({ u: z.string().min(1) }).transform(({ u }) => ({ userId: u })),
  },
  'feed-credentials-rotated': {
    channel: FEED_CREDENTIALS_CHANNEL,
    payload: z.object({ f: typeId('feed') }).transform(({ f }) => ({ feedId: f })),
  },
} as const satisfies Record<string, { channel: string; payload: z.ZodType }>;

type ChannelEvent = keyof typeof CHANNELS;

export type BusEvents = { [E in ChannelEvent]: z.output<(typeof CHANNELS)[E]['payload']> } & {
  /** The LISTEN connection was re-established; notifications may have been missed. */
  reconnected: undefined;
};

/** An event `notifyEvent` publishes to a tenant's live streams. */
export type NotifiedEvent = BusEvents['event']['event'];

export type Bus = {
  /** Subscribes to an event; returns the unsubscribe function. */
  on<E extends keyof BusEvents>(event: E, listener: (payload: BusEvents[E]) => void): () => void;
  /** Whether notifications are arriving: the bus heard its own ping recently. For `/readyz`. */
  readonly connected: boolean;
  close(): Promise<void>;
};

/** A bus that never emits, for building the API without a database (OpenAPI generation, tests). */
export const idleBus: Bus = { on: () => () => {}, connected: false, close: async () => {} };

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/**
 * Connects the bus to `url` and resolves once every channel is listened to. Pings itself every
 * `pingMs`; `connected` turns false after three pings go unheard.
 */
export async function startBus(url: string, log: Logger, { pingMs = 5_000 } = {}): Promise<Bus> {
  const sql = postgres(url, { max: 1, connection: { application_name: 'supercal-bus' }, onnotice: () => {} });
  const listeners: { [E in keyof BusEvents]: Set<(payload: BusEvents[E]) => void> } = {
    change: new Set(),
    wake: new Set(),
    'feed-credentials-rotated': new Set(),
    'dav-login-revoked': new Set(),
    event: new Set(),
    'auth-revoked': new Set(),
    reconnected: new Set(),
  };
  const emit = <E extends keyof BusEvents>(event: E, payload: BusEvents[E]) => {
    for (const listener of listeners[event])
      try {
        listener(payload);
      } catch (error) {
        log.error('bus listener failed', { event, error });
      }
  };

  const token = crypto.randomUUID();
  let heardAt = Date.now();
  let closed = false;

  // postgres.js calls onlisten after every (re)LISTEN of a channel. A reconnect re-listens each
  // one, so a round is complete when every channel has been listened to that many times.
  const channels = [...Object.values(CHANNELS).map((c) => c.channel), PING_CHANNEL];
  const listens = new Map<string, number>();
  let rounds = 0;
  const onListen = (channel: string) => () => {
    heardAt = Date.now();
    listens.set(channel, (listens.get(channel) ?? 0) + 1);
    const complete = Math.min(...channels.map((c) => listens.get(c) ?? 0));
    if (complete <= rounds) return;
    rounds = complete;
    if (rounds > 1) {
      log.info('bus reconnected');
      emit('reconnected', undefined);
    }
  };

  const subscribe = <E extends ChannelEvent>(event: E) => {
    const { channel, payload } = CHANNELS[event];
    return sql.listen(
      channel,
      (raw) => {
        heardAt = Date.now();
        const parsed = payload.safeParse(parseJson(raw));
        if (parsed.success) emit(event, parsed.data as BusEvents[E]);
        else log.warn('dropped malformed notification', { channel, bytes: raw.length, issues: parsed.error.issues.map((i) => i.message) });
      },
      onListen(channel),
    );
  };

  await Promise.all([
    ...(Object.keys(CHANNELS) as ChannelEvent[]).map(subscribe),
    sql.listen(PING_CHANNEL, (raw) => raw === token && (heardAt = Date.now()), onListen(PING_CHANNEL)),
  ]);
  const pinger = setInterval(() => sql`select pg_notify(${PING_CHANNEL}, ${token})`.catch(() => {}), pingMs);

  return {
    on(event, listener) {
      listeners[event].add(listener);
      return () => listeners[event].delete(listener);
    },
    get connected() {
      return !closed && Date.now() - heardAt < 3 * pingMs;
    },
    async close() {
      closed = true;
      clearInterval(pinger);
      await sql.end();
    },
  };
}

/**
 * NOTIFYs workers that `targetIds` were woken. Sent on commit of `tx`, chunked so each payload
 * stays under 7000 bytes. Used by the sync engine after it bumps the targets' `wake_generation`.
 */
export async function wake(tx: TenantTx | ControlTx, targetIds: readonly SyncTargetId[]): Promise<void> {
  const empty = Buffer.byteLength('{"ids":[]}');
  const chunks: SyncTargetId[][] = [];
  let chunk: SyncTargetId[] = [];
  let size = empty;
  for (const id of targetIds) {
    const bytes = Buffer.byteLength(JSON.stringify(id)) + 1; // the quoted id and a comma
    if (chunk.length > 0 && size + bytes > WAKE_PAYLOAD_BYTES) {
      chunks.push(chunk);
      chunk = [];
      size = empty;
    }
    chunk.push(id);
    size += bytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  for (const ids of chunks) await tx.execute(drizzleSql`select pg_notify(${WAKE_CHANNEL}, ${JSON.stringify({ ids })})`);
}

/**
 * NOTIFYs every process that `feedId`'s CalDAV password or ICS token was rotated, on commit of
 * `tx`. The feed delivery role drops its cached credential verifications for the feed.
 */
export async function notifyFeedCredentialsRotated(tx: TenantTx, feedId: FeedId): Promise<void> {
  await tx.execute(drizzleSql`select pg_notify(${FEED_CREDENTIALS_CHANNEL}, ${JSON.stringify({ f: feedId })})`);
}

/**
 * NOTIFYs the tenant's live streams of `event`, on commit of `tx`. The payload names the account's
 * or feed's owner, so streams can show it to that user and tenant admins only. One call each in the
 * sync engine (account status changes) and the feeds service (publication or credential mutations):
 *
 *   await notifyEvent(tx, tenantId, { type: 'feed.changed', feedId });
 */
export async function notifyEvent(tx: TenantTx, tenantId: TenantId, event: NotifiedEvent): Promise<void> {
  const [wire, owner] =
    event.type === 'account.status'
      ? [
          { t: tenantId, type: event.type, id: event.accountId, status: event.status, ...(event.detail !== undefined && { detail: event.detail.slice(0, DETAIL_CHARS) }) },
          tx.select({ u: calendarAccount.ownerUserId }).from(calendarAccount).where(eq(calendarAccount.id, event.accountId)),
        ]
      : [{ t: tenantId, type: event.type, id: event.feedId }, tx.select({ u: feed.ownerUserId }).from(feed).where(eq(feed.id, event.feedId))];
  await tx.execute(drizzleSql`select pg_notify(${EVENTS_CHANNEL}, (${JSON.stringify(wire)}::jsonb || jsonb_build_object('u', (${owner})))::text)`);
}

/**
 * NOTIFYs every replica to close `userId`'s live streams at once (on commit, inside a transaction).
 * Sent on sign-out, membership removal and API-key deletion; other changes are caught by the
 * streams' periodic revalidation.
 */
export async function publishAuthRevoked(db: Pick<ControlTx, 'execute'>, userId: string): Promise<void> {
  await db.execute(drizzleSql`select pg_notify(${AUTH_REVOKED_CHANNEL}, ${JSON.stringify({ u: userId })})`);
}

/** Invalidates device verification caches across replicas on commit. */
export async function notifyDavLoginRevoked(tx: TenantTx, loginId: DavLoginId): Promise<void> {
  await tx.execute(drizzleSql`select pg_notify('supercal_dav_login_revoked', ${JSON.stringify({ id: loginId })})`);
}
