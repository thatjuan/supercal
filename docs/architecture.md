# Supercal: architecture

Status: decided, 2026-11-07. Supersedes the hypotheses in `docs/brief.md`. Product scope is in `docs/product.md`. Evidence for every decision marked *(spike)* is in `spikes/*/FINDINGS.md`: `feed` (Meridian), `ingest` (Astrolabe), `platform` (Gnomon).

## 1. Shape

```
                    ┌──────────────────────── supercal container (Bun, one binary) ────────────────────────┐
 providers          │                                                                                     │      clients
 ─────────          │   worker role                     postgres                     api / dav roles      │      ───────
 Google API  ◄──────┤   scheduler ─► adapters ─► normaliser ─► recordChange ─► resource + change log ────►│ CalDAV ─► Apple, Thunderbird, DAVx5…
 Graph API   ◄──────┤        ▲            ▲                         │ NOTIFY              │               │ ICS    ─► Google, Outlook, anything
 CalDAV      ◄──────┤   push hooks   guarded transport               ▼                     ▼               │ API    ─► dashboard, automation
 ICS URLs    ◄──────┤   (/hooks/*)   (SSRF, pinned TLS)          outbox ─► sink writer ─► Google sink cal │ SSE    ─► dashboard live view
                    └─────────────────────────────────────────────────────────────────────────────────────┘
```

- One codebase, one container image, one compiled Bun binary. `SUPERCAL_ROLES` (comma list of `api`, `dav`, `worker`; default all) selects what a process runs. Scale out by adding replicas; every role is safe to run on many replicas.
- Postgres is the only stateful dependency. It holds data, the change log, the scheduler, the outbox, and cross-replica signalling (LISTEN/NOTIFY).
- The web dashboard is a static SPA served by the `api` role from the same origin, so cookie auth needs no CORS in production.

## 2. Stack (pinned)

| Concern | Choice | Notes |
| --- | --- | --- |
| Runtime | Bun 1.3.4 | Pinned. Upgrades must pass the SSRF/TLS regression suite and the NOTIFY test first *(ingest, platform)*. |
| Language | TypeScript 5.9.3, strict | TS 7 breaks `openapi-typescript` *(platform)*. |
| Monorepo | Bun workspaces | `apps/daemon`, `apps/web`, `packages/{core,providers,db,api-client}`. |
| HTTP | Hono 4.13 | WebDAV verbs via `app.on([...])` work on `Bun.serve` *(feed)*. |
| API schema | `@hono/zod-openapi` 1.6 + Zod 4 | OpenAPI 3.1; discriminated unions emit `oneOf` + discriminator *(platform)*. |
| API docs | Scalar | `/api/docs`. |
| Typed client | openapi-typescript 7.13 + openapi-fetch 0.17 + openapi-react-query 0.5 | Generated into `packages/api-client`, never hand-edited. |
| Auth | Better Auth 1.7 (`better-auth/minimal`) + `@better-auth/api-key` | Plugins: organization, admin, api-key, openAPI *(platform)*. |
| DB access | Drizzle 0.45 + postgres.js 4.1 | Bun.SQL has no LISTEN API on 1.3.4 *(platform)*. |
| iCalendar | ical.js 2.2 | Parse/serialise only. Not for time arithmetic *(feed)*. |
| Time math | `@js-temporal/polyfill` 0.5 + `Intl` | ical.js mis-converts UTC→zone near DST transitions *(feed)*. |
| Windows zones | `windows-iana` 5.1 | Unknown zones are errors, never UTC *(ingest)*. |
| CalDAV client | tsdav 2.5 low-level helpers behind our transport | Our own cursor, diff and failure handling *(ingest)*. |
| XML (server side) | fast-xml-parser 5.12 + our namespace resolver | fast-xml-parser does not resolve namespaces *(feed)*. |
| IP classification | ipaddr.js 2.5 | *(ingest)* |
| Web | React 19, Vite 8, TanStack Router, React Query, Tailwind 4 | Better Auth React client for auth flows *(platform)*. |
| Image | `oven/bun:1.3.4` build → `gcr.io/distroless/cc-debian12:nonroot` | ~129 MB, ~370 ms cold start to healthy *(platform)*. |

