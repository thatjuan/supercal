# Astrolabe: ingestion spike

Evidence collected 2026-11-07. Runtime: Bun 1.3.4 (5eb2145b), macOS; shared Radicale at `http://hare:55232/`. All code and artifacts are confined to this directory. No real Google/Microsoft accounts, OAuth credentials, email, database, or extra containers were used. Live provider evidence is Radicale only; Google/Graph behavior below is documentation plus synthetic fixtures, explicitly not a live integration certification.

## Summary

| Question | Verdict | Recommendation |
|---|---|---|
| 1. Generic CalDAV discovery, initial/incremental/fallback sync | confirmed with caveats | Use `tsdav@2.5.0` protocol primitives with our guarded transport and our own transactional sync state; retain the thin client as a readable reference. |
| 2. Provider quirks | verified by docs | Discover capabilities per collection; several vendors do not publish sync support or numeric DAV limits. Do not turn unknowns into guarantees. |
| 3. ICS URL ingestion and SSRF | confirmed with caveats | Resolve, classify, and dial the vetted address; on Bun 1.3.4 explicitly validate the original TLS hostname and reject ambient proxy environments. |
| 4. Google sync, push, OAuth and mapping | verified by docs | Store masters and exceptions separately in raw cache, merge before emitting a resource, renew channels and reconcile periodically. Fixtures pass. |
| 5. Graph recurrence mapping and sync | confirmed with caveats | Common mappings pass fixtures; unbounded `events/delta` in v1.0 is **rejected**. Cancellation cold starts and several recurrence edge cases remain unverified. |
| 6. Sinks | verified by docs | Google secondary-calendar sink is feasible for v1 with `calendar.app.created`; defer general Graph recurrence mirroring unless a bounded occurrence horizon is accepted. |
| 7. Adapter interface | confirmed with caveats | Use complete replacement resources and opaque typed cursors; CalDAV and ICS implementations run. Google/Graph adapters and push delivery are not implemented. |

Final verification: **54 tests pass, 0 fail, 117 assertions**, strict typecheck passes, live Radicale run passes and deletes its temporary calendar. See [test output](evidence/tests.txt), [typecheck](evidence/typecheck.txt), [live output](evidence/radicale.txt), and [bundle measurement](evidence/bundle.txt).

## 1. CalDAV: R8

### What ran

`src/radicale-run.ts` discovers `/.well-known/caldav`, reads `current-user-principal`, then `calendar-home-set`; creates a uniquely named collection under `/astrolabe/` using MKCALENDAR; seeds two PUT resources (a recurring master with a moved override, and an all-day event); and deletes the collection in `finally`. The thin client fetches display name, Apple color, ctag, sync token, supported components and supported reports. Initial calendar-query and initial sync-collection both run; changed objects are fetched with calendar-multiget.

The run modifies the recurring resource and deletes the all-day object, checks RFC 6578 sync on both clients, then checks both fallback paths. The custom fallback checks ctag, lists ETags, diffs, and multigets only changed objects. A forced invalid token proves a full reset. The `CalDavAdapter` also lists and normalizes the live collection.

Exact command from this directory: `bun run radicale`. Key actual output:

```text
discovery { principal: "http://hare:55232/astrolabe/", home: "http://hare:55232/astrolabe/" }
CalDavAdapter normalized resources 2
custom initial { objects: 2, seriesComponents: 2, fullResync: true }
custom incremental { upserts: 1, deletes: [".../day.ics"], tokenAdvanced: true }
tsdav incremental { updated: 1, deleted: 1 }
tsdav fallback { updated: 1, deleted: 1 }
fallback { changed: 1, deleted: 1, ctagUnchangedSkips: true }
invalid sync token { fullResync: true, objects: 1 }
PASS Radicale CalDAV discovery/query/multiget/incremental/delete/fallback/token reset
cleanup own calendar 200
```

The quoted deletion path is abbreviated here; [the saved output](evidence/radicale.txt) contains the exact temporary path. Fixtures additionally exercise absent ctag, unsupported sync report (501), authentication failure, and concurrent/missing multiget objects. Failed or incomplete responses do not return a cursor or masquerade as deletion.

### Comparison and choice

| Concern | `tsdav@2.5.0` | Thin `fetch` + `fast-xml-parser@5.12.0` |
|---|---|---|
| Radicale correctness | Discovery, metadata, full fetch, sync updates/deletes and basic fallback passed. | Same, plus explicit invalid-token reset and failure fixtures. |
| Types | Public API has useful types, but `DAVObject.data` and portions of XML/report data use `any`; validate/narrow at our boundary. | Own DTOs are strict, XML parser output is immediately treated as `unknown`. No `any` in spike source. |
| Control | Custom fetch is supported; smart sync needs callbacks and ownership of state remains ours. | Explicit failure handling, changed-only multiget, guarded requests; easy to inspect. |
| Minified Bun bundle | 99,048 bytes; gzip 31,138. | 71,399 bytes; gzip 24,138. |
| Maintenance | Existing discovery/provider knowledge and protocol helpers. | Namespace-URI correctness, interoperability, batching and report truncation become our work. |

