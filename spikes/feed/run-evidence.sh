#!/bin/sh
# Reproduce every piece of evidence in evidence/. Needs: bun, uv, Postgres at hare:55432/spike_feed,
# Radicale at hare:55232. Starts the spike server on :5232 and stops it at the end.
set -e
cd "$(dirname "$0")"
E=evidence
bun install --frozen-lockfile >/dev/null
bun src/r1-verbs.ts > $E/r1-verbs.txt
bun test > $E/unit-tests.txt 2>&1
bun src/q4-ical.ts > $E/q4-roundtrip.txt
bun src/q4-vtimezone.ts > $E/q4-vtimezone.txt            # ~90 s
bun src/seed.ts
PORT=5232 bun src/server.ts >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER' EXIT
sleep 1
(bun test/sync-race.ts naive; bun test/sync-race.ts locked; bun test/sync-race.ts xmin) > $E/q2-sync-race.txt
bun src/seed.ts >/dev/null
uv run --quiet --with caldav==3.7.0 python clients/caldav_lib.py > $E/q3-python-caldav.txt 2>&1
clients/vdirsyncer.sh > $E/q3-vdirsyncer.txt 2>&1
bun src/seed.ts >/dev/null
bun clients/tsdav.ts > $E/q3-tsdav.txt 2>&1
bun src/seed.ts >/dev/null
# reference calendar on Radicale (idempotent)
curl -s -u meridian:x -X MKCALENDAR http://hare:55232/meridian/feedref/ >/dev/null || true
printf 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VEVENT\r\nUID:ref-1@example.com\r\nDTSTAMP:20261101T000000Z\r\nDTSTART:20261110T100000Z\r\nDTEND:20261110T110000Z\r\nSUMMARY:ref\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n' | curl -s -u meridian:x -X PUT -H 'Content-Type: text/calendar' --data-binary @- http://hare:55232/meridian/feedref/ref-1.ics >/dev/null
bun clients/diff-radicale.ts > $E/q3-radicale-diff.md
bun test/ics-bench.ts > $E/q6-ics-bench.txt
curl -s http://localhost:5232/ics/ics-meridian-secret/all.ics | grep -E '^(SUMMARY|UID)' | paste - - | sort | uniq -c | sort -rn > $E/q6-combined-feed-dedupe.txt
for s in work personal everything-busy merged; do echo "=== $s.ics"; curl -s http://localhost:5232/ics/ics-meridian-secret/$s.ics | grep -vE '^(TZOFFSET|TZNAME|RRULE:FREQ=YEARLY|BEGIN:(DAYLIGHT|STANDARD)|END:(DAYLIGHT|STANDARD))'; done > $E/q7-projections.txt
F=$(bun src/mobileconfig.ts) && plutil -lint "$F" > $E/q8-mobileconfig-lint.txt
echo done