## 3. Domain model

Vocabulary from `docs/brief.md`: tenant, account, source calendar, feed, publication (passthrough or virtual), sink.

- **Everything published is a publication.** "The user chose not to publish calendar X" means X's passthrough publication in that feed is disabled. When an account discovers a calendar, a passthrough publication is created in the owner's default feed, enabled if the account's `auto_publish` is on.
- A virtual publication references ≥2 source calendars from any accounts of the same owner and tenant. A source calendar can appear in any number of publications.
- A feed belongs to one user in one tenant. Admins can manage feeds of members in their tenant.

### Identifiers

- Tenant = Better Auth `organization`. `tenant_id` is **text** (Better Auth IDs are opaque strings) *(platform)*.
- Our own entities use prefixed TypeIDs as text: `acc_…`, `cal_…`, `feed_…`, `pub_…`, `snk_…`. Exposed as-is in the API. Branded TS types in `packages/db` prevent mixing.
- Three identities of an event are distinct and never conflated *(ingest)*: provider resource id (our key within a source calendar), iCalendar UID (used for merging and output), and recurrence identity (RECURRENCE-ID / original start).

## 4. Data model (Postgres)

Better Auth owns `user`, `session`, `account` (its auth-provider links: unrelated to our calendar accounts), `verification`, `organization`, `member`, `invitation`, `apikey`.

Supercal tables. Every tenant table carries `tenant_id text not null references organization(id)` and an RLS policy (§7).

| Table | Purpose / key columns |
| --- | --- |
| `api_key_tenant` | `api_key_id` PK → apikey, `tenant_id`, `user_id`. Immutable binding written only by our API *(platform: key metadata is user-editable, so never trust it)*. |
| `calendar_account` | `id`, `owner_user_id`, `provider` (`google`, `microsoft`, `icloud`, `caldav`, `ics`), `display_name`, `provider_subject` (stable provider identity), `email`, `server_url`, `credentials` (encrypted, §7), `status` (`active`, `reauth_required`, `error`, `disabled`), `status_detail`, `auto_publish`. |
| `source_calendar` | `id`, `account_id`, `provider_calendar_id`, `name`, `color`, `timezone`, `capabilities` jsonb (incremental mode, push), `state` (`active`, `gone`), `freshness` jsonb (last success, push active, expected latency). Unique `(account_id, provider_calendar_id)`. |
| `resource` | One iCalendar object: master + overrides for one UID. PK `(source_calendar_id, provider_resource_id)`. `uid`, `data` jsonb (`EventResource` as jCal), `revision`, `sequence`, `last_modified`, `organizer`, `span` tstzrange, `deleted` (tombstone), `seq` bigint, `changed_at`, `normalizer_version`. Indexes: `(source_calendar_id, uid)`, GiST `span`, `(source_calendar_id, seq)`. |
| `provider_event_raw` | Google/Graph raw cache: `(source_calendar_id, provider_event_id)` PK, `master_id`, `original_start`, `payload`. Deltas are applied here, then the full resource is re-rendered *(ingest)*. |
| `graph_occurrence` | `(source_calendar_id, master_id, occurrence_id)` PK, `original_start`. Resolves Graph `cancelledOccurrences` ids *(ingest)*. |
| `sync_target` | The scheduler. `id`, `kind` (`discover`, `events`, `push_renew`, `sink`), `target_id`, `cursor` jsonb (versioned, with query/window fingerprint), `next_run_at`, `lease_until`, `lease_owner`, `lease_version`, `attempts`, `last_error`, `retry_after`, `last_success_at`. Unique `(kind, target_id)`. |
| `push_lease` | `account_id`, `target` (calendar or calendar list), `provider_channel_id`, `provider_resource_id`, `expires_at`, `secret_hash`, `provider_state`. Overlap allowed during Google renewal. |
| `feed` | `id`, `owner_user_id`, `name`, `is_default`, `caldav_username` (unique, `[a-z0-9-]`), `caldav_password_hash` (argon2id), `ics_token_hash` (sha256), `uid_secret` (encrypted; HMAC key for privacy UIDs). |
| `publication` | `id`, `feed_id`, `kind` (`passthrough`, `virtual`), `slug`, `name`, `color`, `privacy` (`full`, `title-only`, `busy-only`), `filters` jsonb (`hideDeclined`, `hideCancelled`, `hideAllDay`), `keep_alarms`, `enabled`, `sort_order`, `epoch`, `config_version`. |
| `publication_source` | `(publication_id, source_calendar_id)` PK, `priority`. |
| `publication_item` | `(publication_id, href)` PK, `uid`. Href lookup; maintained by the projector *(feed)*. |
| `outbox` | `id` bigserial, `kind`, `payload`, `created_at`, `processed_at`, `attempts`. Durable work created in the same transaction as the change (sink writes, cache invalidation catch-up) *(platform)*. |
| `sink`, `sink_event` | `sink(id, publication_id, account_id, provider, provider_subject, provider_calendar_id, status)`; `sink_event(sink_id, uid, provider_event_id, applied_revision)`. |
| `audit_log` | `id`, `actor` jsonb (principal), `action`, `target_type`, `target_id`, `data`, `at`. |
| `system_setting` | Global key/value, e.g. `tombstone_floor`. Not tenant-scoped. |

