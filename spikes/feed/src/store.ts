// Data access for the feed side: change recording, publication views, sync tokens.
import { SQL } from "bun";
import { createHash, createHmac } from "node:crypto";
import { type EventResource, type Privacy, mergeCopies, metaOf } from "./model";

export const DB_URL = process.env.DATABASE_URL ?? "postgres://supercal:spike@hare:55432/spike_feed";
export const sql = new SQL(DB_URL, { max: 20 });

export type Feed = { id: number; tenant_id: number; username: string; password_hash: string; secret: string };
export type Publication = {
  id: number; feed_id: number; slug: string; name: string; color: string; privacy: Privacy;
  kind: "passthrough" | "virtual"; uid_mode: "auto" | "source"; keep_alarms: boolean; epoch: number; sort_order: number;
};

/** Upsert or tombstone one resource. All writes go through here.
 *  `lock` = per-tenant advisory lock taken before nextval, so a seq is only handed out once every
 *  lower seq of that tenant has committed. `lock: false` exists only to demonstrate the race. */
export async function recordChange(
  tx: SQL,
  tenantId: number,
  sourceCalendarId: number,
  r: EventResource | { uid: string; deleted: true },
  opts: { lock?: boolean } = {},
) {
  if (opts.lock !== false) await tx`select pg_advisory_xact_lock(${tenantId})`;
  if ("deleted" in r) {
    await tx`update resource set deleted = true, seq = nextval('change_seq'), changed_at = now(), xid = pg_current_xact_id() where source_calendar_id = ${sourceCalendarId} and uid = ${r.uid}`;
    return;
  }
  const m = metaOf(r);
  await tx`
    insert into resource (source_calendar_id, uid, data, sequence, last_modified, organizer, span, deleted, seq)
    values (${sourceCalendarId}, ${r.uid}, ${r}::jsonb, ${m.sequence}, ${m.lastModified}, ${m.organizer},
            tstzrange(${m.span[0]}, ${m.span[1]}), false, nextval('change_seq'))
    on conflict (source_calendar_id, uid) do update set data = excluded.data, sequence = excluded.sequence,
      last_modified = excluded.last_modified, organizer = excluded.organizer, span = excluded.span,
      deleted = false, seq = excluded.seq, changed_at = now(), xid = pg_current_xact_id()`;
}

export async function feedByUsername(username: string): Promise<Feed | undefined> {
  const [f] = await sql<Feed[]>`select * from feed where username = ${username}`;
  return f;
}

export async function feedByIcsToken(token: string): Promise<Feed | undefined> {
  const h = createHash("sha256").update(token).digest("hex");
  const [f] = await sql<Feed[]>`select * from feed where ics_token_sha256 = ${h}`;
  return f;
}

export async function publications(feedId: number): Promise<Publication[]> {
  return sql<Publication[]>`select * from publication where feed_id = ${feedId} order by sort_order, id`;
}

/** Output UID: passthrough+full keeps the source UID; virtual rewrites deterministically so one
 *  UID never appears in two collections of a feed; title/busy-only use an HMAC so shared busy
 *  feeds cannot be correlated across people. */
export function outputUid(feed: Feed, pub: Publication, uid: string): string {
  if (pub.uid_mode === "source") return uid;
  if (pub.privacy !== "full") return createHmac("sha256", feed.secret).update(`${pub.id}\0${uid}`).digest("base64url").slice(0, 26) + "@supercal";
  if (pub.kind === "virtual") return createHash("sha256").update(`${pub.id}\0${uid}`).digest("base64url").slice(0, 26) + "@supercal";
  return uid;
}

/** Resource name inside a collection, from the output UID: stable and URL safe. */
export const hrefName = (outUid: string) => createHash("sha256").update(outUid).digest("base64url").slice(0, 22) + ".ics";

export type SyncToken = { epoch: number; seq: bigint };
export const formatToken = (pubId: number, t: SyncToken) => `http://supercal.invalid/ns/sync/${pubId}/${t.epoch}/${t.seq}`;
export function parseToken(pubId: number, s: string): SyncToken | null {
  const m = /^http:\/\/supercal\.invalid\/ns\/sync\/(\d+)\/(\d+)\/(\d+)$/.exec(s.trim());
  if (!m || Number(m[1]) !== pubId) return null;
  return { epoch: Number(m[2]), seq: BigInt(m[3] ?? "0") };
}

type Row = { source_calendar_id: number; uid: string; data: EventResource; deleted: boolean; seq: string; priority: number; owner_email: string | null };

export type View = {
  token: SyncToken;
  /** uid -> merged resource (live) or null (all copies deleted) */
  items: Map<string, EventResource | null>;
};

/** Everything (or everything changed since `sinceSeq`) visible in a publication, read in ONE
 *  statement so the token and the rows come from the same snapshot. */
export async function view(pub: Publication, opts: { sinceSeq?: bigint; range?: [Date, Date]; uids?: string[] } = {}): Promise<View> {
  const since = (opts.sinceSeq ?? 0n).toString();
  const rangeStart = opts.range?.[0] ?? null;
  const rangeEnd = opts.range?.[1] ?? null;
  const rows = await sql<(Row & { max_seq: string | null })[]>`
    with src as (
      select ps.source_calendar_id, ps.priority, sc.owner_email from publication_source ps
      join source_calendar sc on sc.id = ps.source_calendar_id where ps.publication_id = ${pub.id}
    ), changed as (
      select distinct r.uid from resource r join src using (source_calendar_id)
      where r.seq > ${since}::bigint
    )
    select r.source_calendar_id, r.uid, r.data, r.deleted, r.seq::text, src.priority, src.owner_email,
      (select max(r2.seq)::text from resource r2 join src s2 using (source_calendar_id)) as max_seq
    from resource r join src using (source_calendar_id)
    where r.uid in (select uid from changed)
      and (${rangeStart}::timestamptz is null or r.span && tstzrange(${rangeStart}::timestamptz, ${rangeEnd}::timestamptz))
    union all
    select null, null, null, null, null, null, null,
      (select max(r2.seq)::text from resource r2 join src s2 using (source_calendar_id))`;
  const maxSeq = BigInt(rows.find((r) => r.max_seq !== null)?.max_seq ?? "0");
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.uid === null) continue;
    const g = groups.get(r.uid) ?? [];
    g.push(r);
    groups.set(r.uid, g);
  }
  const items = new Map<string, EventResource | null>();
  for (const [uid, g] of groups) {
    const live = g.filter((r) => !r.deleted);
    items.set(uid, live.length ? mergeCopies(live.map((r) => ({ r: r.data, ownerEmail: r.owner_email, priority: r.priority }))) : null);
  }
  return { token: { epoch: pub.epoch, seq: maxSeq }, items };
}

export async function tombstoneFloor(): Promise<bigint> {
  const [r] = await sql<{ v: string }[]>`select v::text from settings where k = 'tombstone_floor'`;
  return BigInt(r?.v ?? "0");
}

/** Cheap per-publication state for ctag/sync-token/ETag/Last-Modified, without loading rows. */
export async function pubState(pub: Publication): Promise<{ token: SyncToken; lastModified: Date }> {
  const [r] = await sql<{ max_seq: string | null; lm: Date | null }[]>`
    select max(r.seq)::text as max_seq, max(r.changed_at) as lm
    from resource r join publication_source ps on ps.source_calendar_id = r.source_calendar_id
    where ps.publication_id = ${pub.id}`;
  return { token: { epoch: pub.epoch, seq: BigInt(r?.max_seq ?? "0") }, lastModified: r?.lm ?? new Date(0) };
}
