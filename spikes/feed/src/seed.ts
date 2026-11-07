// Reset spike_feed and seed two feeds. `bun src/seed.ts [--bench N]`
import { createHash } from "node:crypto";
import { resourcesFromIcs } from "./model";
import { recordChange, sql } from "./store";

const here = (p: string) => new URL(p, import.meta.url);
await sql.unsafe(await Bun.file(here("./schema.sql")).text());

const BERLIN = (await Bun.file(here("../fixtures/tricky.ics")).text()).match(/BEGIN:VTIMEZONE\r\nTZID:Europe\/Berlin[\s\S]*?END:VTIMEZONE\r\n/)?.[0] ?? "";
const cal = (body: string, tz = "") => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//seed//EN\r\n${tz}${body}END:VCALENDAR\r\n`;
const ev = (lines: string[]) => `BEGIN:VEVENT\r\n${lines.join("\r\n")}\r\nEND:VEVENT\r\n`;

async function source(id: number, name: string, owner: string, ics: string) {
  await sql`insert into source_calendar (id, tenant_id, name, owner_email) values (${id}, 1, ${name}, ${owner})`;
  await sql.begin(async (tx) => {
    for (const r of resourcesFromIcs(ics)) await recordChange(tx, 1, id, r);
  });
}

// 1: Work — the tricky fixture plus two shared meetings (organizer copy here for meeting A).
const tricky = await Bun.file(here("../fixtures/tricky.ics")).text();
const shared = (uid: string, seq: number, organizer: string, summary: string, stamp: string) =>
  ev([`UID:${uid}`, `DTSTAMP:${stamp}`, `SEQUENCE:${seq}`, "DTSTART;TZID=Europe/Berlin:20261110T140000", "DTEND;TZID=Europe/Berlin:20261110T150000",
    `SUMMARY:${summary}`, `ORGANIZER:mailto:${organizer}`, "ATTENDEE;PARTSTAT=ACCEPTED:mailto:juan@work.example", "LOCATION:Berlin office", "DESCRIPTION:Agenda: secrets"]);
await source(1, "Work (Google)", "juan@work.example",
  tricky.replace("END:VCALENDAR", "") +
    shared("meeting-a@example.com", 1, "juan@work.example", "Meeting A (organizer copy)", "20261101T100000Z") +
    shared("meeting-b@example.com", 1, "boss@corp.example", "Meeting B (stale copy)", "20261101T100000Z") + "END:VCALENDAR\r\n");

// 2: Personal — privacy edge cases.
await source(2, "Personal (iCloud)", "juan@icloud.example", cal(
  ev(["UID:doctor@icloud.example", "DTSTAMP:20261101T120000Z", "DTSTART;TZID=Europe/Berlin:20261112T090000", "DTEND;TZID=Europe/Berlin:20261112T100000",
    "SUMMARY:Dr. appointment", "DESCRIPTION:Bring test results", "LOCATION:Clinic", "CLASS:PRIVATE", "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Doctor", "TRIGGER:-PT1H", "END:VALARM"]) +
  ev(["UID:gym@icloud.example", "DTSTAMP:20261101T120000Z", "DTSTART;TZID=Europe/Berlin:20261113T180000", "DTEND;TZID=Europe/Berlin:20261113T190000",
    "SUMMARY:Gym (free time)", "TRANSP:TRANSPARENT"]) +
  ev(["UID:dinner@icloud.example", "DTSTAMP:20261101T120000Z", "DTSTART;TZID=Europe/Berlin:20261114T190000", "DTEND;TZID=Europe/Berlin:20261114T210000",
    "SUMMARY:Dinner with Ana", "LOCATION:Trattoria", "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC", "ATTACH:https://example.com/menu.pdf"]), BERLIN));

// 3: Team — other copies of the shared meetings.
await source(3, "Team (M365)", "juan@team.example", cal(
  shared("meeting-a@example.com", 5, "juan@work.example", "Meeting A (attendee copy, higher SEQUENCE)", "20261102T100000Z") +
  shared("meeting-b@example.com", 3, "boss@corp.example", "Meeting B (newest copy)", "20261103T100000Z"), BERLIN));

