# Spike findings: feed output (Meridian)

Scope: risks R1–R5 from `docs/brief.md`, plus ICS feeds, privacy projections and client refresh behaviour. Everything under "verified by run" was produced by the code in this directory; raw output is in `evidence/`. Run date 2026-11-07, Bun 1.3.4, Postgres 18.6 (`spike_feed`), macOS host.

## 1. Summary

| # | Question | Verdict | Recommendation |
|---|---|---|---|
| 1 | WebDAV verbs on Bun + Hono (R1) | confirmed | Use `app.on([...verbs], path)`; parse XML with fast-xml-parser 5.12 plus our own 60-line namespace resolver. |
| 2 | Read-only CalDAV server, `epoch:seq` tokens (R2, R5) | confirmed with caveats | The design works, but a naive `max(seq)` token skipped 34% of concurrent changes. Fix it with a per-tenant `pg_advisory_xact_lock` taken before `nextval` (0 skips), and read the token and the rows in one snapshot. |
| 3 | Real clients (R2) | confirmed with caveats (Apple: verified by docs) | python `caldav` 3.7.0, vdirsyncer 0.19.3 and tsdav 2.5.0 all discover, read and sync incrementally (including deletes), and recover after an epoch bump. Apple's requirements come from docs and a Radicale diff and were not run against Apple software. Thunderbird and Evolution were not tested. |
| 4 | iCalendar library (R3) | confirmed with caveats | ical.js 2.2.1 for parse and serialise, storing jCal. Generate VTIMEZONE from `Intl` over the span the data needs. Do not use ical.js for UTC↔zone arithmetic near DST transitions. Rejected: ts-ics (lossy) and the tzurl-based VTIMEZONE packages (stale). |
| 5 | UIDs, merges, dedupe (R4) | confirmed | Passthrough + `full` keeps the source UID. Virtual publications rewrite UIDs deterministically so a feed never repeats a UID across collections. `title-only`/`busy-only` use an HMAC rewrite. Merge copies per component: organizer's copy, then SEQUENCE, then LAST-MODIFIED, then source priority. |
| 6 | ICS feed | confirmed | 5,000 events render in about 200 ms (2.8 MiB raw, 80 KiB gzip, 19 KiB br on synthetic data). Cache the compressed body keyed by an ETag built from `pubId.epoch.seq`; a 304 needs no render. |
| 7 | Privacy projections | confirmed | Allowlist per mode, never a blocklist. Strip VALARM by default (`keep_alarms` opt-in). Busy-only drops TRANSP:TRANSPARENT. CLASS:PRIVATE/CONFIDENTIAL drops a title-only publication to busy for that event. |
| 8 | Client refresh, subscribe links, `.mobileconfig` | verified by docs (profile: lint verified by run) | Expect Google/Outlook ICS refresh to take hours and ignore our hints; only sinks give freshness. The unsigned CalDAV `.mobileconfig` passes `plutil -lint`. Apple documents manual install of unsigned profiles on iOS; not tested on a device. |

## 2. Per question

### Q1. WebDAV verbs on Bun + Hono (R1): confirmed

What I did: `src/r1-verbs.ts` registers PROPFIND, REPORT, OPTIONS, PROPPATCH and MKCALENDAR with `app.on([...], "/dav/*")` on `Bun.serve`. It sends each verb with an XML body and `Depth: 1`, then sends a chunked PROPFIND via curl.

Evidence (`evidence/r1-verbs.txt`):

    PROPFIND 207 PROPFIND depth=1 bodylen=82
    REPORT 207 REPORT depth=1 bodylen=82 ...
    curl chunked PROPFIND -> HTTP/1.1 207 Multi-Status | X-Body-Len: 82

Bun passes custom verbs, bodies and `Depth` through, and emits the `Multi-Status` reason phrase. The only snag is on the client side: Bun's `fetch` refuses a body on OPTIONS.

XML: fast-xml-parser does not resolve namespaces. It keeps raw prefixes, and `removeNSPrefix` throws them away, so a `Z:prop` in a foreign namespace merges with `D:prop` (`test/xml.test.ts`). `src/xml.ts` parses with `preserveOrder` and resolves every element to `{ns, name}` by tracking `xmlns` declarations. The test covers the default namespace, `D:`/`C:` prefixes and prefixes redeclared mid-tree. Output is string-built with fixed prefixes (`d`, `cal`, `cs`, `ical`) declared once on the root.

