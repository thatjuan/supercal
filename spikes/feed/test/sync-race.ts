// R5: are epoch:seq sync tokens correct under concurrent writers?
// Writers insert unique UIDs into source 1 with a random pause between taking a seq and COMMIT.
// A reader follows the token chain with incremental sync-collection queries the whole time.
// Any UID committed but never reported = a skipped change.
//   bun test/sync-race.ts naive   (no lock: expect skips)
//   bun test/sync-race.ts locked  (per-tenant advisory lock: expect none)
//   bun test/sync-race.ts xmin    (no lock; token = snapshot xmin, rows with xid >= token: expect none, some repeats)
import { resourcesFromIcs } from "../src/model";
import { type Publication, recordChange, sql, view } from "../src/store";

const mode = (["naive", "xmin"] as const).find((m) => m === process.argv[2]) ?? "locked";
const WRITERS = 8;
const PER_WRITER = 40;
const [pub] = await sql<Publication[]>`select * from publication where slug = 'work' and feed_id = 1`;
if (!pub) throw new Error("seed first");
await sql`delete from resource where uid like 'race-%'`;

const mk = (uid: string) => {
  const [r] = resourcesFromIcs(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261107T000000Z\r\nDTSTART:20261201T100000Z\r\nDTEND:20261201T110000Z\r\nSUMMARY:${uid}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
  if (!r) throw new Error("bad fixture");
  return r;
};

const committed = new Set<string>();
const seen = new Set<string>();
let token = (await view(pub, { sinceSeq: BigInt(Number.MAX_SAFE_INTEGER) })).token.seq;
let xminToken = 0n;
let repeats = 0;

// xmin watermark: every txn that commits after this snapshot has xid >= its xmin, so
// "xid >= previous xmin" can never miss one; rows committed before but with xid >= xmin repeat.
async function xminRead(since: bigint) {
  const rows = await sql<{ uid: string | null; xmin: string }[]>`
    select r.uid, pg_snapshot_xmin(pg_current_snapshot())::text as xmin
    from (select 1) one left join resource r on r.source_calendar_id = 1 and r.xid >= ${since.toString()}::xid8`;
  return { uids: rows.flatMap((r) => (r.uid ? [r.uid] : [])), next: BigInt(rows[0]?.xmin ?? "0") };
}
let reads = 0;
let done = false;

async function writer(w: number) {
  for (let i = 0; i < PER_WRITER; i++) {
    const uid = `race-${w}-${i}`;
    await sql.begin(async (tx) => {
      await recordChange(tx, 1, 1, mk(uid), { lock: mode === "locked" });
      await Bun.sleep(Math.random() * 15); // seq taken, not yet committed
    });
    committed.add(uid);
  }
}

async function reader() {
  while (!done) {
    if (mode === "xmin") {
      const x = await xminRead(xminToken);
      for (const uid of x.uids) if (uid.startsWith("race-")) seen.has(uid) ? repeats++ : seen.add(uid);
      xminToken = x.next;
    } else {
      const v = await view(pub!, { sinceSeq: token });
      for (const uid of v.items.keys()) if (uid.startsWith("race-")) seen.add(uid);
      token = v.token.seq;
    }
    reads++;
    await Bun.sleep(2);
  }
}

const t0 = performance.now();
const r = reader();
await Promise.all(Array.from({ length: WRITERS }, (_, w) => writer(w)));
done = true;
await r;
// final catch-up read after everything committed
if (mode === "xmin") for (const uid of (await xminRead(xminToken)).uids) seen.add(uid);
else for (const uid of (await view(pub, { sinceSeq: token })).items.keys()) if (uid.startsWith("race-")) seen.add(uid);

const missing = [...committed].filter((u) => !seen.has(u));
const [{ n } = { n: "0" }] = await sql<{ n: string }[]>`select count(*)::text as n from resource where uid like 'race-%'`;
console.log(`mode=${mode} writers=${WRITERS}x${PER_WRITER} committed=${committed.size} rows=${n} incremental reads=${reads} reported=${seen.size} SKIPPED=${missing.length}${mode === "xmin" ? ` repeats=${repeats}` : ""} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
if (missing.length) console.log("  e.g.", missing.slice(0, 5).join(", "));
await sql`delete from resource where uid like 'race-%'`;
await sql.close();
process.exit(mode === "locked" && missing.length ? 1 : 0);