## 5. Event core (`packages/core`)

- **Model.** `EventResource { uid, master: JCal | null, overrides: JCal[], timezones: Record<tzid, JCal> }` is the only event shape outside `core`. jCal (RFC 7265) in jsonb keeps unknown and X- properties by construction. Typed accessors wrap it; nothing else touches jCal arrays *(feed)*.
- **ical.js rules.** Register `design.icalendar.param.feature = { multiValue: "," }`. Copy `getAll*()` results before mutating (live arrays caused a privacy leak in the spike). Never use ical.js for UTC↔zone conversion *(feed)*.
- **Normalisers.** One per provider, each emitting a complete `EventResource` per provider resource:
  - CalDAV / ICS: parse, group by UID, keep source VTIMEZONEs.
  - Google: master + exceptions from the raw cache (`recurringEventId`, `originalStartTime`), cancelled instances → EXDATE/cancelled overrides, all-day exclusive ends, `conferenceData` → `CONFERENCE` + URL *(ingest)*.
  - Graph: `patternedRecurrence` → RRULE (six patterns, three range types), Windows zones → IANA, `exceptionOccurrences` → overrides, `cancelledOccurrences` → EXDATE via `graph_occurrence`. Unsupported recurrence shapes are rejected with an explicit error, never approximated *(ingest)*.