Impact on brief: none. R1 is closed.

### Q2. Read-only CalDAV server and sync tokens (R2, R5): confirmed with caveats

What I built: a read-only CalDAV server on Hono backed by Postgres (`src/dav.ts`, `src/store.ts`, `src/schema.sql`), seeded by `src/seed.ts`. It serves:

- `/.well-known/caldav` with a 301 and no auth
- PROPFIND on `/`, `/dav/`, the principal, the home, calendars and objects, with `current-user-principal`, `principal-URL`, `calendar-home-set`, `calendar-user-address-set`, `displayname`, Apple `calendar-color`/`calendar-order`, CS `getctag`, `sync-token`, `supported-calendar-component-set` (VEVENT), `supported-report-set` and a read-only `current-user-privilege-set` (`read`, `read-current-user-privilege-set`)
- REPORT `calendar-query` (VEVENT time-range), `calendar-multiget` and `sync-collection`
- GET/HEAD objects with ETag/304
- 403 `need-privileges` for every write verb
- Basic auth against a per-feed argon2id app password, with successful verifications cached for 5 minutes (each verify costs tens of ms and clients send Basic on every request)

Token design as implemented:

- The global sequence `change_seq` stamps `resource.seq` on every upsert or tombstone.
- The publication token is `http://supercal.invalid/ns/sync/<pubId>/<epoch>/<maxSeq>`, and getctag uses the same value.
- `publication.epoch` is bumped on any membership or projection change. A token with an old epoch, or a seq below `settings.tombstone_floor`, gets `403 <d:error><d:valid-sync-token/></d:error>` (RFC 6578 §3.2).
- Deletions are tombstones (`resource.deleted`). In a virtual publication a UID is reported deleted only when every copy is gone.

The concurrency trap, reproduced (`test/sync-race.ts`, `evidence/q2-sync-race.txt`): 8 writers × 40 inserts, each pausing 0–15 ms between `nextval` and COMMIT, while a reader follows the token chain.

    mode=naive  ... committed=320 reported=212 SKIPPED=108
    mode=locked ... committed=320 reported=320 SKIPPED=0  (3.6s)
    mode=xmin   ... committed=320 reported=320 SKIPPED=0 repeats=325 (0.5s)

- **naive** skips: a transaction that takes seq 101 and commits after another transaction's seq 102 has already been handed out in a token is never reported.
- **locked**: `recordChange` runs `pg_advisory_xact_lock(tenant_id)` before `nextval`, so a tenant's seqs are handed out in commit order. A publication only spans one tenant, so the publication's `max(seq)` is a safe watermark. The cost is that a tenant's writes are serialised. The test is the worst case (it pauses while holding the lock); in the product the lock should be the last thing before COMMIT, after all fetching and parsing.
- **xmin**: the alternative with no lock. Each row stores `xid = pg_current_xact_id()`, the token is `pg_snapshot_xmin(pg_current_snapshot())`, and a sync returns rows with `xid >= token`. Nothing can be missed, but changes get re-sent. Any long-running transaction in the cluster holds the watermark back and inflates the re-sends, and the token stops being `epoch:seq`.
- **Second trap**: the token must come from the same snapshot as the changed rows. `store.view()` reads both in one statement. Reading `max(seq)` in a separate query after the rows can also skip changes.

Impact on brief:

- The change-log design stands, with three additions: (a) the per-tenant advisory lock inside the single `recordChange` write path; (b) tombstones plus a purge floor; (c) a cheap per-object ETag.
- The spike computes ETags by rendering every object. A PROPFIND Depth 1 over 5,000 objects took 0.24–0.29 s (`evidence/q6-ics-bench.txt`), paid on every poll by etag-listing clients such as vdirsyncer. Derive the ETag as `hash(pubId, epoch, uid, max(seq of copies), projectionVersion)` without rendering.
- Object hrefs are hashes of the output UID and cannot be reversed. The product needs a `publication_item(publication_id, href, source_uid)` lookup, or a per-request map, which is what the spike builds.
- Time-range filtering uses a coarse `span tstzrange` (first start to last end, infinity for open-ended RRULEs). It can return false positives, which RFC 4791 tolerates in practice. Exact filtering needs expansion.

