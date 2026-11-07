// Server-side changes for client tests.
//   bun src/mutate.ts update <sourceId> <uid> <new summary>
//   bun src/mutate.ts add <sourceId> <uid> <summary>
//   bun src/mutate.ts delete <sourceId> <uid>
//   bun src/mutate.ts bump-epoch <publicationId>
import { resourcesFromIcs, type EventResource } from "./model";
import { recordChange, sql } from "./store";

const [cmd, a = "", b = "", ...rest] = process.argv.slice(2);
const text = rest.join(" ");

if (cmd === "update") {
  const [row] = await sql<{ data: EventResource }[]>`select data from resource where source_calendar_id = ${Number(a)} and uid = ${b}`;
  if (!row?.data.master) throw new Error("no such resource");
  const master = row.data.master;
  // jCal: [name, props[], comps[]]; props are [name, params, type, value]
  const props = master[1] as unknown[][];
  for (const p of props) if (p[0] === "summary") p[3] = text;
  for (const p of props) if (p[0] === "sequence") p[3] = Number(p[3]) + 1;
  await sql.begin((tx) => recordChange(tx, 1, Number(a), row.data));
} else if (cmd === "add") {
  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VEVENT\r\nUID:${b}\r\nDTSTAMP:20261107T000000Z\r\nDTSTART:20261118T100000Z\r\nDTEND:20261118T110000Z\r\nSUMMARY:${text}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  const [r] = resourcesFromIcs(ics);
  if (r) await sql.begin((tx) => recordChange(tx, 1, Number(a), r));
} else if (cmd === "delete") {
  await sql.begin((tx) => recordChange(tx, 1, Number(a), { uid: b, deleted: true }));
} else if (cmd === "bump-epoch") {
  await sql`update publication set epoch = epoch + 1 where id = ${Number(a)}`;
} else {
  console.error("usage: update|add|delete|bump-epoch ...");
  process.exit(2);
}
console.log("ok", cmd, a, b, text);
await sql.close();