- **VTIMEZONE.** Pass the source's through. When the source only names an IANA zone (Google, Graph), generate VTIMEZONE from `Intl` over the data's span (earliest DTSTART to max(UNTIL, now+2y)). No static VTIMEZONE packages: they are wrong for many zones *(feed)*.
- **Span.** `span` = first start to last end (infinity for unbounded RRULE), computed with Temporal. Used for coarse time-range queries.
- **Projection** (per publication, at render time):
  1. *Merge* (virtual publications and the combined feed): dedupe by UID; choose a winner **per component** (master and each RECURRENCE-ID): organizer's own copy → higher SEQUENCE → later LAST-MODIFIED → lower `priority`. Overrides are unioned *(feed)*.
  2. *Filters*: hide declined (the account owner's PARTSTAT=DECLINED), hide cancelled, hide all-day.
  3. *Privacy*, by allowlist, never blocklist *(feed)*:
     - `busy-only`: keep only timing, recurrence, STATUS and TRANSP; set SUMMARY "Busy"; drop TRANSP:TRANSPARENT; drop DTSTAMP/CREATED/LAST-MODIFIED/SEQUENCE/CLASS too (they leak edit history and flags).
     - `title-only`: busy-only plus SUMMARY and COLOR; source CLASS PRIVATE/CONFIDENTIAL falls back to busy for that event.
     - `full`: everything.
     - All modes strip VALARM unless `keep_alarms`.
  4. *UID*: passthrough + full keeps the source UID. Virtual + full → `b64url(sha256(pubId‖uid))[:26]@supercal`. Title-only/busy-only → `b64url(hmac(feed.uid_secret, pubId‖uid))[:26]@supercal`. A feed never repeats a UID across its collections, because iCloud rejects that and KOrganizer collapses it *(feed)*.
  5. *Href*: `<b64url(sha256(outputUid))[:22]>.ics`.

## 6. Change log, sync tokens, caching

- **Single write path.** `recordChanges(tx, lease, changes)` is the only code that writes `resource`. Fetching and parsing happen before the transaction. Inside it, in order:
  1. Fence: `SELECT … FROM sync_target WHERE id = $1 AND lease_owner = $2 AND lease_version = $3 AND lease_until > now() FOR UPDATE`. No row means the lease was lost: roll back *(platform)*.
  2. `pg_advisory_xact_lock(<supercal namespace>, hashtext(tenant_id))`, so a tenant's sequence numbers commit in order *(feed: without it, 34% of concurrent changes were skipped)*.
  3. `nextval('change_seq')` per change, then upsert/tombstone `resource` rows with that `seq`.
  4. Update `publication_item` for affected publications, write the cursor to `sync_target.cursor`, insert `outbox` rows, `pg_notify('supercal_changes', {tenantId, calendarIds, maxSeq})`.
  5. Commit. Keep the transaction short: it serialises the tenant's writers.
- **Full resyncs** stage the new snapshot and swap only when complete. A failed fetch, a parse error, an auth failure or an incomplete page never yields deletions *(ingest)*.
- **CalDAV sync-token / getctag**: `https://<host>/ns/sync/<pubId>/<epoch>/<seq>`, where `seq` = max seq over the publication's sources, read **in the same statement** as the changed rows *(feed)*. A membership, privacy, filter or UID-affecting change bumps `epoch`. Tokens with an old epoch, or a seq below `tombstone_floor`, get `403 valid-sync-token`, and clients resync (verified with python caldav, vdirsyncer and tsdav).
- **Cosmetic changes** (name, colour, sort order) bump `config_version` only, so clients do not do a full resync.
- **Object ETag**: `hash(pubId, epoch, uid, max(seq of copies), config_version)`, derived without rendering, because etag-listing clients PROPFIND the whole collection every poll *(feed)*.
- **ICS ETag**: `pubId.epoch.seq.config_version` per publication (one segment per publication for the combined feed). 304s cost one aggregate query. Rendered bodies are cached compressed (br, gzip) keyed by ETag, and evicted on NOTIFY. Measured: 5,000 events render in ~200 ms; cached responses take ~9 ms *(feed)*.
- **Tombstones** are purged by a periodic job that raises `tombstone_floor`.

## 7. Security

- **Principals.** One Hono middleware resolves `Principal = { kind: 'user', userId, tenantId, role, via: 'session' | 'apiKey' }` *(platform)*.
  - A session uses its `activeOrganizationId`, rechecked against `member`.
  - An API key is verified, joined to `api_key_tenant`, and rechecked against current membership. An invalid key never falls back to the cookie.
  - The operator role is Better Auth admin's global `user.role = 'admin'`, kept separate from tenant roles.
  - A `service` principal (organization-owned key, no user) is a planned extension; the union type leaves room for it.
- **API key issuance** goes through `POST /api/v1/api-keys`, which writes the tenant binding in the same transaction. Better Auth's own key-creation endpoint is disabled for clients.
- **Authorization.** Per-route policy from `(role, ownership)`:
  - members: own accounts and feeds
  - admins: everything in the tenant
  - owners: also tenant settings and membership
  - operator: tenants across the install
- **Tenant isolation**, two layers:
  1. Every tenant query runs through `withTenant(principal, fn)`. It opens a transaction, does `SET LOCAL ROLE supercal_app` (NOLOGIN, NOBYPASSRLS, not an owner) and `set_config('app.tenant_id', $1, true)`, and hands `fn` a branded `TenantTx`. Repository functions only accept `TenantTx`.
  2. RLS `ENABLE` + `FORCE` with `USING`/`WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''))`.

  The spike proved a forgotten WHERE returns only the current tenant's rows and that a cross-tenant insert fails with 42501 *(platform)*.
- **Database roles.** One `DATABASE_URL` is enough: migrations create the NOLOGIN roles and the app switches with `SET LOCAL ROLE`.
  - `supercal_app`: tenant data, RLS-bound.
  - `supercal_control`: scheduler claims across tenants, auth tables, webhook routing. No tenant event data.
  - Operators can split credentials with `DATABASE_MIGRATION_URL`.
- **Secrets at rest.** Envelope AES-256-GCM via WebCrypto. A per-value data key is wrapped by a versioned master key from `SUPERCAL_KEYS=v2:…,v1:…`. The authenticated context binds tenant, record and field. Old-key records are lazily re-encrypted with compare-and-swap *(platform)*.
- **Feed credentials.**
  - The CalDAV app password is argon2id via `Bun.password`, with a 5-minute cache of successful verifications. Failed verifications are rate-limited per username and IP.
  - The ICS token is 32 random bytes; its sha256 is stored. Rotation revokes immediately.
  - Feed credentials never grant API access, and API credentials never open feeds.
- **Outbound fetches.** Every user-influenced request (ICS, CalDAV, discovery, redirects, multiget hrefs) goes through `guardedFetch` *(ingest)*:
  - Resolve DNS. Reject mixed or non-global answers (loopback, private, link-local and metadata, CGNAT, ULA, multicast, IPv4-mapped forms).
  - Dial the vetted IP, and check the certificate against the original hostname with `checkServerIdentity`.
  - Re-validate on every redirect, with at most 5 hops and no HTTPS→HTTP downgrade. Strip credentials on cross-origin redirects, except for a provider host policy (e.g. iCloud partitions).
  - 10 s deadline, 8 MiB wire and 8 MiB decoded limits, bounded decompression.
  - Refuse to run with any `*_PROXY` env var set (Bun ignores `proxy: ''`).
  - LAN access only through an operator allowlist of exact origin + CIDR (`SUPERCAL_EGRESS_ALLOW`), never set by tenants.
- **Webhooks.**
  - Google: verify channel id and token against `push_lease`.
  - Graph: answer the `validationToken` handshake within 10 s; check `clientState`.
  - Both only enqueue (bump `next_run_at`) and return 2xx fast. Payloads never carry trusted data.
- **HTTPS** is required in production. Apple will not send Basic credentials over plain HTTP. `SUPERCAL_PUBLIC_URL` must be https unless `SUPERCAL_INSECURE_DEV=1`.
- **Logging hygiene.** ICS URLs, tokens and raw bodies never go to logs; they are bearer secrets *(ingest)*.

## 8. Ingestion

### Adapter contract (`packages/providers`)

```ts
interface ProviderAdapter<Cursor> {
  readonly provider: Provider
  readonly capabilities: { calendarDiscovery: 'poll' | 'push' | 'single'; push: boolean }
  listCalendars(ctx: AdapterContext): Promise<SourceCalendarInfo[]>
  sync(ctx: AdapterContext, calendar: SourceCalendarRef, cursor: Cursor | null): AsyncIterable<SyncBatch<Cursor>>
  push?: {
    subscribe(ctx: AdapterContext, target: PushTarget): Promise<PushLeaseInfo>
    renew(ctx: AdapterContext, lease: PushLeaseInfo): Promise<PushLeaseInfo>
    teardown(ctx: AdapterContext, lease: PushLeaseInfo): Promise<void>
  }
}
type SyncBatch<C> =
  | { kind: 'delta'; upserts: NormalizedResource[]; deletes: ProviderResourceId[]; cursor: C }
  | { kind: 'snapshot-part'; upserts: NormalizedResource[] }        // full resync in progress
  | { kind: 'snapshot-end'; cursor: C }                             // swap staged snapshot
```

`AdapterContext` carries the guarded transport, decrypted credentials (with a refresh callback for OAuth), the logger, and an abort signal tied to the lease. Batches are streamed, so large calendars are never buffered whole *(ingest: array results do not scale)*.

### Providers

| Provider | Discovery | Events | Push | Notes |
| --- | --- | --- | --- | --- |
| Google | `calendarList` poll + `calendarList.watch` | `events.list` `singleEvents=false&showDeleted=true`; terminal `nextSyncToken`; 410 → staged full resync | `events.watch` per calendar; renew before `expiration` (default TTL 7 d), allow overlap | Scopes `calendar.calendarlist.readonly` + `calendar.events.readonly`; sink adds `calendar.app.created` by incremental consent. Quota 600 req/min/user. |
| Microsoft | `/me/calendars` poll | Per calendar: paginated events list (masters + singles) + series fetch with `exceptionOccurrences`/`cancelledOccurrences`; bounded `calendarView/delta` as an accelerator only | Basic change notifications per calendar (≤10,080 min), lifecycle URL; handle `reauthorizationRequired`, `missed`, `subscriptionRemoved` | v1.0 has no unbounded event delta *(ingest)*. Throttle: 4 concurrent / mailbox; honour Retry-After. |
| iCloud | CalDAV discovery from `caldav.icloud.com` | CalDAV | none (poll) | App-specific password. Partition-host credential policy. |
| CalDAV | RFC 6764 (well-known, SRV) from URL or email domain | `sync-collection` if advertised, else ctag → etag diff → multiget; per collection | none (poll) | Basic auth in v1; Digest later if needed. |
| ICS URL | single calendar | Conditional GET, parse, diff by UID revision | none (poll) | `webcal://` → https; honours Cache-Control within a floor and ceiling. |

### Scheduling

- `sync_target` rows are claimed with `FOR UPDATE SKIP LOCKED` (claim increments `lease_version`) by a worker loop in every `worker` replica. Leases are renewed while work runs, and work is aborted on lease loss *(platform: proven safe across 3 processes, crash reclaim works; a paused worker can overlap, hence fencing)*.
- Next-run policy:
  - `events` with healthy push: safety poll every 30 min.
  - CalDAV: 60 s while the calendar recently changed, decaying to 5 min.
  - ICS: Cache-Control-derived, clamped to 5–60 min.
  - Google/Graph without push: 2 min.
  - Failures: capped exponential backoff with equal jitter, honouring `retry_after`.
- Auth failures move the account to `reauth_required` and stop its targets. Last good data stays published, marked stale.
- A webhook hit sets `next_run_at = now()` on the matching target and NOTIFYs workers.
- Freshness is reported per source calendar as observed, never promised. Graph notifications average under 1 min (max 3 min); Proton links lag up to 8 h *(ingest)*.

## 9. Feed delivery (`dav` role)

- **CalDAV**, read-only *(feed)*:
  - Endpoints: `/.well-known/caldav` → `/dav/`; principal `/dav/<username>/`; home `/dav/<username>/cal/`; one collection per enabled publication `/dav/<username>/cal/<pubSlug>/`.
  - Properties: `current-user-principal`, `principal-URL`, `calendar-home-set`, `calendar-user-address-set`, `displayname`, Apple `calendar-color` (`#RRGGBBAA`) and `calendar-order`, CS `getctag`, `sync-token`, `supported-calendar-component-set` (VEVENT), `supported-report-set`, and `current-user-privilege-set` limited to `read` (clients show the calendars read-only).
  - Reports: `calendar-query` (time-range on `span`), `calendar-multiget`, `sync-collection`.
  - Writes get 403 `need-privileges`.
  - Responses: `DAV: 1, 3, calendar-access`; trailing slashes on collections; namespace-correct XML parsing.
- **ICS**: `/ics/<token>/<pubSlug>.ics` and `/ics/<token>/all.ics` (combined; merge rules apply across publications). `NAME` + `X-WR-CALNAME`, `REFRESH-INTERVAL;VALUE=DURATION:PT1H` + `X-PUBLISHED-TTL:PT1H`, no `X-WR-TIMEZONE`. ETag/Last-Modified/304, br/gzip, `Vary: Accept-Encoding`.
- **Subscribe helpers** (API): CalDAV settings; ICS and webcal URLs; Google `calendar.google.com/calendar/render?cid=` link; Outlook `addfromweb` links (to be verified by hand); an unsigned `com.apple.caldav.account` `.mobileconfig` without the password, served as `application/x-apple-aspen-config`.

## 10. Real-time fan-out

- One postgres.js LISTEN connection per process on `supercal_changes`. Notifications carry identifiers only. On notify:
  - the `dav` role evicts render caches;
  - the `api` role pushes to matching SSE subscribers;
  - the `worker` role wakes outbox consumers.
- NOTIFY is a hint and never the source of truth. After reconnect, consumers catch up from `outbox` and the change log *(platform)*.
- **SSE** `GET /api/v1/stream`:
  - Tenant- and permission-filtered, with a heartbeat every 15 s and `idleTimeout: 0` on that route.
  - `Last-Event-ID` is the change seq, so clients replay from the change log.
  - Streams are closed when the session is revoked or membership changes.
  - The spike measured p95 2.6 ms from commit to client.

## 11. Sinks

- **Google sink (v1, opt-in).** Incremental consent for `calendar.app.created`. Create a dedicated secondary calendar and record `provider_subject` + calendar id **before** any write, so ingestion excludes it (also across reconnects and double-linked accounts).
  - Events are written without attendees, organizer or conference creation, with `sendUpdates=none`; deterministic event ids give idempotency.
  - Private extended properties hold origin metadata.
  - `sink_event.applied_revision` tracks what was written. The sink writer drains `outbox` rows within a write budget per user.
  - User edits in the sink calendar are overwritten on the next change; this is documented.
- **Microsoft sink: deferred.** Graph has no app-created-only scope, and arbitrary RRULEs do not fit Graph's six patterns. Revisit with a rolling-horizon design *(ingest)*.
- Publications that include a sink's own calendar are rejected (no cycles).

## 12. Management API

- Base `/api/v1`, OpenAPI 3.1 at `/api/v1/openapi.json`, Scalar at `/api/docs`. Better Auth's endpoints (sign-up/in, sessions, organizations, members, invitations) stay under `/api/auth` with their own spec at `/api/auth/open-api/generate-schema`, linked from our docs *(platform: merging the two specs is not worth it)*.
- **Conventions**:
  - Errors are RFC 9457 `application/problem+json`, declared on every operation through shared response components.
  - Pagination is cursor-based (opaque, versioned, `(created_at, id)` keyset; limit ≤ 100).
  - Mutable resources return `ETag` and `PATCH` honours `If-Match`, returning 412 on conflict.
  - Timestamps are RFC 3339 UTC; IDs are TypeIDs.
  - Every mutation writes the audit log.
- **Resources**:
  - `GET /me`.
  - `GET|POST /tenants` (operator), `GET|PATCH /tenant` (current).
  - `GET|POST /api-keys`, `DELETE /api-keys/{id}`.
  - `GET|POST /accounts`, `GET|PATCH|DELETE /accounts/{id}`, `POST /accounts/{id}/sync`. POST covers caldav, icloud and ics: credentials are verified and calendars discovered before 201.
  - `POST /accounts/oauth/{google|microsoft}/start` → `{ authorizationUrl }`; `GET /oauth/{provider}/callback` → redirect to `returnTo` (allowlisted).
  - `POST /accounts/{id}/reconnect`.
  - `GET /calendars`, `GET /calendars/{id}`.
  - `GET|POST /feeds`, `GET|PATCH|DELETE /feeds/{id}`, `POST /feeds/{id}/credentials/{caldav|ics}/rotate` (returns the secret once), `GET /feeds/{id}/subscribe`, `GET /feeds/{id}/mobileconfig`.
  - `GET|POST /feeds/{id}/publications`, `GET|PATCH|DELETE /publications/{id}`, `PUT /feeds/{id}/publications/order`.
  - `GET /feeds/{id}/occurrences?from&to&publicationId` (expanded, projected JSON for preview).
  - `GET|POST /sinks`, `GET|DELETE /sinks/{id}`.
  - `GET /audit-log`.
  - `GET /stream`.
- **Ops endpoints**: `/healthz` (process), `/readyz` (DB reachable, migrations current, listener connected), `/metrics` (Prometheus: sync latency per provider, sync errors, lease reclaims, notify lag, feed requests by client type, cache hit rate).

## 13. Web dashboard (`apps/web`)

- React 19 + Vite 8 + TanStack Router (file routes) + React Query via `openapi-react-query` + Better Auth React client + Tailwind 4. Visual design is produced with the 12ui design skill before the screens are built.
- Same-origin in production (served by the daemon); in development, Vite proxies `/api` and the daemon runs with `WEB_ORIGIN=http://localhost:5173`.
- Live updates: one `EventSource` on `/api/v1/stream` invalidates React Query keys.
- Screens: see `docs/product.md`.

## 14. Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres; the role must own the schema (or use `DATABASE_MIGRATION_URL`). |
| `DATABASE_MIGRATION_URL` | no | Separate owner credential for migrations. |
| `SUPERCAL_PUBLIC_URL` | prod | Base URL for feeds, OAuth redirects and webhooks. |
| `SUPERCAL_KEYS` | prod | Versioned master keys, first is active. |
| `BETTER_AUTH_SECRET` | prod | Session signing. |
| `SUPERCAL_ROLES` | no | `api,dav,worker` (default all). |
| `SUPERCAL_MIGRATE` | no | `auto` (default; advisory-locked at boot) or `off`. |
| `SUPERCAL_SIGNUP` | no | `open`, `invite` (default), `disabled`. |
| `GOOGLE_CLIENT_ID/SECRET` | no | Enables Google accounts and sinks. |
| `MICROSOFT_CLIENT_ID/SECRET` | no | Enables Microsoft accounts. |
| `SUPERCAL_EGRESS_ALLOW` | no | Operator LAN allowlist: `origin=cidr,…`. |
| `RESEND_API_KEY`, `MAIL_FROM` | no | Enables magic links, invites, verification mail. |
| `WEB_ORIGIN` | dev | Extra trusted origin for the Vite dev server. |

Config is parsed once with Zod at boot. Invalid config exits with a message naming the variable.

## 15. Testing strategy

- `packages/core`: fixture-driven unit tests (tricky ICS corpus from the feed spike, Google/Graph JSON fixtures from the ingest spike), plus property tests for merge determinism and privacy (assert *absence* of every dropped property).
- Change log: the concurrent-writer race test from the feed spike is part of the regular test suite, together with the lease fencing test from the platform spike.
- CalDAV server: conformance runs with python `caldav`, vdirsyncer and tsdav against a test daemon.
- Provider adapters: recorded HTTP fixtures; a live Radicale container for CalDAV.
- Guarded transport: the SSRF/TLS/proxy regression suite from the ingest spike; required before any Bun upgrade.
- API: contract tests through the generated client.
- Web: component tests where logic lives; a small Playwright happy path (sign up → add ICS account → see preview → copy feed link).

## 16. Known gaps (tracked as issues, need real accounts or devices)

- Apple Calendar on a real macOS/iOS device against our CalDAV server and `.mobileconfig`.
- Thunderbird and DAVx5 runs.
- iCloud partition redirects and real Fastmail/Nextcloud runs.
- Graph: secondary-calendar delta behaviour; cold import of series with already-cancelled occurrences. The planned approach: expand the RRULE over a window, diff against `instances`, and treat missing occurrences as EXDATE. Also Graph month-end, leap-day and non-aligned start dates.
- Google: actual watch-channel maximum TTL, and invitation behaviour of sink writes.
- Outlook `addfromweb` link format.