### Q3. Real clients (R2): confirmed with caveats

All three clients ran headless against `localhost:5232`. Each test reseeds the database, changes data server-side with `src/mutate.ts` and syncs again.

python `caldav` 3.7.0 (`clients/caldav_lib.py`, `evidence/q3-python-caldav.txt`):

    work privileges: ['{DAV:}read', '{DAV:}read-current-user-privilege-set']
    initial sync: 6 objects, token http://supercal.invalid/ns/sync/1/1/6
    incremental sync after update+delete+add: ['<deleted> .../z_iEV4cewHi5j6dn8inqzt.ics', 'Holidays (edited)', 'Brand new']
    after epoch bump, lib returned 6 objects, token fake-0758...

After the epoch bump the server returned 403, and the library fell back to a full listing with a synthetic token (server log: `REPORT .../work/ 0 403`).

vdirsyncer 0.19.3 (`clients/vdirsyncer.sh`, `evidence/q3-vdirsyncer.txt`):

- Five collections were discovered and synced to disk.
- After an update, a delete and an add, the second sync transferred exactly those three items per affected collection (`Copying (updating) item allday@...`, `Deleting item floating@...`, `Copying (uploading) item new-one@...`). Untouched collections such as `personal` transferred nothing.
- vdirsyncer does not use sync-collection. It lists ETags with PROPFIND Depth 1 and fetches with `calendar-multiget` (`evidence/q3-vdirsyncer-serverlog.txt`), so ETag stability is what makes it incremental.

tsdav 2.5.0 (`clients/tsdav.ts`, `evidence/q3-tsdav.txt`):

    reports=calendarQuery,calendarMultiget,syncCollection comps=VEVENT
    webdav sync: created 0 updated 1 deleted 1 new token .../1/1/5013
    after epoch bump: created 0 updated 1 deleted 1 token .../1/2/5013

tsdav handles the 403 by resyncing from scratch and diffing against its local objects. A tsdav quirk: `smartCollectionSync` needs `objectMultiGet: calendarMultiGet` set on the collection by hand.

Same UID in two collections of one account (`merged-raw-uids` keeps source UIDs that also appear in `work`):

