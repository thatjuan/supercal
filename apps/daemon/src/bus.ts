/**
 * The cross-replica notification bus (architecture §10): one dedicated LISTEN connection per
 * process, turning Postgres notifications into typed in-process events. Notifications are hints;
 * consumers keep their own change-log position and catch up on `reconnected`.
 *
 *   const bus = await startBus(config.DATABASE_URL, log);
 *   bus.on('change', ({ tenantId, maxSeq }) => …);
 *   bus.on('reconnected', () => catchUp());
 */
import { CHANGES_CHANNEL, parseId, type ControlTx, type SyncTargetId, type TenantId, type TenantTx } from '@supercal/db';
import { sql as drizzleSql } from 'drizzle-orm';
import postgres from 'postgres';
import { z } from 'zod';
import type { Logger } from './log.ts';

/** Woken sync targets, payload `{"ids":["tgt_…",…]}`. Sent by `wake`. */
export const WAKE_CHANNEL = 'supercal_wake';
/** Each bus NOTIFYs itself here to prove its LISTEN connection still receives. */
const PING_CHANNEL = 'supercal_bus_ping';
/** NOTIFY rejects payloads of 8000 bytes or more; stay well below. */
const WAKE_PAYLOAD_BYTES = 7000;

const targetId = z.string().transform((raw, ctx) => parseId('tgt', raw) ?? (ctx.addIssue({ code: 'custom', message: 'not a sync target id' }), z.NEVER));

/**
 * Every channel the bus listens on: the event it emits and the schema that validates (and shapes)
 * its JSON payload. Adding an entry adds a typed event.
 */
const CHANNELS = {
  change: {
    channel: CHANGES_CHANNEL,
    payload: z
      .object({ t: z.string().min(1), s: z.string().regex(/^\d+$/) })
      .transform(({ t, s }) => ({ tenantId: t as TenantId, maxSeq: BigInt(s) })),
  },
  wake: {
    channel: WAKE_CHANNEL,
    payload: z.object({ ids: z.array(targetId) }).transform(({ ids }) => ({ targetIds: ids })),
  },
} as const satisfies Record<string, { channel: string; payload: z.ZodType }>;

type ChannelEvent = keyof typeof CHANNELS;

export type BusEvents = { [E in ChannelEvent]: z.output<(typeof CHANNELS)[E]['payload']> } & {
  /** The LISTEN connection was re-established; notifications may have been missed. */
  reconnected: undefined;
};

export type Bus = {
  /** Subscribes to an event; returns the unsubscribe function. */
  on<E extends keyof BusEvents>(event: E, listener: (payload: BusEvents[E]) => void): () => void;
  /** Whether notifications are arriving: the bus heard its own ping recently. For `/readyz`. */
  readonly connected: boolean;
  close(): Promise<void>;
};

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
  const listeners: { [E in keyof BusEvents]: Set<(payload: BusEvents[E]) => void> } = { change: new Set(), wake: new Set(), reconnected: new Set() };
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