// 4: Bench — N generated events for ICS render timing.
const benchIdx = process.argv.indexOf("--bench");
const n = benchIdx > 0 ? Number(process.argv[benchIdx + 1]) : 5000;
let bench = "";
for (let i = 0; i < n; i++) {
  const day = new Date(Date.UTC(2026, 0, 1) + (i % 700) * 86400_000).toISOString().slice(0, 10).replaceAll("-", "");
  const h = String(8 + (i % 10)).padStart(2, "0");
  const base = [`UID:bench-${i}@example.com`, "DTSTAMP:20261101T120000Z", `SUMMARY:Bench event ${i} with a reasonably long title`,
    `DESCRIPTION:${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(3)}`, "LOCATION:Room " + (i % 50),
    "ORGANIZER;CN=Org:mailto:org@example.com", "ATTENDEE;CN=A;PARTSTAT=ACCEPTED:mailto:a@example.com", "ATTENDEE;CN=B;PARTSTAT=TENTATIVE:mailto:b@example.com"];
  if (i % 10 === 0) bench += ev([...base, `DTSTART;VALUE=DATE:${day}`]);
  else if (i % 5 === 0) bench += ev([...base, `DTSTART;TZID=Europe/Berlin:${day}T${h}0000`, `DTEND;TZID=Europe/Berlin:${day}T${h}3000`, "RRULE:FREQ=WEEKLY;COUNT=20"]);
  else bench += ev([...base, `DTSTART;TZID=Europe/Berlin:${day}T${h}0000`, `DTEND;TZID=Europe/Berlin:${day}T${h}4500`]);
}
await source(4, "Bench", "bench@example.com", cal(bench, BERLIN));

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const feeds = [
  { id: 1, username: "meridian", pw: "meridian-app-pw", token: "ics-meridian-secret" },
  { id: 2, username: "bench", pw: "bench-pw", token: "ics-bench-secret" },
];
for (const f of feeds) {
  await sql`insert into feed (id, tenant_id, username, password_hash, ics_token_sha256, secret)
    values (${f.id}, 1, ${f.username}, ${await Bun.password.hash(f.pw)}, ${sha(f.token)}, ${sha("secret" + f.id)})`;
}
const pubs = [
  { id: 1, feed: 1, slug: "work", name: "Work", color: "#1E88E5FF", privacy: "full", kind: "passthrough", uid_mode: "auto", src: [1] },
  { id: 2, feed: 1, slug: "personal", name: "Personal (title only)", color: "#43A047FF", privacy: "title-only", kind: "passthrough", uid_mode: "auto", src: [2] },
  { id: 3, feed: 1, slug: "everything-busy", name: "Everything (busy)", color: "#757575FF", privacy: "busy-only", kind: "virtual", uid_mode: "auto", src: [1, 2, 3] },
  { id: 4, feed: 1, slug: "merged", name: "Work + Team (merged)", color: "#8E24AAFF", privacy: "full", kind: "virtual", uid_mode: "auto", src: [1, 3] },
  { id: 5, feed: 1, slug: "merged-raw-uids", name: "Work + Team (source UIDs)", color: "#F4511EFF", privacy: "full", kind: "virtual", uid_mode: "source", src: [1, 3] },
  { id: 6, feed: 2, slug: "big", name: "Big", color: "#000000FF", privacy: "full", kind: "passthrough", uid_mode: "auto", src: [4] },
];
for (const [i, p] of pubs.entries()) {
  await sql`insert into publication (id, feed_id, slug, name, color, privacy, kind, uid_mode, sort_order)
    values (${p.id}, ${p.feed}, ${p.slug}, ${p.name}, ${p.color}, ${p.privacy}, ${p.kind}, ${p.uid_mode}, ${i})`;
  for (const [prio, s] of p.src.entries()) await sql`insert into publication_source values (${p.id}, ${s}, ${prio})`;
}
const [c] = await sql<{ n: string }[]>`select count(*)::text as n from resource`;
console.log(`seeded ${c?.n} resources, ${pubs.length} publications`);
await sql.close();