- The caldav library, vdirsyncer and tsdav all treat collections independently, with no confusion.
- From the docs: RFC 4791 §4.1 and §5.3.2.1 scope UID uniqueness to one collection, but:
  - iCloud's server rejects the same UID in a second collection (https://gitlab.gnome.org/GNOME/gnome-calendar/issues/304, https://bugzilla.mozilla.org/show_bug.cgi?id=1873834).
  - KOrganizer shows only one of the copies (https://bugs.kde.org/show_bug.cgi?id=426248).
  - Thunderbird shows one per calendar (https://bugzilla.mozilla.org/show_bug.cgi?id=1376787).
  - I found no report on Apple Calendar either way. Apple's own server forbidding it is the warning sign. This drives the Q5 decision.

Apple Calendar (verified by docs plus a Radicale diff, not run). Sources: https://sabre.io/dav/clients/ical/, https://sabre.io/dav/building-a-caldav-client/, https://sabre.io/dav/service-discovery/, RFC 4791 §5.1, https://bugzilla.mozilla.org/show_bug.cgi?id=1665203 (privilege-set-driven read-only). What we must emit, all of which the spike already does:

- `/.well-known/caldav` → 301/303/307
- `DAV: 1, 3, calendar-access` on OPTIONS and on 207 responses
- Depth 0 principal PROPFIND answering `current-user-principal`, `principal-URL`, `calendar-home-set` and `calendar-user-address-set`. 404s for `schedule-inbox-URL`, `schedule-outbox-URL` and `dropbox-home-URL` are fine; Radicale returns the same 404s and works with Apple.
- Depth 1 on the home answering `resourcetype` (collection + calendar), `displayname`, CS `getctag`, `sync-token`, `calendar-color` (`#RRGGBBAA`), `calendar-order`, `supported-calendar-component-set`, and a `current-user-privilege-set` without `write`/`write-content` (this is what makes Apple show the calendar read-only)
- Trailing slashes on every collection href

Product requirements on top of that:

- Serve over HTTPS; Apple is reported not to send Basic credentials over plain HTTP.
- Restrict usernames to `[a-z0-9-]` (`%` breaks Apple).

The property-by-property diff against Radicale is in `evidence/q3-radicale-diff.md`. It differs only in extras we add (colour, order, description) and in Radicale's `max-resource-size` and `CS:source`. Apple's sync method (ctag+etag versus sync-collection) is not documented, so support both, as the spike does. Not done: principal `expand-property` and `principal-property-search` (delegation UI), and Thunderbird/Evolution. Next step: run Thunderbird headless with a profile pointing at the server, or test from the VM once an owned macOS VM is available. The only macOS VM on this host is reserved for Bobby Tables.

### Q4. iCalendar library (R3): confirmed with caveats

Fixture `fixtures/tricky.ics` contains:

- a recurring master with EXDATE, a RECURRENCE-ID override and a `RANGE=THISANDFUTURE` override
- an all-day event, a floating daily RRULE with a floating UNTIL, and a UTC UNTIL
- an event that starts in New York and ends in Berlin
- RFC 7986 NAME, REFRESH-INTERVAL, COLOR and CONFERENCE (multi-valued FEATURE)
- X-props with params (X-APPLE-STRUCTURED-LOCATION)
- quoted CN with a comma, TEXT escaping, and a 75-octet fold through multi-byte UTF-8

Roundtrip parse → serialise, diffing normalised content lines (`src/q4-ical.ts`, `evidence/q4-roundtrip.txt`):

| Library (version, weekly downloads) | Lines lost/changed | Notes |
|---|---|---|
| **ical.js 2.2.1** (1.35M) | 2 | Re-escapes an unescaped `;` in TEXT, which is correct. Quotes `FEATURE="AUDIO,VIDEO"`, which turns a multi-value into one value; fixed by registering `design.icalendar.param.feature = {multiValue: ","}`. Keeps every X-prop and param, keeps THISANDFUTURE, expands overrides and THISANDFUTURE correctly, folds UTF-8 safely. |
| ts-ics 2.4.8 (120k) | 33 | Drops NAME, REFRESH-INTERVAL, COLOR, CONFERENCE and all X-props unless each is declared. Turns floating times into UTC. Emits `CN=Doe, Jane` unquoted, which is invalid. Rejected. |
| @sdxc/icalendar 2026.11.3 (270) | 7 | Drops `RANGE=THISANDFUTURE`, which changes meaning. Six weeks old and pulls in `remix` + CLI deps (98 packages). Rejected as a dependency, but its Intl VTIMEZONE approach is the right one. |
| ical-generator 11.1.3 (1.0M) | n/a | Generate-only, so it cannot pass unknown source properties through. Given a JS `Date` with `timezone: "Europe/Berlin"` it wrote host-local wall time (09:00Z → `TZID=Europe/Berlin:…T020000` on an MST host). |
| node-ical 0.27.5 (510k) | n/a | Parse-only. |

VTIMEZONE from IANA names (`src/q4-vtimezone.ts`, `evidence/q4-vtimezone.txt`):

- Method: each generator's VTIMEZONE was loaded into ical.js and the UTC offset compared with `Intl` every 6 h, over 15 zones, for 2015–19 and 2025–34.
- Zones with real errors, i.e. beyond the ical.js transition artefact described below:
  - `timezones-ical-library` 2.4.0: 8/15 historically, 4/15 in 2025–34 (Casablanca, Santiago, Nuuk, Gaza). It ships only current rules.
  - `@touch4it/ical-timezones` 1.9.0: 7/15 and 9/15. It has stale data (Sao Paulo and Mexico City still on DST, Tehran wrong) and no Kyiv or Nuuk.
  - Intl-generated, span-bounded VTIMEZONE (@sdxc's `vtimezone()`): leaves only ≤1 mismatched sample per transition. That is the same pattern ical.js produces with the hand-written New York VTIMEZONE, so it is the evaluator's artefact, not the generator's.

ical.js caveats found:

- **UTC → zone conversion is wrong in the hours before a DST transition.** `2026-03-08T05:30Z` gives New York `01:30` (Intl: `00:30`), and `2026-11-01T05:30Z` gives `00:30` (Intl: `01:30`) (`evidence/q4-icaljs-transition.txt`). Rendering is unaffected because we emit TZID and wall time unchanged. Range columns and expansion must convert with `Intl`/Temporal instead of ical.js.
- **`getAllProperties()` / `getAllSubcomponents()` return live arrays.** Removing while iterating skips every other item. My first projection leaked LOCATION and ATTENDEE in busy-only until `test/model.test.ts` caught it.

Recommendation: ical.js 2.2.1 is the parse and serialise engine. Store jCal (RFC 7265) in jsonb, so unknown properties survive by construction. Only `packages/core` touches jCal, through typed accessors:

    type EventResource = {
      uid: string;
      master: JCal | null;               // null when we only hold detached instances
      overrides: JCal[];                 // VEVENTs with RECURRENCE-ID
      timezones: Record<string, JCal>;   // VTIMEZONEs as the source supplied them
    };

VTIMEZONE policy:

- Pass through the source's VTIMEZONE when there is one (CalDAV/ICS sources).
- When the source gives only an IANA name (Google/Graph JSON), generate one from `Intl` over [earliest DTSTART, max(UNTIL, now + 2y)]. That is an in-house module of about 80 lines modelled on @sdxc's.
- Correctness then depends on the tzdata in Bun's ICU, so keep Bun current.

### Q5. UIDs, hrefs, merges (R4): confirmed

Decision (`outputUid` in `src/store.ts`):

| Publication | Output UID | Why |
|---|---|---|
| passthrough, `full` | source UID verbatim | Fidelity. Matches what the same client sees from the provider directly. |
| virtual, `full` | `base64url(sha256(pubId‖uid))[:26]@supercal` | Never repeats a UID across collections of one feed (iCloud forbids it, KOrganizer dedupes it), and stays stable while the source UID is stable. |
| any, `title-only`/`busy-only` | `base64url(hmac(feed.secret, pubId‖uid))[:26]@supercal` | Source UIDs can embed hosts or emails, and busy feeds shared with different people must not be correlatable. |

- Href: `<collection>/<base64url(sha256(outputUid))[:22]>.ics`. It is stable, URL-safe, and identical across clients. It needs the `publication_item` lookup mentioned in Q2.
- Same meeting in two sources of a virtual publication: dedupe by source UID. Pick a winner **per component** (master and each RECURRENCE-ID) by:
  1. the copy whose ORGANIZER equals the source account's address
  2. higher SEQUENCE
  3. later LAST-MODIFIED/DTSTAMP
  4. lower `publication_source.priority`

  Overrides are unioned, which covers attendees invited to only one instance. Verified by `test/model.test.ts` and by the seeded meetings A and B: the organizer copy of A wins despite a lower SEQUENCE, and B's newest SEQUENCE wins.
- Combined ICS feed (`/ics/<token>/all.ics`): dedupe by source UID, first publication by `sort_order` wins (`evidence/q6-combined-feed-dedupe.txt`: every UID appears once). Follow-up: apply the merge rules across publications instead of first-wins, because a passthrough can carry the stale copy.

### Q6. ICS feed: confirmed

`src/ics.ts` serves `/ics/<secret>/<slug>.ics` and `/ics/<secret>/all.ics`:

- The secret is looked up by SHA-256, and a wrong token gives 404.
- Headers: `ETag: "<pubId>.<epoch>.<seq>"` (one segment per publication) and `Last-Modified` = max `changed_at`. Both are computed with a single aggregate query, so 304s (If-None-Match and If-Modified-Since) never render.
- `Vary: Accept-Encoding`, br (quality 5) or gzip.
- Body: `NAME`, `X-WR-CALNAME`, `REFRESH-INTERVAL;VALUE=DURATION:PT1H` and `X-PUBLISHED-TTL:PT1H`.
- `X-WR-TIMEZONE` is deliberately omitted. Every timed value carries a TZID+VTIMEZONE or is UTC, and the header is commonly reported to make Google/Apple reinterpret floating times (unsourced).
- webcal is the same URL with the `webcal://` scheme.

5,000-event publication (`test/ics-bench.ts`, `evidence/q6-ics-bench.txt`):

    5000 resources | db+merge 79–92ms | full render 201–206ms | raw 2830 KiB | gzip 80 KiB in 4–5ms | br q5 19 KiB in 5–7ms
    GET identity 200 2897793 bytes 229ms (cache miss); GET gzip 200 81672 bytes 9ms (cached); GET br 200 19798 bytes 9ms
    GET If-None-Match 304 3ms; GET If-Modified-Since 304 2ms

The synthetic events repeat a lot, so expect real feeds to compress about 5–8×, not 35×.

Decision: cache rendered output keyed by the ETag. Rendering costs about 200 ms of CPU per 5k events, Google and Outlook poll anonymously, and the key is exact and free to compute. Cache only the compressed variants (raw is 2.8 MiB per 5k events), and evict on NOTIFY. The ETag must also carry a publication config version, so that a rename changes `X-WR-CALNAME` without bumping the epoch (which would force CalDAV clients into a full resync).

### Q7. Privacy projections: confirmed

`src/model.ts` (`project`) uses per-mode allowlists:

- busy-only keeps UID, DTSTAMP, DTSTART/DTEND/DURATION, RRULE/RDATE/EXDATE, RECURRENCE-ID, SEQUENCE, STATUS, TRANSP, CLASS, CREATED and LAST-MODIFIED, and sets `SUMMARY:Busy`.
- title-only also keeps SUMMARY and COLOR.
- Everything else goes: description, location, attendees, organizer, attach, conference, URL, GEO, all X-props, and all subcomponents.

Rules:

- busy-only drops TRANSP:TRANSPARENT masters (free time is not busy) and marks a transparent override of a busy series `STATUS:CANCELLED`.
- Source CLASS:PRIVATE/CONFIDENTIAL drops a title-only publication to busy for that event. `full` passes CLASS through, because the owner's own feed should show their private events.
- VALARM is stripped by default in every mode; `publication.keep_alarms` opts in. Source alarms already fire from the source account on the same device, so copying them duplicates every reminder.

Evidence: `test/model.test.ts` (10 pass, `evidence/unit-tests.txt`) and the rendered feeds in `evidence/q7-projections.txt`. In the latter, `everything-busy.ics` contains no LOCATION, DESCRIPTION, ATTENDEE, ORGANIZER, ATTACH or event-level X-props, and override titles do not leak. Follow-up: busy-only still exposes DTSTAMP, SEQUENCE and CLASS. Consider dropping CLASS, CREATED and LAST-MODIFIED there.

### Q8. Client refresh, subscribe links, Apple profile: verified by docs

| Client | ICS refresh | Honours REFRESH-INTERVAL / X-PUBLISHED-TTL | Source |
|---|---|---|---|
| Google Calendar (From URL) | Undocumented; community reports 6–24 h; no manual refresh | No (community) | https://support.google.com/calendar/answer/37100 |
| Outlook.com / OWA / new Outlook | About 3 h (Outlook.com) or about 6 h (OWA); "can take more than 24 h" | No (community) | https://support.microsoft.com/en-us/office/import-or-subscribe-to-a-calendar-in-outlook-com-or-outlook-on-the-web-cff1429c-5af6-41ec-a5b4-74f2c278e98c |
| Classic Outlook (Windows) | Publisher's interval by default; with "Update Limit" off, every Send/Receive | X-PUBLISHED-TTL yes (Outlook 2007-era doc; newer builds unverified) | https://technet.microsoft.com/en-us/library/cc179094(v=office.12) |
| Apple Calendar macOS | Per subscription "Auto-refresh"; CalDAV account has its own interval (Push or minutes) | Unverified | https://support.apple.com/guide/calendar/refresh-calendars-icl1024/mac |
| Apple iOS | Fetch New Data: Push/Fetch (15 min, 30 min, hourly, manual); subscriptions fetch only | Unknown | https://discussions.apple.com/thread/252298000 |
| Thunderbird | Per calendar refresh interval | REFRESH-INTERVAL not supported | https://bugzilla.mozilla.org/show_bug.cgi?id=1780209 |
| DAVx5 / ICSx5 | Per collection, Android minimum 15 min; ICSx5 sends conditional GETs | n/a | https://manual.davx5.com/settings.html, https://icsx5.bitfire.at/faq |

Subscribe links:

- Google: `https://calendar.google.com/calendar/render?cid=<url-encoded webcal:// or https:// URL>`. Undocumented, reported to need HTTPS (https://til.simonwillison.net/ics/google-calendar-ics-subscribe-link).
- Outlook: `https://outlook.live.com/calendar/0/addfromweb?url=<enc>&name=<enc>` and `https://outlook.office.com/calendar/0/addfromweb?...`. I found no source for these formats, so treat them as unverified and test them by hand.

`.mobileconfig`:

- `src/mobileconfig.ts` builds a `com.apple.caldav.account` payload with CalDAVAccountDescription, CalDAVHostName, CalDAVPort, CalDAVUseSSL, CalDAVPrincipalURL and CalDAVUsername (https://developer.apple.com/documentation/devicemanagement/caldav). PayloadUUIDs derive deterministically from the feed id.
- `plutil -lint evidence/supercal-meridian.mobileconfig` → `OK` (verified by run). The profile is unsigned.
- The password is omitted, so the device prompts for it at install and the downloaded file holds no credential.
- Unsigned install: Apple documents manual install on iOS (Safari download → Settings → Profile Downloaded → Install, within 8 minutes; https://support.apple.com/en-us/102400). It is shown as not verified (community). Serve it as `application/x-apple-aspen-config`.
- Not tested on a device. The macOS install path on 15/26 is unsourced.
- `com.apple.subscribedcalendar.account` exists for webcal subscriptions but Apple lists it for iOS only.

Impact on brief: confirms the delivery table. Google and Outlook freshness is outside our control and our hints are ignored, so sinks are the only way to get fast updates there.

## 3. Decisions I recommend

- **HTTP/XML:** Hono 4.13.x `app.on(["PROPFIND","REPORT"], ...)` on Bun.serve. Parse with fast-xml-parser 5.12.0 (`preserveOrder`) plus the namespace resolver in `src/xml.ts`. Build output as strings with fixed prefixes.
- **iCalendar:** ical.js 2.2.1, with `ICAL.design.icalendar.param.feature = { multiValue: "," }`, jCal stored in jsonb, and `EventResource { uid, master, overrides[], timezones }` as the only shape outside `packages/core`. Always copy `getAll*()` results before mutating.
- **Time math:** use `Intl`/Temporal for UTC↔zone conversion, not ical.js.
- **VTIMEZONE:** pass the source's through. Otherwise generate from `Intl` over the data's span (in-house module). No dependency on timezones-ical-library or @touch4it/ical-timezones.
- **Schema:**
  - `resource(source_calendar_id, uid, data jsonb, sequence, last_modified, organizer, span tstzrange, deleted, seq bigint, changed_at)`, with PK `(source_calendar_id, uid)`, a GiST index on `span` and a btree on `(source_calendar_id, seq)`
  - `publication(..., privacy, kind, keep_alarms, epoch, config_version)`
  - `publication_source(publication_id, source_calendar_id, priority)`
  - `publication_item(publication_id, href, source_uid)` for href lookup
  - a tombstone floor
- **Write path:** one `recordChange(tx, tenantId, ...)` function. It does `pg_advisory_xact_lock(tenant_id)`, then `nextval('change_seq')`, as the last statement before COMMIT. Nothing else writes `resource`.
- **Tokens:** sync-token and getctag = `https://<host>/ns/sync/<pubId>/<epoch>/<seq>`. Bump the epoch on membership or projection change. `403 valid-sync-token` for an old epoch or a seq below the floor. Read the token and the changes in one statement.
- **ETags:** object ETag = `hash(pubId, epoch, uid, max(seq of copies), projectionVersion)` with no render. ICS ETag = `pubId.epoch.seq.configVersion` per publication.
- **UIDs and merges:** the Q5 table; per-component merge (organizer → SEQUENCE → LAST-MODIFIED → priority); unioned overrides.
- **Projections:** allowlists; VALARM stripped by default; CLASS:PRIVATE/CONFIDENTIAL → busy in title-only; busy-only drops transparent events.
- **ICS:** `REFRESH-INTERVAL;VALUE=DURATION:PT1H` + `X-PUBLISHED-TTL:PT1H`, `NAME` + `X-WR-CALNAME`, no `X-WR-TIMEZONE`. Cache br and gzip bodies keyed by ETag; invalidate on NOTIFY.
- **Auth:** argon2id app password with a 5-minute cache of successful verifications, plus a rate limit on failures.
- **Apple onboarding:** an unsigned `.mobileconfig` without the password, served as `application/x-apple-aspen-config` over HTTPS. Usernames restricted to `[a-z0-9-]`.

## 4. New risks discovered

1. **Sync tokens skip commits in the naive design:** 34% of changes were lost in the race test. Fixed by the advisory lock, which serialises each tenant's writes, so keep those transactions short. If contention shows up, the xmin watermark is a lock-free fallback, but it re-sends rows and is sensitive to long-running transactions.
2. **ical.js converts UTC→zone wrongly near DST transitions** (off by 1 h). Any expansion or range code written with ical.js will be subtly wrong twice a year.
3. **ical.js live arrays caused a privacy leak.** Removing properties while iterating skipped every other one, and busy-only leaked LOCATION and ATTENDEE until a test caught it. Projections need allowlists plus tests that assert absence.
4. **Static VTIMEZONE packages are wrong** for many zones (Casablanca, Santiago, Nuuk, Gaza and others even in 2025–34). Correctness depends on the tzdata in Bun's ICU.
5. **Same UID across collections:** valid per RFC, but iCloud rejects it and KOrganizer dedupes it. A feed must not repeat UIDs across collections, and neither must the combined ICS file.
6. **Bun.SQL quirk:** a plain JS array bound as a parameter (`${ids}::int[]`) fails with "insufficient data left in message". `sql.array(ids, "int4")` works. Relevant to Gnomon and `packages/db`.
7. **Per-poll cost scales with calendar size.** Etag-listing clients (vdirsyncer, probably Apple between ctag changes) PROPFIND Depth 1 the whole collection. ETags must be precomputed or derivable without rendering.
8. **Argon2 on every CalDAV request** is a CPU and DoS vector, so we need the verification cache and failure rate limiting.
9. **Busy-only still leaks metadata:** DTSTAMP, SEQUENCE and CLASS reveal edit times and private flags, and source UIDs would leak without the HMAC rewrite.
10. **HTTPS is required for Apple.** Self-hosters on plain HTTP or a LAN will not get Apple Calendar to authenticate, so document this.
11. **Combined-feed precedence:** first-wins can surface a stale copy. Use the merge rules across publications.
12. **Coarse time-range filter** (`span`) returns long-running recurring series for every query window. That is harmless for correctness but costly for big recurring sets; exact filtering needs bounded expansion.
13. **Library footguns to avoid:** ts-ics turns floating times into UTC and emits invalid unquoted params. ical-generator writes host-local wall time under a foreign TZID when given a JS `Date`.

## 5. How to rerun

    cd spikes/feed
    bun install
    ./run-evidence.sh        # ~2.5 min; regenerates evidence/ (starts/stops the server on :5232)

Individual pieces:

    bun src/r1-verbs.ts                         # Q1
    bun test                                    # XML namespace + projection/merge unit tests
    bun src/q4-ical.ts; bun src/q4-vtimezone.ts # Q4 (vtimezone ~90 s)
    bun src/seed.ts && bun src/server.ts        # seed spike_feed, serve on :5232 (LOG=1 for request log)
    bun test/sync-race.ts naive|locked|xmin     # Q2 race
    uv run --with caldav==3.7.0 python clients/caldav_lib.py
    clients/vdirsyncer.sh                       # uvx vdirsyncer@0.19.3
    bun clients/tsdav.ts
    bun clients/diff-radicale.ts                # needs hare:55232 (run-evidence.sh creates meridian/feedref)
    bun test/ics-bench.ts                       # Q6, server must be running
    bun src/mobileconfig.ts | xargs plutil -lint

Seed credentials: CalDAV `meridian` / `meridian-app-pw` (feed 1) and `bench` / `bench-pw` (feed 2, 5,000 events); ICS secrets `ics-meridian-secret` and `ics-bench-secret`. The `evidence/*-serverlog.txt` files and the two `evidence/q4-icaljs-*.txt` probes came from one-off runs and are not regenerated by the script.