Measurement: `bun run bundle`, Bun target, minified, followed by gzip. These entry points expose different API breadth; this is directional evidence, not an apples-to-apples application bundle. Seven kilobytes gzip is insignificant for a daemon.

A first `smartCollectionSyncDetailed` call failed without `objectMultiGet`; [the captured failure](evidence/tsdav-missing-callback.txt) is real, then the explicit `objectMultiGet: dav.calendarMultiGet` call passed. Its basic path requires `fetchObjects` and fetches calendar objects after a dirty ctag; the thin client minimizes payload using an ETag-only listing first. See [tsdav documentation](https://tsdav.vercel.app/intro/) and [service discovery](https://tsdav.vercel.app/webdav/account/servicediscovery/).

**Recommendation:** adopt tsdav's low-level discovery/report helpers, not its collection object as the durable database model. Adapt its injected fetch to the guarded transport and validate outputs. This composition has not itself been run: the guarded thin client and unmodified tsdav each passed against the trusted lab. Keep our cursor transaction, ETag diff, full-resync semantics and retry policy outside the library. Before release run the resulting adapter on two structurally different servers and real iCloud/Fastmail accounts.

The custom client is a spike, not a production implementation: it strips namespace prefixes without verifying namespace URIs, does not batch large multigets, and does not implement truncated RFC 6578 responses. It fails rather than committing incomplete state. [RFC 6578](https://www.rfc-editor.org/rfc/rfc6578) specifies invalid-token recovery, per-resource deletion status and limits/truncation; those must be covered before deployment. No second server was provisioned; this optional interoperability check remains unverified.

**Architecture impact:** retain the brief's CalDAV adapter, but negotiate sync per collection, retain the ETag fallback, and commit object changes with the cursor atomically. Never infer deletions from auth failure, malformed XML or incomplete pages. Treat provider credentials as bound to approved origins: the current guard strips them on cross-origin redirect, so iCloud partition transitions need an explicit trusted-host policy, not arbitrary forwarding.

## 2. Provider quirks: R8

“Unknown” below means no authoritative guarantee was established from the cited material. It does not mean unsupported. Probe `supported-report-set`, then use the fallback on a definite unsupported response. No numeric limit found means **unknown**, not unlimited. Except Radicale, these are documentation findings rather than account tests.

| Provider | Endpoint / discovery | Auth | sync-collection | Quirks | Rate limits |
|---|---|---|---|---|---|
| iCloud | `https://caldav.icloud.com/`, discover principal/home; never hardcode a partition host | Apple app-specific password, requires 2FA | Not officially verified here; negotiate | Partition redirects are an interoperability requirement to test, not a proven behavior from this run. Apple documents app-password creation/revocation. | No numeric DAV cap verified. [Apple](https://support.apple.com/en-us/102654), [tsdav provider guide](https://tsdav.vercel.app/cloud-providers/) |
| Fastmail | `https://caldav.fastmail.com/` | Account name + app password over TLS | Cyrus implements RFC 6578; Fastmail deployment support inferred, not live-verified | Basic plan excludes CalDAV; use published server discovery. | No numeric cap verified. [Fastmail](https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports), [Cyrus RFC support](https://www.cyrusimap.org/imap/rfc-support.html) |
| Nextcloud | Root well-known redirect to `/remote.php/dav/`; discover home | Password or app token, particularly with 2FA | Current server source installs Sabre Sync plugin | Reverse-proxy well-known redirects must be configured; deployment version matters. | Instance/admin-specific. [Client setup](https://docs.nextcloud.com/server/latest/user_manual/en/groupware/sync_osx.html), [proxy configuration](https://docs.nextcloud.com/server/latest/admin_manual/configuration_server/reverse_proxy_configuration.html), [server source](https://raw.githubusercontent.com/nextcloud/server/master/apps/dav/lib/Server.php) |
| Yahoo | `https://caldav.calendar.yahoo.com/` | Yahoo ID + generated app password | Unknown; negotiate | Use calendar endpoint rather than mail endpoint. | No numeric cap verified. [Yahoo setup](https://help.yahoo.com/kb/mail/SLN3850.html) |
| Zoho | Region-specific `calendar.zoho.*`; published calendar URL `/caldav/{calendarId}/events/`, or supported discovery | Account password / app-specific password for 2FA | Unknown; negotiate | CalDAV must be enabled for selected calendars; app calendars unsupported; calendar creation via CalDAV unsupported. Organization SRV discovery is separate from individual setup. | No numeric cap verified. [CalDAV setup](https://help.zoho.com/portal/en/kb/calendar/syncing-other-calendars/articles/setting-up-caldav-sync-in-zoho-calendar), [regional sync](https://www.zoho.com/calendar/help/sync-other-calendars.html), [autodiscovery](https://www.zoho.com/calendar/help/autodiscovery-setting-for-caldav-sync.html) |
| Synology | Copy CalDAV URL from Synology Calendar; DSM ports commonly 5000/5001 | DSM credentials, valid TLS certificate | Unknown; negotiate | QuickConnect is not a CalDAV endpoint; LAN hosts require operator allowance; username/client restrictions apply. | Instance-specific. [Synology](https://kb.synology.com/en-eu/DSM/tutorial/How_to_Sync_Synology_Calendar_with_CalDAV_Clients) |
| Baïkal | Deployment-specific `/dav.php/`; configure well-known redirect | Configured Basic or Digest | Sabre supports WebDAV sync when backend/plugin enabled; inspect installation | Old installs and Digest-only configurations differ; our spike transport only implements Basic. | Instance-specific. [Baïkal troubleshooting](https://sabre.io/baikal/troubleshooting/), [Sabre sync](https://sabre.io/dav/sync/) |
| SOGo | Deployment prefix `/SOGo/dav/{user}/Calendar/`, then collection discovery | Deployment/account authentication | Not verified here | `SOGoDAVCalendarStartTimeLimit` can hide older events; zero means no cutoff. This can invalidate “complete history” assumptions. | Instance-specific. [SOGo installation/configuration](https://www.sogo.nu/files/docs/SOGoInstallationGuide.html) |
| Google CalDAV | `https://apidata.googleusercontent.com/caldav/v2/{calendarId}/user`; collection `/events` | OAuth 2.0 only, HTTPS | Explicit RFC 6578 support | Old `google.com/calendar/dav` endpoint deprecated; no MKCALENDAR, no VTODO; prefer native API for push and metadata. | Calendar API quota policy. [Google CalDAV v2](https://developers.google.com/workspace/calendar/caldav/v2/guide) |
| Proton | User-generated ICS sharing URL; no CalDAV integration in this design | Secret URL | No; conditional HTTP/full-feed diff | Paid-plan sharing feature; full-details or busy-only link. Provider says updates can take up to eight hours, so polling cannot deliver real-time freshness. Treat link as credential. | No numeric poll cap verified. [Proton sharing](https://proton.me/support/share-calendar-via-link) |

**Recommendation and architecture impact:** replace a universal provider promise with capability and freshness metadata per source. Discovery is periodic even when event push exists. Custom-server auth other than Basic and client certificates remains outside this spike. Preserve server-visible history cutoffs, and expose stale/unreachable sources without silently deleting their last good data.

## 3. ICS URL ingestion and SSRF: R9

### Implementation and actual evidence

`src/ssrf.ts` resolves all addresses, rejects a mixed public/private result, chooses one vetted address, and performs the connection to that numeric address. `ipaddr.js@2.5.0` normalizes mapped IPv6 and classifies address ranges; only global unicast is accepted by default. This blocks loopback, private, link-local/metadata, CGNAT, ULA, unspecified, multicast and conservative reserved/translation ranges. WHATWG URL parsing normalizes integer/hex IPv4 before checking. Embedded credentials and non-HTTP schemes are rejected; `webcal://` becomes HTTPS.

Each manual redirect repeats validation and DNS resolution, with a five-hop default limit. HTTPS downgrade is rejected. Cross-origin redirects lose Authorization, Cookie and conditional headers. A LAN exception requires both an exact origin and an explicit CIDR; a hostname-only allowlist cannot permit a rebound private address. The real Radicale run used `{origin:'http://hare:55232',cidrs:['100.103.147.43/32']}` and dummy Basic credentials.

The transport enforces a ten-second default deadline including DNS and body reads, an 8 MiB compressed-wire limit and a separate 8 MiB decompressed limit. Automatic decompression is disabled; gzip/deflate/Brotli use bounded decoding. There is no MIME allowlist: `src/ics.ts` requires a parseable VCALENDAR rather than trusting content-type. ETag and Last-Modified are sent on the next request; 304 retains the cursor. Valid empty VCALENDAR deletes prior entries; HTML, transport errors and invalid calendars fail without deletions. Resources are grouped by UID, preserve master plus overrides and VTIMEZONE, and are revision-hashed.

Commands: `bun test test/ssrf.test.ts`, `bun test test/tls.test.ts`, `bun test test/adapters.test.ts`. The final combined run is [evidence/tests.txt](evidence/tests.txt). Fixtures include 22 blocked address forms, mixed DNS answers, a connection pinned after one lookup, redirect-time rebinding, metadata redirect, timeout, redirect loop, decompression bomb, sloppy MIME, both conditional headers, empty-feed deletion, and a live local ICS adapter. TLS uses an ephemeral OpenSSL certificate and checks valid host, wrong host and untrusted chain.

### Bun 1.3.4 findings that change the design

There is no per-request custom DNS `lookup` hook in the installed Bun 1.3.4 fetch typings. Rewriting the connection URL to the resolved IP and setting `Host` plus `tls.serverName` **alone failed** with `ERR_TLS_CERT_ALTNAME_INVALID` for a valid hostname certificate. The working native-fetch path also passes `tls.checkServerIdentity`, calling Node's certificate hostname validator with the **original hostname**, while leaving `rejectUnauthorized:true`. Wrong-host and untrusted certificates fail in the tests. This is hostname validation, not disabling TLS verification. The newer [Bun fetch documentation](https://bun.sh/docs/api/fetch) must not substitute for a run on the deployed runtime.

A more serious probe found `proxy:''` does **not** prevent use of ambient `HTTP_PROXY` on this version. The local proxy received the request: [negative probe](evidence/proxy-empty-failure.txt). The final guard rejects all upper/lowercase HTTP_PROXY, HTTPS_PROXY and ALL_PROXY variables before doing network work. A deployment needing a proxy requires a separately designed trusted egress service; it cannot claim the same IP-pinning guarantee from this function.

Exploratory tests also observed TLS trust configuration reused across requests when toggling a custom CA in one process. The old failing output is retained in [evidence/ssrf-tls.txt](evidence/ssrf-tls.txt). Final untrusted-chain verification uses a fresh child process, avoiding that ambiguity. This does not establish general exploitability, but **per-tenant custom CA switching is not approved by this spike**. Use fixed process-wide trust or isolated transports and revalidate on a newer runtime. Earlier unsuccessful node:https experiments are retained in `evidence/tls-lookup.txt`; the final implementation uses native fetch.

**Recommendation and architecture impact:** centralize this boundary for every user-controlled fetch, including CalDAV, discovery redirects and later multiget hrefs. Keep credentials scoped independently from URL permission. Run ingestion in a proxy-free environment with fixed trust roots; keep the TLS pinning regression fixtures when upgrading Bun. Do not ship the brief's SSRF promise as just “DNS checked before fetch.” OS/network egress restrictions are useful additional containment.

Remaining limits: first-address selection has no dual-stack failover; certificate revocation and arbitrary enterprise proxies were not tested; decompression/parsing are bounded in bytes but synchronous CPU work is not preempted by AbortSignal. The spike omits HTTP cache-control scheduling and ICS charset variants. The adapter retains normalized ICS, but production should also retain the original full feed for parser migrations. Tenant-editable LAN allowlists would defeat the policy; only operators can set them.

## 4. Google: R6 and R11

### Sync, scopes and mapping

`calendar.readonly` covers source reading. `calendar.events.readonly` plus `calendar.calendarlist.readonly` is a more explicit split for events and discovery; the latter alone cannot read events. `calendar.app.created` exists and permits creating secondary calendars and managing events on app-created calendars; it does not grant general read access to existing calendars. [Scope reference](https://developers.google.com/workspace/calendar/api/auth).

Fetch with `singleEvents=false` and `showDeleted=true`, keeping the query stable across sync. Drain every page and persist only terminal `nextSyncToken`. A 410 invalidates the old sync state and triggers an authoritative full resync. Do not combine incremental tokens with unsupported time/filter parameters. `src/google-sync.ts` implements pagination and one reset, with injected response fixtures proving an intermediate failure cannot return a cursor. [Sync guide](https://developers.google.com/workspace/calendar/api/guides/sync), [events.list parameters](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).

Store event objects by provider ID and link exceptions with `recurringEventId`; `originalStartTime` identifies the recurrence slot even when moved. A cancelled instance can be sparse, while a cancelled master deletes the resource. Apply deltas to the raw master/exception cache before re-rendering the complete resource. [Event schema](https://developers.google.com/workspace/calendar/api/v3/reference/events), [recurrence guide](https://developers.google.com/workspace/calendar/api/guides/recurringevents).

`googleResource` in `src/mapping.ts` produces VEVENT master plus overrides with a shared UID, RRULE/RDATE/EXDATE, date-only exclusive ends, timezone-aware DTSTART/RECURRENCE-ID, cancelled overrides, sequence/status, escaped text and conference video URL. It returns original payloads and referenced timezone IDs; the shared rendering layer must supply VTIMEZONE definitions. This is a core-field mapper, not full Google fidelity: attendees/organizer, alarms, attachment metadata, special event types and HTML bodies need explicit policy.

Command: `bun test test/mapping.test.ts test/google-sync.test.ts` passed; final full-suite output is saved. Cases include a moved weekly instance, sparse cancelled instance, all-day dates, conferenceData, terminal pagination, 410 reset and page failure. No OAuth calls were made.

### Push and freshness

Both [events.watch](https://developers.google.com/workspace/calendar/api/v3/reference/events/watch) and [calendarList.watch](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/watch) exist. Their current reference states a default TTL of **604800 seconds**. It does **not** establish a numeric hard maximum; that part of the requested question remains unverified. Use returned expiration, renew ahead of it, and tolerate provider shortening.

The current [push guide](https://developers.google.com/workspace/calendar/api/guides/push) requires public HTTPS with a valid certificate. Its documented setup does not require Search Console domain registration; that is a statement about current docs, not a live verification of all project policies. OAuth brand/domain verification is separate. Notifications contain channel/resource headers, not changed events, and can be missed. Verify channel identity/token and enqueue a sync. Initial sync notification can precede watch creation's response. Renewal creates a replacement channel with a new ID and overlap; there is no automatic renewal. Keep safety polls and independently reconcile calendar discovery.

### Quotas and self-hosting

Current [quota documentation](https://developers.google.com/workspace/calendar/api/guides/quota) distinguishes projects created from May 1, 2026: **10,000 requests/min/project, 600/min/user/project**; previously active projects can retain earlier quotas. It also states a **1,000,000 requests/day/project billing threshold**, with billing details to follow and advance notice. Operational write limits can be lower. Read actual project settings; do not assume Google API calls remain unconditionally free. Back off with jitter on quota errors and budget sink writes separately.

External apps in OAuth **Testing** receive refresh tokens expiring after **seven days** unless requesting only basic identity scopes, which calendar ingestion does not. Publishing to Production removes that testing-mode rule; ordinary token revocation/expiry still applies. [OAuth token documentation](https://developers.google.com/identity/protocols/oauth2).

For a personal self-hosted project, Google documents verification exceptions for personal use/fewer than 100 users; warnings and user caps can still apply. Workspace-internal apps are another case. A public multi-user service should plan consent-screen, domain/brand and sensitive-scope verification. Restricted scopes have additional assessment requirements. Calendar is absent from the published restricted-scope examples consulted, but the exact requested scope classification in Cloud Console is authoritative; this spike does **not** certify `calendar.app.created` as nonsensitive. [Exceptions](https://support.google.com/cloud/answer/13464323?hl=en), [unverified app limits](https://support.google.com/cloud/answer/13463817?hl=en), [sensitive/restricted verification](https://support.google.com/cloud/answer/13464321?hl=en), [restricted scopes](https://support.google.com/cloud/answer/13464325?hl=en), [scope configuration](https://support.google.com/cloud/answer/13463073?hl=en).

**Architecture impact:** retain Google native API, add durable master/exception cache and channel records, and make OAuth setup status visible to operators. “Near real time” requires working push plus fallback polling; a self-hoster without public HTTPS can still poll. Do not ship a seven-day-token setup guide that leaves users in Testing indefinitely.

## 5. Microsoft Graph: R6 and R7

### Delta and complete recurrence are different problems

The [v1.0 delta reference](https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0) documents `/me/calendarView/delta` and `/users/{id}/calendarView/delta`, with fixed start/end bounds and opaque nextLink/deltaLink URLs. It describes the primary calendar. It does not expose unbounded `/me/calendars/{id}/events/delta`; that route is documented in [beta](https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-beta), whose production stability cannot be assumed. A calendar-view removal can mean leaving the window, not deletion of the underlying series.

The [conceptual delta guide](https://learn.microsoft.com/en-us/graph/delta-query-events) discusses a specified calendar more broadly than the v1.0 endpoint reference. Consequently secondary-calendar v1.0 delta routing is **unverified here**, not declared impossible. Verify it with a real account before relying on it. A safe v1 design uses paginated calendar events-list reconciliation plus push dirty hints for each selected calendar, and treats bounded calendarView delta as an optimization with its own window state.

List events to obtain single events and series masters; fetch a series with selected `cancelledOccurrences` and expanded `exceptionOccurrences`. [Event GET](https://learn.microsoft.com/en-us/graph/api/event-get?view=graph-rest-1.0) documents that combination. [Instances](https://learn.microsoft.com/en-us/graph/api/event-list-instances?view=graph-rest-1.0) requires a time window and cannot prove all-time completeness. Prefer immutable Outlook IDs and key overrides by original start rather than Graph occurrence `iCalUId`, which differs between occurrences. [Event schema](https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0).

A material unresolved case: `cancelledOccurrences` supplies opaque occurrence IDs, not their original timestamps. The docs show IDs containing dates, but do not establish a stable decoding contract. The mapper accepts an explicit ID → original-start index and throws if any cancellation is unresolved. A previously cached occurrence can supply it; a cold import of an already-cancelled series still needs an account-verified recovery strategy. This is not solved by assuming the cancellation is an ordinary event deletion.

### Mapping fixture results

`graphRrule` maps daily, weekly, absoluteMonthly, relativeMonthly, absoluteYearly and relativeYearly; interval, BYDAY/WKST, BYMONTHDAY, BYMONTH and BYSETPOS; and numbered, inclusive endDate and noEnd ranges. End-date UNTIL is UTC at the end of the final local day for timed recurrences, DATE for all-day. `graphResource` converts UTC/local response values to the recurrence zone, emits a shared master UID, moved overrides and cancelled instances, and preserves raw input. [Patterns](https://learn.microsoft.com/en-us/graph/api/resources/recurrencepattern?view=graph-rest-1.0), [ranges](https://learn.microsoft.com/en-us/graph/api/resources/recurrencerange?view=graph-rest-1.0).

Windows zones use `windows-iana@5.1.0`, based on CLDR mappings; territory `001` is the default with optional account territory. Mapping is not one-to-one. Unknown custom Windows/Outlook zones fail rather than silently using UTC. Pin the package/table and plan CLDR refreshes. [CLDR source](https://github.com/unicode-org/cldr/blob/main/common/supplemental/windowsZones.xml), [territory mappings](https://www.unicode.org/cldr/charts/49/supplemental/zone_tzid.html).

Command: `bun test test/mapping.test.ts`. Fixtures cover all six patterns, count/endDate/noEnd, actual ICAL expansion of second Thursdays, DST boundary UNTIL, moved exception, indexed cancellation, all-day UTC-response conversion to Tokyo's date, and Windows zone mapping. These prove code behavior on fixtures, not semantic equivalence for every Exchange recurrence.

Unverified mapping limits: month-end day 29/30/31 and leap-day behavior; relative patterns with multiple weekdays; Graph range startDate that is not the first matching recurrence day; custom timezone definitions; series splits; exception paging at large scale. [Microsoft recurrence guidance](https://learn.microsoft.com/en-us/graph/outlook-schedule-recurring-events) permits start dates that do not coincide with an actual occurrence. Current mapper does not adjust DTSTART to resolve that case. Production must reject unsupported cases or implement/test them; do not silently call this lossless.

### Notifications, accounts and throttling

Current [subscription reference](https://learn.microsoft.com/en-us/graph/api/resources/subscription?view=graph-rest-1.0) lists Outlook event lifetime **10,080 minutes (under seven days)** for basic notifications, and **1,440 minutes (under one day)** with resource data. Do not carry forward the older 4,230-minute figure. Calendar notification latency is listed as average under one minute and maximum three minutes, so even a healthy pipeline cannot promise seconds universally.

Choose basic notifications and fetch changed data using the normal sync path. Rich notifications add encryption certificate rotation and payload/JWT validation. Delegated read access supports personal and work/school mailboxes; shared-calendar scopes do not authorize subscriptions to another mailbox. Application access needs tenant/admin consent. Outlook permits at most **1,000 active subscriptions per mailbox across all apps**. [Outlook notification overview](https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview).

The public HTTPS webhook must URL-decode `validationToken` and return it as plain text with HTTP 200 within ten seconds; accept ordinary deliveries quickly after durable enqueue. Compare `clientState`, then fetch authoritative state. [Webhook delivery](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks). Supply a lifecycle URL at creation and handle `reauthorizationRequired`, `subscriptionRemoved` and `missed`; renew/reauthorize before expiry and resync after gaps. [Lifecycle notifications](https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events). Poll the calendar list; this spike did not establish calendar-list push support.

[Outlook throttling](https://learn.microsoft.com/en-us/graph/throttling-limits) lists per-app/per-mailbox **10,000 requests per ten minutes, four concurrent requests, 150 MB uploads per five minutes**. Honor 429 Retry-After, retain a per-mailbox semaphore, and account for tenant/global service limits too.

**Architecture impact:** the brief's common master-plus-overrides model remains useful, but Graph needs a durable occurrence identity index, completeness state and periodic reconciliation. Do not collapse bounded delta into a universal all-time cursor or use calendar-view tombstones to delete a master blindly. Define Graph's supported recurrence coverage before advertising full fidelity.

## 6. Sinks: R10

### Google: feasible for an optional v1 sink

[calendars.insert](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert) and [events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert) accept `calendar.app.created`. Create a dedicated secondary calendar in the user's account and write only there. Google owns the authorization semantics; Supercal should call this an app-managed calendar, not a calendar inaccessible to its user.

Omit attendees entirely so mirrored items are appointments, and use `sendUpdates=none` as a secondary setting. Google's event insert docs warn that some mail may still be sent in general and that suppressing updates can affect attendee synchronization; `sendUpdates=none` alone is not a no-invitation guarantee. Do not copy organizer, attendee state or conference-creation requests. Keeping an existing join URL in descriptive fields does not require creating a new conference. These are documentation-based implementation conclusions, not a real-account mail test.

Use stable deterministic provider event IDs where supported, private origin metadata and a durable write ledger. [Private extended properties](https://developers.google.com/workspace/calendar/api/guides/extended-properties) are per calendar copy and are useful for reconciliation. Apply the Google limits from section 4 and write only changed content; an initial bulk mirror can be expensive.

### Graph: API feasible; generic recurrence mirror is constrained

[Create calendar](https://learn.microsoft.com/en-us/graph/api/user-post-calendars?view=graph-rest-1.0) and [create event](https://learn.microsoft.com/en-us/graph/api/calendar-post-events?view=graph-rest-1.0) support personal/work accounts with delegated `Calendars.ReadWrite`. There is no app-created-calendar-only scope documented for these operations. An event without attendees is an appointment; do not copy attendees into the payload. This feasibility and invitation inference is verified by docs only.

An arbitrary upstream RRULE cannot always be represented by Graph's six patterns. A finite rolling horizon of standalone appointments is feasible, with explicit limits and renewal jobs, but changes how recurrence appears to the user and increases write volume. **Recommendation:** Google sink can enter v1 behind opt-in; defer general Graph sink until that horizon/fidelity contract is accepted and tested with a real account. Neither sink was executed in this spike.

### Loop prevention and architecture impact

Persist the actual provider account subject and canonical calendar ID immediately after creation, and exclude that calendar from ingestion before any event writes. Calendar names/descriptions are editable and cannot identify a sink reliably. Reconnecting the same provider identity must recover the exclusion, including when the same account is linked twice. A marker is a recovery hint, not the sole authority.

Suggested records: `sink_calendar(tenant_id, provider, provider_subject, calendar_id, publication_id)` and `sink_event(sink_id, resource_id, provider_event_id, applied_revision)`, with appropriate unique keys. Use Google deterministic IDs / Graph transaction IDs for retry idempotency, and retain deletion state until acknowledged. Reject source/publication dependency cycles; provider-private metadata alone will not survive an ICS copy through a third service. Define how user edits/deletion of the destination are reconciled before enabling continuous overwrite.

The brief's “sink: seconds” is a target, not a provider SLA. Quotas, notification latency, reconciliation and consumer refresh all affect observed freshness.

## 7. Adapter interface

The actual interface and implementations are in [src/adapters.ts](src/adapters.ts). The essential contract is:

```ts
type NormalizedResource = {
  id: string;       // provider resource identity within source calendar
  uid: string;      // iCalendar UID; never a globally unique database key
  revision: string;
  ical: string;     // complete resource: master plus all known overrides
  raw: unknown;
};
type SyncResult<C> = {
  upserts: NormalizedResource[];
  deletes: string[];
  nextCursor: C;
  fullResync: boolean;
};
interface ProviderAdapter<C> {
  readonly capabilities: {
    calendarDiscovery: 'poll' | 'push' | 'single';
    push: boolean;
  };
  listCalendars(): Promise<SourceCalendar[]>;
  sync(calendarId: string, cursor?: C): Promise<SyncResult<C>>;
  push?: {
    subscribe(target: {kind: 'calendar'; id: string} | {kind: 'calendar-list'},
      callbackUrl: string, secret: string): Promise<PushLease>;
    renew(lease: PushLease): Promise<PushLease>;
    teardown(lease: PushLease): Promise<void>;
  };
}
```

`SourceCalendar` carries ID/name/color and per-calendar incremental mode (`token`, `etag`, `conditional-get`), push and color flags. `PushLease` carries provider ID, expiry and opaque provider state; renewal may return a different ID (Google). CalDAV cursor contains sync token or ETag map plus ctag. ICS cursor contains validators and per-UID revisions. Provider-specific raw-cache transactions happen inside a sync implementation before producing complete replacement resources.

`fullResync:true` means the result is an authoritative complete snapshot: atomically replace the prior membership, even if a provider cannot enumerate individual tombstones. Failed fetch, parse or page never produces an authoritative empty result. In production the store should stage a snapshot generation and swap only when complete, avoiding a transaction open across network calls. Push handlers only validate and enqueue; subscription maintenance is separate from event sync.

Evidence: live `CalDavAdapter` normalized both seeded resources; local HTTP fixtures exercise `IcsAdapter` update/delete and conditional polling. Google/Graph functions are mapper/sync building blocks, not complete adapters. For large calendars this array-returning interface needs an internal staged/batched implementation, not unlimited in-memory buffering. No push HTTP server or sink writer was implemented.

## Decisions I recommend

1. Keep Bun pinned until the TLS/proxy tests pass on the selected upgrade; use `tsdav@2.5.0`, `ical.js@2.2.1` and `ipaddr.js@2.5.0`. Keep `fast-xml-parser@5.12.0` as a reference/probe dependency if tsdav handles production XML. Validate provider JSON/XML at the boundary rather than trusting SDK casts.
2. Use `@js-temporal/polyfill@0.5.1` for explicit instant/wall-time conversions and `windows-iana@5.1.0` for the spike's CLDR mapping; decide centrally how to update timezone data and generate VTIMEZONE. Unknown zones are errors, not UTC defaults.
3. Key resources by `(tenant_id, source_calendar_id, provider_resource_id)`, index UID separately, and retain raw payload plus normalization version. A shared UID across unrelated calendars is not permission to merge ownership.
4. Store source cursor JSON with a version and query/window fingerprint, last successful sync, completeness/generation, retry-after and last error. Atomically commit changes and cursor. Stage full snapshots; never clear last good state before a successful resync.
5. Add provider raw-event cache `(calendar_id, provider_event_id, master_id, original_start, payload)` and Graph occurrence index `(calendar_id, master_id, occurrence_id, original_start)`. Track unresolved cancellations/completeness explicitly.
6. Store push lease `(account_id, target, provider_channel_id, provider_resource_id, expires_at, secret_hash, provider_state)`; permit overlap while Google replaces a lease. Schedule renewal and safety polling independently of incoming traffic.
7. Put source fetches behind a proxy-free pinned-address transport; keep operator origin+CIDR exceptions outside tenant control. Separate credential-host policy from address policy.
8. Ship Google native sources and optional Google sink with separate read/write consent. Keep Graph master reconciliation, incomplete recurrence cases and bounded sink support explicit product decisions.

## New risks discovered

- Bun 1.3.4 original-host TLS verification and ambient proxy handling differ from a straightforward reading of current fetch examples; tested runtime behavior is part of the SSRF guarantee.
- Per-request custom CA isolation was ambiguous in same-process tests. A multitenant custom-trust feature needs its own validation before release.
- Graph's all-time v1.0 delta assumption fails; a bounded-view removal is not necessarily resource deletion, and pre-existing cancelled instances can lack reconstructible original starts.
- Server history cutoffs, provider feed-generation delays and push latency prevent a universal seconds-level freshness promise even when Supercal is fast.
- Numeric sync/watch limits are not always published. Google watch default TTL is documented; its hard maximum and real project domain-policy behavior remain unverified.
- Google introduced new quota/billing-threshold policy in 2026; outdated “free Calendar API” assumptions can produce operational surprises.
- XML report limits, malformed/incomplete multistatus responses and mid-fetch object deletion require fail-closed cursor handling; library success status alone is insufficient.
- Resource identity, original recurrence identity and iCalendar UID are distinct. Treating any one as a universal primary key risks wrong deletes or cross-calendar merging.
- Graph recurrence mappings are not proven lossless for every pattern/range combination; silently emitting a superficially valid RRULE can invent an occurrence.
- ICS content can be a bearer secret and decompression/parse workload can be adversarial; keep URLs/raw bodies out of ordinary logs and bound both bytes and execution capacity.

## How to rerun

From `/Users/user/work/playground/supercal`:

```sh
cd spikes/ingest
bun install --frozen-lockfile
bun run typecheck
bun test
bun run radicale
bun run bundle
```

Requirements: Bun 1.3.4 for exact runtime reproduction; OpenSSL on PATH for ephemeral local TLS fixtures; DNS and access to `hare:55232` for the live run. The guard intentionally refuses any nonempty proxy environment variables. The test run creates localhost servers and temporary certificates, then cleans them up. It sends no third-party account requests.

The live script explicitly allows the observed hare address `100.103.147.43/32`. If hare changes address, have the operator verify the new address and update that single lab allowance; do not replace it with arbitrary DNS-derived private-address trust. Each run creates and deletes only its own `/astrolabe/spike-{timestamp}/` collection. No shared server/container is recreated or stopped.

To refresh saved verification output:

```sh
bun run typecheck > evidence/typecheck.txt 2>&1
bun test > evidence/tests.txt 2>&1
bun run radicale > evidence/radicale.txt 2>&1
bun run bundle > evidence/bundle.txt 2>&1
```

`evidence/` intentionally includes some earlier negative transport/library probes; the final pass/fail authority is `tests.txt`, `typecheck.txt` and `radicale.txt`. Provider links were reviewed on the date above. Remaining account-dependent checks: real iCloud partition auth, a second CalDAV implementation, Google hard channel cap/domain-policy behavior, Graph secondary-calendar delta and cancellation cold starts, broad recurrence round trips, and actual no-invitation sink behavior. These are marked as gaps, not represented as successful runs.
