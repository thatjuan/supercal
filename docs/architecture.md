# Supercal: architecture

Status: decided, 2026-11-08. Supersedes the hypotheses in `docs/brief.md`. Product scope is in `docs/product.md`. Evidence for every decision marked *(spike)* is in `spikes/*/FINDINGS.md`: `feed` (Meridian), `ingest` (Astrolabe), `platform` (Gnomon).

## 1. Shape

```
                    ┌──────────────────────── supercal container (Bun, one binary) ────────────────────────┐
 providers          │                                                                                     │      clients
 ─────────          │   worker role                     postgres                     api / dav roles      │      ───────
 Google API  ◄──────┤   scheduler ─► adapters ─► normaliser ─► recordChanges ► resource + change log ────►│ CalDAV ─► Apple, Thunderbird, DAVx5…
 Graph API   ◄──────┤        ▲            ▲                         │ NOTIFY              │               │ ICS    ─► Google, Outlook, anything
 CalDAV      ◄──────┤   push hooks   guarded transport               ▼                     ▼               │ API    ─► dashboard, automation
 ICS URLs    ◄──────┤   (/hooks/*)   (SSRF, pinned TLS)    change log ─► sink runner ─► Google sink cal │ SSE    ─► dashboard live view
                    └─────────────────────────────────────────────────────────────────────────────────────┘
```

- One codebase, one container image, one compiled Bun binary. `SUPERCAL_ROLES` (comma list of `api`, `dav`, `worker`; default all) selects what a process runs. Scale out by adding replicas; every role is safe to run on many replicas.
- Postgres is the only stateful dependency. It holds data, the change log, the scheduler and cross-replica signalling (LISTEN/NOTIFY).
- The web dashboard is a static SPA served by the `api` role from the same origin, so cookie auth needs no CORS in production.

## 2. Stack (pinned)

| Concern | Choice | Notes |
| --- | --- | --- |
| Runtime | Bun 1.3.4 | Pinned. Upgrades must pass the SSRF/TLS regression suite (`bun run test:egress`) and the NOTIFY test first *(ingest, platform)*. |
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
| Image | `oven/bun:1.3.4` build → `gcr.io/distroless/cc-debian12:nonroot` | ~129 MB, ~370 ms cold start to healthy, measured without bundled web assets *(platform)*. |

## 3. Domain model

Vocabulary from `docs/brief.md`: tenant, account, source calendar, feed, publication (passthrough or virtual), sink.

- **Every calendar in a feed is a publication.** "The user chose not to publish calendar X" means X's passthrough publication in that feed is disabled. When an account discovers a calendar, a passthrough publication is created in the owner's default feed, enabled if the account's `auto_publish` is on.
- A hosted calendar is a source calendar whose provider is Supercal. Its events live in Supercal, under one hidden `hosted` account per user (§17). Connected calendars retain their provider as the authority.
- A virtual publication references ≥2 source calendars from any accounts of the same owner and tenant. A source calendar can appear in any number of publications.
- A feed belongs to one user in one tenant. Admins can manage feeds of members in their tenant.

### Identifiers

- Tenant = Better Auth `organization`. `tenant_id` is **text** (Better Auth IDs are opaque strings) *(platform)*.
- Our own entities use prefixed TypeIDs as text: `acc_…`, `cal_…`, `feed_…`, `pub_…`, `snk_…`, `lnk_…`, `shr_…` (calendar share), `dvl_…` (device DAV login). Exposed as-is in the API. Branded TS types in `packages/db` prevent mixing.
- Three identities of an event are distinct and never conflated *(ingest)*: provider object id (`source_object` key within a source calendar), iCalendar UID (used for merging and output), and recurrence identity (RECURRENCE-ID / original start).

## 4. Data model (Postgres)

Better Auth owns `user`, `session`, `account` (its auth-provider links: unrelated to our calendar accounts), `verification`, `organization`, `member`, `invitation`, `apikey`.

Supercal tables. Every tenant table carries `tenant_id text not null references organization(id)` and an RLS policy (§7).

| Table | Purpose / key columns |
| --- | --- |
| `api_key_tenant` | `api_key_id` PK → apikey, `tenant_id`, `user_id`. Immutable binding written only by our API *(platform: key metadata is user-editable, so never trust it)*. |
| `calendar_account` | `id`, `owner_user_id`, `provider` (`google`, `microsoft`, `icloud`, `caldav`, `ics`, `hosted`), `display_name`, `provider_subject` (stable provider identity), `email`, `server_url`, `credentials` (encrypted, §7), `status` (`active`, `reauth_required`, `error`, `disabled`), `status_detail`, `auto_publish`. |
| `source_calendar` | `id`, `account_id`, `provider_calendar_id`, `name`, `color`, `timezone`, `description`, `sort_order` (default 0), `sync_epoch` (default 0), `updated_at`, `gone_at` (hosted soft deletion), `capabilities` jsonb (incremental mode, push, write), `state` (`active`, `gone`), `freshness` jsonb (last success, push active, expected latency). Unique `(account_id, provider_calendar_id)`. |
| `source_object` | Raw layer: exactly what the provider returned, for every connected provider; the authoritative iCalendar payload for hosted calendars. PK `(source_calendar_id, provider_object_id)`. `format` (`ical`, `google`, `graph`), `payload` (iCalendar text or JSON), `etag` (provider revision: CalDAV etag, Google etag, Graph changeKey), `group_uid` (the iCalendar UID this object contributes to), `original_start` (for exceptions), `seen_generation`, `dirty`, `normalizer_version`. Kept for every provider so re-normalisation never needs a refetch *(ingest review)*. |
| `dav_object_name` | Tenant-scoped stable client names for imported objects: PK `(source_calendar_id, uid)`, unique `(source_calendar_id, object_name)`, `created_at`. Calendar deletion cascades; tenant RLS is enabled and forced. |
| `resource` | Derived layer: one iCalendar object (master + overrides) per UID per source calendar. PK `(source_calendar_id, uid)`, so a passthrough collection can never hold two objects with one UID (RFC 4791 §5.3.2.1) *(feed review)*. `object_name` (hosted or edited imported CalDAV name, retained on tombstones), `data` jsonb (`EventResource` as jCal), `revision` (hash of `data`), `sequence`, `last_modified`, `organizer`, `span` tstzrange, `completeness` (`complete`, `incomplete` + reason), `deleted` (tombstone), `seq` bigint, `changed_at`. Indexes: GiST `span`, `(source_calendar_id, seq)`. |
| `graph_occurrence` | `(source_calendar_id, master_id, occurrence_id)` PK, `original_start`. Resolves Graph `cancelledOccurrences` ids *(ingest)*. |
| `sync_target` | The scheduler. `id`, `kind` (`discover`, `events`, `push_renew`, `sink`), `target_id`, `cursor` jsonb (versioned, with query fingerprint), `next_run_at`, `lease_until`, `lease_owner`, `lease_version`, `wake_generation`, `attempts`, `last_error`, `retry_after`, `last_success_at`. Unique `(kind, target_id)`. |
| `push_lease` | `account_id`, `target` (`account` for Graph mailbox-wide subscriptions, `calendar` or `calendar-list` for Google), `target_id`, `provider_channel_id`, `provider_resource_id`, `expires_at`, `secret_hash`, `provider_state`. Overlap allowed during Google renewal. |
| `feed` | `id`, `owner_user_id`, `name`, `is_default`, `caldav_username` (unique, `[a-z0-9-]`), `caldav_password_hash` (argon2id), `ics_token_hash` (sha256), `uid_secret` (encrypted; HMAC key for privacy UIDs). At most one default feed per user and tenant (partial unique index). |
| `calendar_share` | `id` (`shr`), `tenant_id`, `calendar_id` (cascade), nullable `grantee_user_id` (cascade; null means every tenant member), ordered `access` (`free-busy`, `read`, `write`, `manage`), `created_by`, `created_at`, `updated_at`. Partial unique indexes separate personal and tenant grants for Postgres 14; `(tenant_id, grantee_user_id)` indexes listing. |
| `calendar_link` | `id`, `calendar_id` (cascade), optional `name`, unique `token_hash` (sha256), immutable `privacy`, `uid_secret` (encrypted per-link HMAC key), nullable `expires_at`, `created_by`, `created_at`. Several independent view-only URLs may publish one hosted or imported calendar. |
| `dav_login` | Per-device credential: `id` (`dvl_…`), `tenant_id`, `user_id` (cascades), `name`, globally unique `username`, argon2id `password_hash`, `last_used_at` (updated at most hourly), `created_at`. |
| `publication` | `id`, `feed_id`, `kind` (`passthrough`, `virtual`), `slug`, `name`, `color`, `privacy` (`full`, `title-only`, `busy-only`), `filters` jsonb (`hideDeclined`, `hideCancelled`, `hideAllDay`), `keep_alarms`, `enabled`, `sort_order`, `epoch`, `config_version`, `status` (`ok`, `disabled-invalid`) + `status_detail` (set when Supercal disables it, e.g. a virtual publication left with one source). Slug unique per feed. |
| `publication_source` | `(publication_id, source_calendar_id)` PK, `priority`. |
| `sink`, `sink_event` | `sink(id, publication_id, account_id, provider, provider_subject, provider_calendar_id, status)`; `sink_event(sink_id, uid, provider_event_id, applied_revision)`. |
| `audit_log` | `id`, `actor` jsonb (principal), `action`, `target_type`, `target_id`, `data`, `at`. |
| `system_setting` | Global key/value, e.g. `tombstone_floor`. Not tenant-scoped. |

## 5. Event core (`packages/core`)

- **Model.** `EventResource { uid, master: JCal | null, overrides: JCal[], timezones: Record<tzid, JCal> }` is the only event shape outside `core`. jCal (RFC 7265) in jsonb keeps unknown and X- properties by construction. Typed accessors wrap it; nothing else touches jCal arrays *(feed)*.
- **ical.js rules.** Register `design.icalendar.param.feature = { multiValue: "," }`. Copy `getAll*()` results before mutating (live arrays caused a privacy leak in the spike). Never use ical.js for UTC↔zone conversion *(feed)*.
- **Normalisers.** Pure functions, one per `source_object.format`: `normalize(objects: SourceObject[]) → EventResource` for all objects sharing a `group_uid`. When several objects in one source carry the same UID, the merge rules below pick per component.
  - `ical` (CalDAV, ICS): parse, keep source VTIMEZONEs.
  - `google`: master + exceptions (`recurringEventId`, `originalStartTime`), cancelled instances → EXDATE, all-day exclusive ends, `conferenceData` → `CONFERENCE` + URL *(ingest)*.
  - `graph`: `patternedRecurrence` → RRULE (six patterns, three range types), Windows zones → IANA, `exceptionOccurrences` → overrides, `cancelledOccurrences` → EXDATE via `graph_occurrence`. A cancellation whose original start cannot be resolved marks the resource `incomplete`; Supercal never infers an EXDATE from an occurrence's absence. Unsupported recurrence shapes are rejected with an explicit error, never approximated *(ingest)*.
- **VTIMEZONE.** Pass the source's through. When the source only names an IANA zone (Google, Graph), generate VTIMEZONE from `Intl` over the data's span (earliest DTSTART to max(UNTIL, now+2y)). No static VTIMEZONE packages: they are wrong for many zones *(feed)*.
- **Span.** `span` = first start to last end (infinity for unbounded RRULE), computed with Temporal. Used for coarse time-range queries.
- **Projection** (per publication, at render time):
  1. *Merge* (virtual publications): dedupe by UID; choose a winner **per component** (master and each RECURRENCE-ID): organizer's own copy → higher SEQUENCE → later LAST-MODIFIED → lower `priority`. Overrides are unioned, and any restricted copy restricts that component in the merged output without changing the winner *(feed)*. The combined `all.ics` does not merge: it dedupes by source UID, first publication by `sort_order` wins, and that publication's projection applies *(feed review)*.
  2. *Filters*: hide declined (the account owner's PARTSTAT=DECLINED), hide cancelled, hide all-day. A hidden master drops the resource. A hidden override becomes an EXDATE on the master, never a silent drop, because dropping the override would bring the master's occurrence back *(both reviews)*.
  3. *Privacy*, by allowlist, never blocklist *(feed)*:
     - `busy-only`: keep only timing, recurrence, STATUS and TRANSP; set SUMMARY "Busy"; drop TRANSP:TRANSPARENT masters, and turn transparent overrides into EXDATE; drop CREATED/LAST-MODIFIED/SEQUENCE/CLASS (they leak edit history and flags). DTSTAMP is required by RFC 5545, so it stays but is set to a constant (`19700101T000000Z`).
     - `title-only`: busy-only plus SUMMARY and COLOR; any effective CLASS other than PUBLIC falls back to busy for that event. An absent CLASS inherits the master's class on an override and defaults to PUBLIC on a master; an explicit PUBLIC override stays public.
     - Every spec names an audience: `owner` (feeds and sinks), `member` (another person in the tenant), or `public` (anyone holding a URL).
     - `full`: owners retain everything; members retain everything for public events. Events with an effective CLASS other than PUBLIC become busy-only for members and the public, including the transparent-event rule above. Owners retain full private events; title-only always reduces private events to busy-only.
     - Public `full` uses `TITLE_PROPS` plus DESCRIPTION, LOCATION, URL, CATEGORIES, GEO, CONFERENCE, CREATED, LAST-MODIFIED, SEQUENCE and DTSTAMP. Only TZID and RANGE parameters survive. ATTENDEE, ORGANIZER, COMMENT, CONTACT, ATTACH, all X- properties and all subcomponents (including VALARM) are absent. DTSTAMP is preserved in this mode.
     - Owner/member full strips VALARM unless `keep_alarms`; title-only and busy-only always strip it.
  4. *UID*: passthrough + full keeps the source UID. Virtual + full → `b64url(sha256(pubId‖uid))[:26]@supercal`. Title-only/busy-only → `b64url(hmac(feed.uid_secret, pubId‖uid))[:26]@supercal`. A feed never repeats a UID across its collections, because iCloud rejects that and KOrganizer collapses it *(feed)*. Published links use their own id and `calendar_link.uid_secret`, so two title-only or busy-only links on the same calendar produce unlinkable UIDs. Public links also use keyed UIDs for full objects when any component copy is restricted; member read grants retain source UIDs for REST paths and tombstones.
  5. *Href*: `<b64url(sha256(outputUid))[:22]>.ics`.

## 6. Change log, sync tokens, caching

- **Single write path.** `recordChanges(tx, changes: ResourceChange[])` (tenant from the `TenantTx`) is the only code that writes `resource`. Callers pass only resources whose `revision` actually changed, so a full resync that changes nothing allocates no sequence numbers and clients re-download nothing *(feed review)*. Inside the caller's transaction, as the **last** statements before commit:
  1. `pg_advisory_xact_lock(<supercal namespace>, hashtext(tenant_id))`, so a tenant's sequence numbers commit in order *(feed: without it, 34% of concurrent changes were skipped)*.
  2. `nextval('change_seq')` per change, then upsert/tombstone `resource` rows with that `seq`.
  3. `pg_notify('supercal_changes', '{"t":"<tenantId>","s":"<maxSeq>"}')`. The payload is bounded: identifiers only, never id lists *(platform review)*.

  The sync runner (§8) fences before calling it. Connected-calendar re-normalisation goes through the same runner; hosted re-normalisation calls the shared group normalizer directly under its calendar lock (§17). Both finish with `recordChanges`.
- **Lease fencing** lives in the sync runner: every transaction that writes `source_object`, `resource` or a cursor starts with `SELECT … FROM sync_target WHERE id = $1 AND lease_owner = $2 AND lease_version = $3 AND lease_until > clock_timestamp() FOR UPDATE`. No row means the lease was lost, so the transaction rolls back. Use `clock_timestamp()`, not `now()`, which is frozen at transaction start *(platform, review)*.
- **The change log is `resource` itself.** Each row holds its latest state and the `seq` of its last change, and deletions are tombstones. "What changed since N" is `seq > N` over the relevant source calendars. That serves CalDAV sync-collection, SSE replay (`Last-Event-ID`) and sink catch-up, with no separate append-only log.
- **CalDAV sync-token / getctag**: `https://<host>/ns/sync/<pubId>/<epoch>/<seq>`, where `seq` = max seq over the publication's sources, read **in the same statement** as the changed rows *(feed)*. A membership, privacy, filter or UID-affecting change bumps `epoch`. Tokens with an old epoch, or a seq below `tombstone_floor`, get `403 valid-sync-token`, and clients resync (the 403 path was verified with python caldav and tsdav; vdirsyncer does not use sync tokens and syncs by etag listing).
- **Cosmetic changes** (name, colour, sort order) bump `config_version` only, so clients do not do a full resync.
- **Object ETag**: `hash(pubId, epoch, uid, max(seq of copies), RENDER_VERSION)`, derived without rendering, because etag-listing clients PROPFIND the whole collection every poll *(feed)*. `RENDER_VERSION` is a code constant bumped whenever projection or serialisation output changes. `config_version` is deliberately excluded, so a rename does not make clients re-download every object *(feed review)*.
- **Publication hrefs are computed, not stored.** `href = b64url(sha256(outputUid))[:22]`, and `outputUid` derives from the source UID alone (§5). GET and multiget resolve an href by hashing the publication's UIDs (no rendering; ~ms for 5k) *(feed review: the lookup table is unnecessary)*.
- **ICS ETag**: `pubId.epoch.seq.config_version.RENDER_VERSION` per publication. Combined feeds prefix the joined publication segments with `all.<feedId>.<feed.updated_at ms>.`; empty combined feeds use `empty.<RENDER_VERSION>` after that prefix. Feed names are therefore isolated in the body cache, and renames change the ETag. 304s cost one aggregate query. Rendered bodies are cached compressed (br, gzip) in a size-bounded in-process LRU keyed by ETag. A changed ETag is a cache miss, so no invalidation is needed. Measured: 5,000 events render in ~200 ms; cached responses take ~9 ms *(feed)*.
- **Published-link ICS ETag**: `"lnk.<id>.<sync_epoch>.<maxSeq>.<calendar.updated_at ms>.<RENDER_VERSION>"`. One aggregate query reads the active calendar and its newest resource sequence (including tombstones). Last-Modified is the later of the calendar update time and newest resource change. Links share the feed handler's conditional responses, compression and byte-bounded cache. `RENDER_VERSION` is 2 for the corrected classification and public-link UID rules.
- **Tombstones** are purged by a periodic job. In one transaction it raises `tombstone_floor`, then deletes tombstones at or below it except each calendar's newest row. Keeping that row makes `max(seq)` monotonic, so a purge cannot revive a cached pre-deletion body; a later row allows the next purge to remove the retained tombstone. It allocates no sequence numbers, so it needs no tenant lock.

## 7. Security

- **Principals.** One Hono middleware resolves `Principal = { kind: 'user', userId, tenantId, role, via: 'session' | 'apiKey' }` *(platform)*.
  - A session uses its `activeOrganizationId`, rechecked against `member`.
  - An API key is verified, joined to `api_key_tenant`, and rechecked against current membership. An invalid key never falls back to the cookie.
  - The operator role is Better Auth admin's global `user.role = 'admin'`, kept separate from tenant roles.
  - A `service` principal (organization-owned key, no user) is a planned extension; the union type leaves room for it.
- **API key issuance** goes through `POST /api/v1/api-keys`. Better Auth's key creation does not join our transaction, because it uses its own adapter *(platform review)*. So the endpoint creates the key, then commits the `api_key_tenant` binding, and only then returns the secret. If the binding fails, it deletes the key. A key without a binding is unusable either way, because the resolver requires the binding (fail-closed). Better Auth's own key-creation endpoint is disabled for clients.
- **Authorization.** Per-route policy from `(role, ownership)`:
  - members: own accounts and feeds
  - admins: everything in the tenant
  - owners: also tenant settings and membership
  - operator: tenants across the install
- **Calendar grants.** `hosted/access.ts` computes the highest of ownership, tenant administration,
  a personal grant and a tenant-wide grant. `effectiveAccess`, `requireAccess` and
  `accessibleCalendars` share that calculation; the listing uses one query. Grants require
  current tenant membership and never cross tenants. Owners and tenant admins have `owner`
  access; only they can grant, downgrade or revoke `manage`. Better Auth's existing
  `afterRemoveMember` organization hook calls `endMembership` after the member row is gone;
  see §17 for departure cleanup. Re-invitation does not restore personal grants or credentials.

  | Capability | free-busy | read | write | manage | owner/admin |
  | --- | --- | --- | --- | --- | --- |
  | Query busy time and appear in calendar listing | yes | yes | yes | yes | yes |
  | Read events, CalDAV collections and event stream | | yes | yes | yes | yes |
  | See private events in full; create, edit and delete events | | | yes | yes | yes |
  | Rename/recolour calendar; manage shares and published links | | | | yes | yes |
  | Delete and restore calendar | | | | | yes |

  Imported calendars accept only `free-busy` and `read` grants; granting `write` or `manage`
  returns 422 `calendar-not-hosted`. Feed ownership rules stay unchanged: a sharee cannot
  republish another person's calendar in a feed.
- **Tenant isolation**, two layers:
  1. Every tenant query runs through `withTenant(principal, fn)`. It opens a transaction, does `SET LOCAL ROLE supercal_app` (NOLOGIN, NOBYPASSRLS, not an owner) and `set_config('app.tenant_id', $1, true)`, and hands `fn` a branded `TenantTx`. Repository functions only accept `TenantTx`.
  2. RLS `ENABLE` + `FORCE` with `USING`/`WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''))`.

  The spike proved a forgotten WHERE returns only the current tenant's rows and that a cross-tenant insert fails with 42501 *(platform)*.
- **Database roles.** Migrations create two NOLOGIN roles. The app switches into one of them per transaction with `SET LOCAL ROLE`.
  - `supercal_app`: tenant data, RLS-bound by the tenant policy.
  - `supercal_control`: work that happens before a tenant is known. It gets explicit, narrow RLS policies (`TO supercal_control`) and column-limited grants on exactly these tables:
    - `sync_target`: claim/renew across tenants
    - `push_lease`: webhook routing
    - `feed`: lookup by `caldav_username` / `ics_token_hash`
    - `calendar_link`: lookup by `token_hash`, with SELECT limited to `id`, `tenant_id`, `token_hash` and `expires_at`
    - `dav_login`: only `id`, `tenant_id`, `user_id`, `username`, `password_hash` for device authentication
    - `resource`: SELECT limited to `deleted`, `seq`, `changed_at` and `source_calendar_id` on live rows and tombstones for monotonic purge checks; DELETE only on tombstones
    - `api_key_tenant`: key → tenant resolution
    - `drizzle.__drizzle_migrations`: the migrations check in `/readyz`
    - Better Auth tables

    It never reads event data, `source_object` or provider credentials. Once the tenant is resolved, the request continues in `withTenant`.
  - **Recommended production setup**: `DATABASE_URL` is a login that is a member of both roles and owns nothing; `DATABASE_MIGRATION_URL` is the schema owner. **Single-URL mode** (one owner login for both) is supported for small self-hosts and documented as weaker: `SET LOCAL ROLE` still enforces RLS, but a code path that escapes the wrapper keeps owner/DDL rights *(platform review)*.
- **Secrets at rest.** Envelope AES-256-GCM via WebCrypto. A per-value data key is wrapped by a versioned master key from `SUPERCAL_KEYS=v2:…,v1:…`. The authenticated context binds tenant, record and field. Old-key records are lazily re-encrypted with compare-and-swap *(platform)*.
- **Feed credentials.**
  - The CalDAV app password is argon2id via `Bun.password`, with a 5-minute cache of successful verifications. Failed verifications are rate-limited per username and IP.
  - The ICS token is 32 random bytes; its sha256 is stored. Rotation revokes immediately.
  - Feed credentials never grant API access, and API credentials never open feeds.
  - A published link has its own 32-byte ICS token, stored only as a sha256 hash, and its own encrypted UID key bound to the `calendar_link` row. Only creation returns the token and subscription URLs; listing and updating return metadata. Revocation deletes the link. Unknown, expired, revoked and gone-calendar links all return an empty 404 before conditional or cached responses.
- **DAV logins.** Each device has a named login owned by one user in one tenant, separate from feed credentials. `POST /api/v1/dav-logins` returns a username, password and server URL once; `GET` lists only the caller's logins without secrets; `DELETE /api/v1/dav-logins/{id}` permits the owner or a tenant admin and revokes immediately. At most 20 logins per user and tenant; creation and deletion are audited.
  - Usernames are `<handle>-dav-<8 random [a-z0-9]>`; feed usernames end in six random characters, keeping the sets disjoint. Passwords use the same argon2id hashing, five-minute verification cache and throttling as feed passwords.
  - Every request reloads the credential hash and checks current tenant membership and bans. Revocation broadcasts `dav-login-revoked` to drop caches across replicas; the row check also catches missed notifications. The acting principal has `via: 'davLogin'` in audit entries.
  - A DAV login grants access to the user's own active hosted calendars, own active imported calendars enabled on the Calendars page, and calendars explicitly shared at read or above. For an own imported calendar, the toggle is its enabled passthrough publication in the owner's default feed; device access permits edits when the provider reports write access and its adapter implements writes, and shows full owner details, ignoring publication privacy and filters. Hosted calendars are always listed regardless of their toggle; virtual publications are not listed. A DAV login grants neither management API nor feed access; API keys cannot authenticate to DAV. Tenant admin status alone adds no collections to a device login; admins need a personal or tenant-wide read-or-higher grant for a colleague’s calendar, and retain their effective admin access on those collections.
- **Outbound fetches.** Every user-influenced request (ICS, CalDAV, discovery, redirects, multiget hrefs) goes through `guardedFetch` *(ingest)*:
  - Resolve DNS. Reject mixed or non-global answers (loopback, private, link-local and metadata, CGNAT, ULA, multicast, IPv4-mapped forms).
  - Dial the vetted IP, and check the certificate against the original hostname with `checkServerIdentity`.
  - Re-validate on every redirect, with at most 5 hops and no HTTPS→HTTP downgrade. Strip credentials on cross-origin redirects, except for a provider host policy (e.g. iCloud partitions).
  - 10 s deadline, 8 MiB wire and 8 MiB decoded limits, bounded decompression.
  - Refuse to run with any `*_PROXY` env var set (Bun ignores `proxy: ''`).
  - LAN access only through an operator allowlist of exact origin + CIDR (`SUPERCAL_EGRESS_ALLOW`), never set by tenants.
  - Fixed process-wide TLS trust roots. There are no per-tenant custom CAs: the spike saw trust configuration reused across requests within one process *(ingest)*.
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
  readonly format: SourceObjectFormat                  // 'ical' | 'google' | 'graph'
  readonly capabilities: { calendarDiscovery: 'poll' | 'push' | 'single'; push: 'none' | 'calendar' | 'account' }
  listCalendars(ctx: AdapterContext): Promise<SourceCalendarInfo[]>
  // Yields raw pages. Only the final item carries the cursor (Google returns nextSyncToken on the last page only).
  sync(ctx: AdapterContext, calendar: SourceCalendarRef, cursor: Cursor | null): AsyncIterable<SyncPage | SyncEnd<Cursor>>
  writes?: {
    put(ctx: AdapterContext, calendar: SourceCalendarRef, ics: string, existing: StoredObject[]): Promise<WriteResult>
    delete(ctx: AdapterContext, calendar: SourceCalendarRef, existing: StoredObject[]): Promise<WriteResult>
  }
  push?: {
    subscribe(ctx: AdapterContext, target: PushTarget): Promise<PushLeaseInfo>
    renew(ctx: AdapterContext, lease: PushLeaseInfo): Promise<PushLeaseInfo>
    teardown(ctx: AdapterContext, lease: PushLeaseInfo): Promise<void>
  }
}
type StoredObject = { id: ProviderObjectId; etag: string; payload: string | JsonValue; originalStart?: string }
type WriteResult = { upserts: RawObject[]; deletes: ProviderObjectId[] }
type SyncPage = { kind: 'page'; upserts: RawObject[]; deletes: ProviderObjectId[] }
type SyncEnd<C> = { kind: 'end'; mode: 'delta' | 'snapshot'; cursor: C }
type RawObject = { id: ProviderObjectId; etag: string; groupUid: string; originalStart?: string; payload: string | JsonValue }
```

`AdapterContext` carries the guarded transport, decrypted credentials (with a refresh callback for OAuth), the logger, and an abort signal tied to the lease. Adapters do no normalisation and no database writes.

### Sync runner (one per claimed `events` target)

The runner owns persistence, so adapters stay pure and large calendars are never held in memory *(ingest review)*:

1. Claim the target and remember `lease_version = v` and `wake_generation = w`.
2. For each `page`, run one short fenced transaction. It upserts/deletes `source_object` rows, sets `dirty = true`, and for snapshot runs sets `seen_generation = v`. These transactions take no tenant lock and allocate no seq. If a later page fails, the cursor is not advanced; the next run replays from the old cursor, and raw upserts are idempotent.
3. On `end`, one fenced transaction:
   - if `mode = 'snapshot'`, delete `source_object` rows with `seen_generation < v`. This happens only after a complete snapshot, so failures never cause deletions.
   - Normalise every dirty `group_uid` from all its current `source_object` rows. Diff the result against `resource.revision`.
   - `recordChanges` with only the changed resources, then clear `dirty` and store the cursor.
4. Schedule the next run. If `wake_generation > w` (a webhook arrived during the run), run again immediately instead of waiting for the safety poll *(ingest review)*.

Re-normalisation after a normaliser upgrade marks the affected `source_object` rows dirty and wakes their targets; the normal runner does the rest.

### Provider write-back

Device logins can create, replace and delete UID groups in an owner's writable imported calendars.
The provider remains the source of truth: each request waits for upstream acceptance, then stores
its returned representation. There is no optimistic local copy or outbox. Hosted calendars keep
storing the client's bytes; feed logins remain read-only.

`putImported` and `deleteImported` share three steps:

1. **Check:** a short `withTenant` transaction validates one VCALENDAR with one UID, checks write
   access, active calendar and usable account status, `capabilities.write` and `adapter.writes`, resolves the
   client object name, loads the group's raw objects and checks the collection's current ETag.
   Missing write capability means false for existing JSON rows. Duplicate UIDs report the existing
   href. Hosted and ICS accounts cannot use this service. A shared lock on the events target keeps
   the raw objects and DAV revision stable across these reads; sync and write applies lock the same
   target. A dirty UID group returns 412: the provider has a version the client has not seen yet,
   and using its newer upstream ETag with the old DAV ETag would overwrite that unseen edit.
   Normalization clears dirty flags even when a group throws or publishes nothing. An interrupted
   or persistently failing sync leaves its groups dirty until a later successful sync; a parked
   target must be woken and complete successfully before those groups accept writes.
2. **Provider:** after commit, build `accountContext` and call the adapter with a 20-second abort
   signal. No database transaction or account sync slot surrounds provider requests; credential
   refresh uses the existing compare-and-swap path. `put` makes the provider hold exactly the
   supplied master and/or overrides, and `delete` removes the whole UID group, conditional on every
   stored upstream ETag. Only `AuthFailedError` invokes `requireReauth`; object refusals leave the
   account active.
3. **Apply:** another short transaction takes `lockCalendarWrites`, reads and locks the events
   target, then calls `applyRawObjects` with its current `lease_version`. A snapshot already running
   therefore cannot sweep a newly created event. Normalize only the written UID group, audit the
   mutation and `recordChanges`. Set `next_run_at = now()` and increment `wake_generation` so a
   running sync cannot postpone the follow-up that repairs a stale fetch committed after the write.

| Provider outcome | Service code | CalDAV response |
| --- | --- | --- |
| `ProviderConflictError` | `precondition-failed` | 412 |
| `ProviderWriteRejectedError('read-only')` | `read-only` | 403 `d:need-privileges` |
| `ProviderWriteRejectedError('invalid-data')` | `invalid-calendar-data` | 403 `cal:valid-calendar-data` |
| `ProviderWriteRejectedError('quota')` | `quota` | 507 `d:quota-not-exceeded` |
| `ProviderWriteRejectedError('not-found')` | `precondition-failed` | 412; refetch upstream deletion |
| `ProviderThrottledError` | `provider-unavailable` | 503 with `Retry-After` |
| `ProviderUnavailableError` or timeout without retry hint | `provider-unavailable` | 502 |
| `AuthFailedError` | `read-only`, after `requireReauth` | 403 `d:need-privileges` |

`dav_object_name` records a client's chosen name per calendar and UID on create. Every device
uses that name in indexes, multiget and changes; objects without a name use `hrefFor(spec, uid)`.
Delete removes the mapping, while `resource.object_name` retains it for the deletion tombstone.
Feed publications always use `hrefFor` and ignore these names.

Imported PUT answers 201 or 204 **without an ETag**. RFC 4791 §5.3.4 forbids returning an ETag when
the stored representation differs from the submitted bytes; clients refetch the provider's copy.
Hosted PUT keeps returning its ETag because it stores the submitted bytes verbatim.

The CalDAV/iCloud adapter discovers write access from `current-user-privilege-set` (`write`,
`write-content` or `all`) on VEVENT collections. It conditionally PUTs the existing href or a fresh
UUID href, then GETs the stored bytes and ETag even when PUT returned one. DELETE uses `If-Match`.
Objects split across `path#uid` identifiers remain read-only to avoid overwriting other UIDs.
CalDAV requests use the guarded session transport. Google uses its fixed-host API client and shares
its per-account token bucket with sync. Google write access requires `calendar.events` plus an
`owner` or `writer` calendar role. Granular consent may grant only `calendar.events.readonly`;
those accounts keep syncing read-only. `Account.canWrite` reports the account scope, independently
of calendar roles. `POST /accounts/{id}/allow-editing` returns 409 `needs-consent` with a Google or Microsoft
incremental-consent URL, or 204 when already granted. Successful consent wakes discovery to
refresh calendar capabilities.

Google creates with `events.import` and the client's `iCalUID`. Edits PATCH only changed mapped
fields, preserving conference data, attachments, colors and extended properties. Masters run
before instances. New instances resolve Google's deterministic id, or a bounded `events.instances`
lookup when it is absent; each mutation of a known event uses `If-Match`. Missing exceptions revert
to the series at their original start, while cancellations and newly excluded dates cancel the
instance. Participant notifications are sent for organizer scheduling changes or the account's
own RSVP; other edits use `sendUpdates=none`. Imported events do not send invitations on creation;
live invitation behavior remains unverified.

A multi-call provider failure carries accepted changes in `ProviderPartialWriteError.partial`.
The write service applies that result through the same third step before mapping the underlying
cause to the device response. The follow-up sync repairs any upstream state not returned by the
failed request.

Microsoft write access requires `Calendars.ReadWrite` (with or without the Graph resource prefix)
and the calendar's `canEdit` flag. New connections request that scope; read-only grants continue
syncing and refresh using only their held scopes. The shared Allow editing operation starts dynamic
consent for the same Microsoft identity, then wakes discovery. Graph creates use a UUIDv5 of the
client UID as `transactionId`; Graph assigns `iCalUId`. The apply step normalizes and names the
returned UID, permits an identity change only on create, and checks for an existing UID conflict.

Graph writes run the master first, occurrence patches next and occurrence deletes last. Recorded
`graph_occurrence` rows resolve recurrence IDs, with a bounded instances lookup for unknown ids.
Removing an exception patches the master's values back at its original start. Returned groups and
occurrence records use the same fetch and cancellation resolution as sync. Every PATCH and DELETE
sends `If-Match: W/"<changeKey>"`. Graph's event documentation does not guarantee enforcement, so a
GET also compares the stored changeKey immediately before mutation; a short race remains between
that GET and the mutation. Live enforcement and Outlook client behavior still need verification.

The pure Graph converter refuses unrepresentable recurrences before making a request, retains an
unchanged HTML body, and retries a rejected timed IANA zone once using UTC instants. Graph sends
attendee notifications itself and offers no suppression parameter.

### Providers

| Provider | Discovery | Events | Push | Notes |
| --- | --- | --- | --- | --- |
| Google | `calendarList` poll + `calendarList.watch` | `events.list` `singleEvents=false&showDeleted=true`; terminal `nextSyncToken`; 410 → staged full resync | `events.watch` per calendar; renew before `expiration` (default TTL 7 d), allow overlap | Scopes `calendar.calendarlist.readonly` + `calendar.events` (legacy/read-only consent may retain `calendar.events.readonly`); sink adds `calendar.app.created` by incremental consent. Quota 600 req/min/user. |
| Microsoft | `/me/calendars` poll | Per calendar, an etag-style reconciliation: list `id, changeKey, type` (masters + singles), diff against `source_object.etag`, then fetch only changed items. Series are fetched with `exceptionOccurrences` and `cancelledOccurrences`. Every run is a `snapshot` | One basic change-notification subscription **per mailbox** on `/me/events` (≤10,080 min) with a lifecycle URL. A notification wakes all of the account's calendar targets. Handle `reauthorizationRequired`, `missed`, `subscriptionRemoved` *(ingest review)* | v1.0 has no unbounded event delta *(ingest)*. Throttle: 4 concurrent / mailbox; honour Retry-After. |
| iCloud | CalDAV discovery from `caldav.icloud.com` | CalDAV | none (poll) | App-specific password. Partition-host credential policy. |
| CalDAV | URL + `/.well-known/caldav` → principal → home (SRV/email-domain discovery is deferred) | `sync-collection` if advertised, else ctag → etag diff → multiget; per collection | none (poll) | Basic auth in v1. |
| ICS URL | single calendar | Conditional GET, parse, diff by UID revision | none (poll) | `webcal://` → https; honours Cache-Control within a floor and ceiling. |

### Scheduling

- `sync_target` rows are claimed with `FOR UPDATE SKIP LOCKED` (claim increments `lease_version`) by a worker loop in every `worker` replica. Leases are renewed while work runs, and work is aborted on lease loss. The spike proved claiming, crash reclaim and scheduler-row fencing across 3 processes. Renewal, abort-on-loss and resource-transaction fencing are new implementation work and need their own tests *(platform review)*.
- Next-run policy:
  - `events` with healthy push: safety poll every 30 min.
  - CalDAV: 60 s while the calendar recently changed, decaying to 5 min.
  - ICS: Cache-Control-derived, clamped to 5–60 min.
  - Google/Graph without push: 2 min.
  - Failures: capped exponential backoff with equal jitter, honouring `retry_after`.
- Auth failures move the account to `reauth_required` and stop its targets. Last good data stays published, marked stale.
- A webhook hit sets `next_run_at = now()` and increments `wake_generation` on the matching targets, then NOTIFYs workers on `supercal_wake`.
- Freshness is reported per source calendar as observed, never promised. Graph notifications average under 1 min (max 3 min); Proton links lag up to 8 h *(ingest)*.

## 9. Feed delivery (`dav` role)

- **CalDAV feed logins**, read-only *(feed)*:
  - Endpoints: `/.well-known/caldav` → `/dav/`; principal `/dav/<username>/`; home `/dav/<username>/cal/`; one collection per enabled publication `/dav/<username>/cal/<pubSlug>/`.
  - Properties: `current-user-principal`, `principal-URL`, `calendar-home-set`, `calendar-user-address-set`, `displayname`, Apple `calendar-color` (`#RRGGBBAA`) and `calendar-order`, CS `getctag`, `sync-token`, `supported-calendar-component-set` (VEVENT), `supported-report-set`, and `current-user-privilege-set` limited to `read` (clients show the calendars read-only).
  - Reports: `calendar-query` (time-range on `span`), `calendar-multiget`, `sync-collection`.
  - PROPFIND on `/` and `/dav/` answers `current-user-principal`, because python caldav starts discovery at the root *(feed review)*. `Depth: infinity` gets 403 with `<d:propfind-finite-depth/>` (RFC 4918 §9.1).
  - Writes get 403 `need-privileges`.
  - Responses: `DAV: 1, 3, calendar-access`; trailing slashes on collections; namespace-correct XML parsing.
- **Hosted CalDAV with a device login** uses the same principal and home paths. Its collections are `/dav/<username>/cal/<segment>/`, where `segment` is `source_calendar.provider_calendar_id` for own hosted calendars and `source_calendar.id` for imported and shared calendars. REST-created calendars use their `cal_…` id; MKCALENDAR preserves the client's chosen segment, rejecting `cal_` prefixes reserved for calendar ids. The home lists the user's active hosted calendars, enabled own imported calendars (§7), and calendars explicitly shared at read or above (§17). Own imported collections are unredacted and allow object writes when `capabilities.write` is true and the adapter implements `writes`; shared imports remain read-only; when their display name collides with another collection, each own imported name gets an account-email suffix if available. Collections are ordered own before shared, then by calendar sort order.
  - The shared `CollectionView` interface supplies listing indexes, objects, range queries and sync behavior to one set of PROPFIND, REPORT and GET handlers. Feed collections project and merge UIDs as before. Hosted indexes read names, UIDs and ETags without payloads; GET and reports return the submitted iCalendar verbatim, with the same revision ETag as direct REST access.
  - User homes advertise `bind` and `unbind` in addition to read privileges. Writable collections add `write-content`; managed collections also add `write` and `write-properties`. Hosted properties include calendar description, a generated VTIMEZONE and the 1 MiB maximum resource size. No scheduling properties or scheduling capability are advertised.
  - PUT requires `text/calendar`, accepts client object names up to 255 UTF-8 bytes ending in `.ics` with no decoded slash, and honors `If-Match` and `If-None-Match: *`. Hosted PUT returns 201 for creation or 204 for replacement, with ETag; imported PUT uses the same statuses without ETag (§8, Provider write-back). Object DELETE honors `If-Match` and returns 204.
  - MKCALENDAR creates at the requested URI; an existing segment gets 403 `resource-must-be-null`. PROPPATCH supports display name, Apple color/order, description and timezone, applying the set atomically: an unsupported or invalid property gets 403 and the remaining properties get 424 in the 207 response. Colors lose their alpha and are stored as lowercase `#rrggbb`. Collection DELETE soft-deletes through the hosted service. Every mutation audits its DAV principal.
  - Hosted object writes use `writeObject` and `deleteObject`, as REST does. Imported object writes defer `putImported` or `deleteImported` until the request transaction commits. Imported collection DELETE, PROPPATCH and MKCALENDAR return 403 `need-privileges`. CalDAV validation conditions accompany 403 errors; a duplicate UID includes the existing href. Quota returns 507 `quota-not-exceeded`, stale preconditions return 412, and missing objects return 404. MOVE, COPY, LOCK, UNLOCK, MKCOL and POST return 403 `need-privileges`. Feed logins remain read-only. Authenticated user OPTIONS advertises the supported write methods; unauthenticated OPTIONS retains the read-only response.
  - Direct sync tokens are `https://<host>/ns/sync/<calId>/<sync_epoch>/<seq>`. Incremental sync preserves client names on changes and tombstones. Recreating a deleted UID at a different name increments the epoch and invalidates old tokens, preventing a stranded old href.
- **ICS**: `/ics/<token>/<pubSlug>.ics` and `/ics/<token>/all.ics` (combined: deduped by source UID, first publication by `sort_order` wins, §5). `NAME` + `X-WR-CALNAME`, `REFRESH-INTERVAL;VALUE=DURATION:PT1H` + `X-PUBLISHED-TTL:PT1H`, no `X-WR-TIMEZONE`. ETag/Last-Modified/304, br/gzip, `Vary: Accept-Encoding`.
- **Published calendar links**: `GET|HEAD /ics/l/<token>.ics` publishes one hosted or imported calendar directly from `resource`, using `audience: public`, the link's privacy and no filters or alarms. It uses the calendar's name and the same name/refresh properties as a feed publication. A gone calendar returns an empty 404; restoring it makes retained links serve again.
  - `GET|POST /api/v1/calendars/{id}/links` and `PATCH|DELETE /api/v1/calendars/{id}/links/{linkId}` use `canManageOwned`. Creation requires an explicit privacy mode, accepts a label and future expiry, and limits each calendar to 20 links under a calendar row lock (409 `link-quota`). A patch may change the label or future expiry, or clear either with null; privacy is immutable in the API and database permissions. Create another link to change privacy.
  - Creation returns the ICS URL, webcal URL and Google/Outlook subscribe links. The token appears only in this response. Mutations audit `link.create`, `link.update` and `link.delete` with identifiers only.
- **Subscribe helpers** (API): CalDAV settings; ICS and webcal URLs; Google `calendar.google.com/calendar/render?cid=` link; Outlook `addfromweb` links (to be verified by hand); an unsigned `com.apple.caldav.account` `.mobileconfig` without the password, served as `application/x-apple-aspen-config`.

## 10. Real-time fan-out

- One postgres.js LISTEN connection per process, on `supercal_changes` (`{t, s}`) and `supercal_wake`. Notifications carry identifiers only. On notify:
  - the `api` role pushes to matching SSE subscribers;
  - the `worker` role wakes the tenant's sink targets and claims woken sync targets early.

  Feed caches need no invalidation (ETag-keyed, §6).
- NOTIFY is a hint and never the source of truth. Every consumer keeps its own position in the change log (`resource.seq`): SSE clients via `Last-Event-ID`, sinks via their `sync_target.cursor`. After a missed notification or a listener reconnect, they catch up with `seq > position` *(platform review)*.
- **SSE** `GET /api/v1/stream`:
  - Tenant- and permission-filtered, with a heartbeat every 15 s and `idleTimeout: 0` on that route.
  - `Last-Event-ID` is the change seq, so clients replay from the change log. If that position is below `tombstone_floor`, the server sends a `reset` event and the client refetches.
  - Streams are revalidated every 60 s and closed when the session is revoked or membership changes.
  - The spike measured p95 2.6 ms from commit to client for ordinary delivery. Replay, revocation and reconnect catch-up are new implementation work *(platform review)*.

## 11. Sinks

- **Google sink (v1, opt-in).** Incremental consent for `calendar.app.created`. Create a dedicated secondary calendar and record `provider_subject` + calendar id **before** any write, so ingestion excludes it (also across reconnects and double-linked accounts). Its description starts with the marker `Managed by Supercal`, and the Google adapter's listing leaves out such calendars, so a mirror stays out after its `sink` row is gone (publication or account deleted). The row is the authority; the marker is the recovery hint.
  - Events are written without attendees, organizer or conference creation, with `sendUpdates=none`; deterministic event ids give idempotency.
  - Private extended properties hold origin metadata.
  - The sink is a `sync_target` of kind `sink`. Its cursor is `{epoch, seq}` of the publication. A run projects the publication's resources with `seq > cursor.seq`, compares each with `sink_event.applied_revision`, and writes within a per-user write budget. An epoch change triggers a full reconcile. There is no outbox.
  - User edits in the sink calendar are overwritten on the next change; this is documented.
- **Microsoft sink: deferred.** Graph has no app-created-only scope, and arbitrary RRULEs do not fit Graph's six patterns. Revisit with a rolling-horizon design *(ingest)*.
- Publications that include a sink's own calendar are rejected (no cycles).

## 12. Management API

- Base `/api/v1`, OpenAPI 3.1 at `/api/v1/openapi.json`, Scalar at `/api/docs`. Better Auth's endpoints (sign-up/in, sessions, organization creation and reads, invitations and member removal) stay under `/api/auth` with their own spec at `/api/auth/open-api/generate-schema`, linked from our docs *(platform: merging the two specs is not worth it)*. Tenant settings, roles and API-key mutations use REST; the corresponding plugin mutation routes are disabled, along with self-service tenant deletion, leave, operator impersonation and operator password replacement.
- **Conventions**:
  - Errors are RFC 9457 `application/problem+json`, declared on every operation through shared response components.
  - Pagination is cursor-based (opaque, versioned, `(created_at, id)` keyset; limit ≤ 100).
  - Mutable resources return `ETag` and `PATCH` honours `If-Match`, returning 412 on conflict.
  - Timestamps are RFC 3339 UTC; IDs are TypeIDs.
  - Every REST mutation writes the audit log in its transaction. One Better Auth after hook audits successful organization creation, invitations, joins and member removal using the acting session and the returned tenant and target. Better Auth commits first, so audit failures are logged without failing its response; removal also runs the membership cleanup hook.
- **Resources**:
  - `GET /me`.
  - `GET|POST /tenants` (operator), `GET|PATCH /tenant` (current).
  - `PATCH /members/{id}` (owner): Better Auth member id and a strict `role` body. Locks tenant members, preserves the last owner, commits the role and audit entry together, prunes orphan links on demotion to member, then revokes live streams for revalidation.
  - `GET|POST /dav-logins`, `DELETE /dav-logins/{id}` (per-device CalDAV credentials, password returned once).
  - `GET|POST /api-keys`, `DELETE /api-keys/{id}`.
  - `GET|POST /accounts`, `GET|PATCH|DELETE /accounts/{id}`, `POST /accounts/{id}/sync`. POST covers caldav, icloud and ics: credentials are verified and calendars discovered before 201.
  - `POST /accounts/oauth/{google|microsoft}/start` → `{ authorizationUrl }`; `GET /oauth/{provider}/callback` → redirect to `returnTo` (allowlisted).
  - `POST /accounts/{id}/reconnect`.
  - `GET|POST /calendars`, `GET|PATCH|DELETE /calendars/{id}`, `POST /calendars/{id}/restore` (mutations: hosted only, §17).
  - `GET|POST /calendars/{id}/events`, `GET|PUT|PATCH|DELETE /calendars/{id}/events/{uid}`, `POST /calendars/{id}/events/{uid}/split` (JSCalendar 2.0; mutations: hosted only, §17).
  - `GET /calendars/{id}/occurrences?from&to`, `GET /calendars/{id}/changes?since&limit`, `GET /calendars/{id}/export.ics`, `POST /calendars/{id}/import?onConflict=skip|replace` (import: hosted only).
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
| `SUPERCAL_INSECURE_DEV` | dev | `1` allows an http `SUPERCAL_PUBLIC_URL` and relaxes secure-cookie flags. Never in production. |
| `GOOGLE_CLIENT_ID/SECRET` | no | Enables Google accounts and sinks. |
| `MICROSOFT_CLIENT_ID/SECRET` | no | Enables Microsoft accounts. |
| `SUPERCAL_EGRESS_ALLOW` | no | Operator LAN allowlist: `origin=cidr,…`. |
| `SUPERCAL_ICS_CACHE_MB` | no | Bound on the in-process cache of rendered ICS bodies (default 64). |
| `SUPERCAL_SYNC_CONCURRENCY` | no | Sync jobs at once per worker process (default 8; at most 2 per account). |
| `RESEND_API_KEY`, `MAIL_FROM` | no | Enables password-reset, invitation and verification mail. |
| `WEB_ORIGIN` | dev | Extra trusted origin for the Vite dev server. |

Google OAuth apps left in **Testing** publishing status issue refresh tokens that expire after 7 days. The self-hosting guide must walk operators through publishing the app (and through the personal-use / <100-user verification exceptions), and the dashboard shows `reauth_required` clearly when this happens *(ingest)*.

Config is parsed once with Zod at boot. Invalid config exits with a message naming the variable.

## 15. Testing strategy

- `packages/core`: fixture-driven unit tests (tricky ICS corpus from the feed spike, Google/Graph JSON fixtures from the ingest spike), plus property tests for merge determinism and privacy (assert *absence* of every dropped property).
- Change log: the concurrent-writer race test from the feed spike is part of the regular test suite, together with the lease fencing test from the platform spike.
- CalDAV server: conformance runs with python `caldav`, vdirsyncer and tsdav against a test daemon.
- Web: the platform spike proved build and types only. Browser sign-in through the Vite proxy and same-origin cookies is unproven until the Playwright path runs *(platform review)*.
- Provider adapters: recorded HTTP fixtures; a live Radicale container for CalDAV, including the tsdav-helpers-over-guarded-transport composition, which neither spike ran end to end *(ingest review)*.
- Sync runner: lease renewal, abort on lease loss, a stale worker's page and end transactions being rejected, and a webhook arriving mid-run (`wake_generation`).
- Guarded transport: the SSRF/TLS/proxy regression suite from the ingest spike; required before any Bun upgrade.
- API: contract tests through the generated client.
- Web: component tests where logic lives; a small Playwright happy path (sign up → add ICS account → see preview → copy feed link).

## 16. Known gaps (tracked as issues, need real accounts or devices)

- Apple Calendar on a real macOS/iOS device against our CalDAV server and `.mobileconfig`.
- Thunderbird and DAVx5 runs.
- iCloud partition redirects and real Fastmail/Nextcloud runs.
- Graph: cold import of a series whose occurrences were already cancelled before Supercal saw it (`cancelledOccurrences` ids have no documented original start). Until a real-account investigation settles a recovery strategy, such resources are published from what is known and marked `incomplete`. Absence from a windowed `instances` listing is never treated as cancellation, because a moved exception can sit outside the window *(ingest review)*. Also Graph month-end, leap-day and non-aligned start dates.
- Google: actual watch-channel maximum TTL, and invitation behaviour of sink writes.
- Outlook `addfromweb` link format.


## 17. Hosted calendars, sharing and free-busy

A hosted calendar is a source calendar whose provider is Supercal. Each user has one hidden
`calendar_account` with `provider = 'hosted'`, `display_name = 'Supercal'`, `auto_publish = false`
and null credentials. Hosted `source_calendar` rows live under that account. There is no
adapter, `sync_target`, credential or second event model. Discovery and the scheduler have
nothing to run for this account.

```
REST (#25) ──┐
             ├─► writeObject ─► source_object (raw iCalendar) ─► normalizeIcal ─► recordChanges
CalDAV (#26) ┘                                                                      │
                                                resource + change log ◄─────────────┘
                                                         │
                          feeds, ICS, read-only CalDAV, SSE, virtual calendars, sinks
```

### Standards

Draft states were read from the IETF datatracker on 2026-11-08.

| Standard | State | Decision |
| --- | --- | --- |
| iCalendar: RFC 5545, RFC 7986 | Published | Stored format and interchange format. Already used. |
| jCal: RFC 7265 | Published | Internal form in `resource.data`. Already used. |
| CalDAV: RFC 4791, with WebDAV RFC 4918, RFC 6578 (sync), RFC 3744 (privileges), RFC 5397 (principal) | Published | Implemented read-write for hosted calendars (#26). The dashboard has an event editor for hosted calendars, built on the REST API; calendar apps remain a first-class way to edit, and CalDAV is what those apps speak. |
| JSCalendar 2.0: `draft-ietf-calext-jscalendarbis-22`, obsoletes RFC 8984 | IETF Last Call | JSON event format of the REST API (#25), pinned to this revision. |
| JSCalendar and iCalendar mapping: `draft-ietf-calext-jscalendar-icalendar-29` | IETF Last Call | The conversion rules for #25, including `JSPROP` for properties with no iCalendar equivalent. |
| JMAP Calendars: `draft-ietf-jmap-calendars-33` | RFC Editor queue, blocked | Not implemented now. Stalwart and Cyrus implement it on the server, client work is limited to early projects, and we found no shipping support in Apple Calendar or Thunderbird. JSCalendar events and share levels that map onto JMAP rights (#28) keep a later JMAP facade small. |
| CalDAV sharing: `draft-pot-caldav-sharing-01` | Expired in 2016 | Not implemented. Shares are managed through the REST API, and a shared calendar appears as an ordinary collection in the recipient's calendar home, which every client already understands. |
| Scheduling: RFC 6638, iTIP RFC 5546, iMIP RFC 6047 | Published | Not implemented. Attendees are stored as data and Supercal sends no invitations. The server does not advertise `calendar-auto-schedule`. |

The table records the milestone's protocol decisions. Storage (#24) supplies the service layer
and calendar management routes; event REST routes (#25) add the JSCalendar conversion below;
writable CalDAV (#26) and published links (#27) add the other two ways in and out (§9). Sharing and
free-busy (#28) and real-client verification (#29) build on the same storage.

### Storage and validation

For a hosted calendar, `source_object` is the only copy of the event: there is no provider to
refetch from. One object holds one UID, including its master, recurrence overrides and referenced
VTIMEZONEs. The object name is `provider_object_id`; `format` is `ical`; `payload` holds the
submitted text verbatim. The derived `resource` row holds jCal and the object's name, including
on its tombstone. Unknown and X- properties survive normalization; raw line folding survives in
the authoritative payload.

`validateObject` in `packages/core` runs before writing. Objects may be at most 1 MiB of UTF-8
and contain only VEVENT and VTIMEZONE at the VCALENDAR level. Parse errors, missing timing,
and unknown TZIDs without a supplied VTIMEZONE are `invalid-calendar-data`. Other components
(including VTODO, VJOURNAL and VFREEBUSY) are `unsupported-component`. METHOD, zero events,
or multiple UIDs are `invalid-object`; exceeding the byte limit is `too-large`. Timing is checked
with `spanOf`; time zone failures are never replaced with UTC.

Migration 0009 adds `hosted` to `account_provider`, the calendar metadata and lifecycle columns,
and `resource.object_name`. There are no new tenant tables or RLS policies; existing table grants
cover the new columns. All pending migrations run in one transaction, so no index or seed may
use the newly added enum value in that transaction. Account uniqueness instead uses an advisory lock.

### Single write path

`writeObject(tx, calendar, { objectName, payload, ifMatch?, ifNoneMatch? })` and
`deleteObject(tx, calendar, { objectName, ifMatch? })` accept an authorized caller's `TenantTx`;
protocol handlers authorize first. Every write takes `pg_advisory_xact_lock(HOSTED_WRITE_LOCK,
hashtext(calendar.id))` before touching objects. The lock order is calendar first, then the tenant
lock in `recordChanges`, which is the last database work in the transaction.

After validation, writes load the object and its resource and check preconditions. `ifNoneMatch:
'*'` rejects an existing live object; `ifMatch` rejects an absent object or a differing ETag.
An existing object's UID cannot change, and no other live object in the calendar may hold the
same UID. `uid-conflict` carries the conflicting object name when another object owns it.
New objects are limited to 50,000 per calendar. Calendar serialization makes the UID and quota
checks safe across concurrent connections.

The shared `upsertOf` builds a resource change from `normalizers.ical`. The raw object is upserted
with the revision as `etag`, its UID as `group_uid`, `dirty = false` and the current normalizer
version. `recordChanges` receives its `objectName`; delete changes leave that name intact while
removing the raw object. Deleting an absent object returns `not-found`.

A direct event ETag is `"<resource.revision>"`, shared by REST and writable CalDAV. Changes to
insignificant folding can update the stored raw payload while retaining the revision and ETag;
`recordChanges` drops such resource no-ops. Projected feed publications retain their own ETags
(§6), because their privacy, merge and UID rules affect output.

### Sync epoch

If UID `u1` at `a.ics` is deleted and recreated at `b.ics`, its resource tombstone at `a.ics` is
overwritten. An incremental client could otherwise learn only about `b.ics` and retain `a.ics`.
That write increments `source_calendar.sync_epoch`, invalidating outstanding direct-calendar
tokens and requiring a full resync. Recreating the UID at the same name does not increment it.
Direct-calendar tokens include this epoch in #25 and #26.

### Lifecycle and API

`getOrCreateHostedAccount` takes `HOSTED_ACCOUNT_LOCK` for the user before finding or inserting
the account. `createCalendar` holds the same lock while enforcing 100 retained calendars per user
and uses the calendar's own `cal_…` id as `provider_calendar_id`. Client-created calendars in #26
can use other values. Capabilities are `{ incremental: 'hosted', push: false }`.

Creation calls `ensurePassthroughPublication`. Because the account does not auto-publish, the
publication starts disabled: an owner with feed and DAV logins avoids seeing the calendar twice.
The owner may enable it, and events then flow through the existing read and delivery pipeline.

- `POST /api/v1/calendars` accepts `name`, optional `#rrggbb` color, description and IANA timezone
  (default `UTC`), and returns 201 and an ETag.
- `PATCH /api/v1/calendars/{id}` accepts name, color, timezone, description and sort order, honoring
  `If-Match`. Changing timezone does not recompute spans of existing floating events.
- `DELETE /api/v1/calendars/{id}` sets `state = 'gone'` and `gone_at`, retaining event data.
  `onCalendarGone` disables passthrough publications, removes virtual memberships and bumps the
  affected publication epochs.
- `POST /api/v1/calendars/{id}/restore` clears `gone_at` and sets `state = 'active'`; an active
  calendar returns 409. Publications and virtual memberships remain as deletion left them, so
  the owner re-enables publications and restores memberships explicitly.

Calendar PATCH requires `manage`; deletion and restoration require `owner` through
`hosted/access.ts`. Mutations audit `calendar.create`, `calendar.update`,
`calendar.delete` and `calendar.restore`, and reject connected calendars with 409
`calendar-not-hosted`. Exceeding the calendar quota returns 409 `calendar-quota`.

Calendar reads retain gone calendars for restoration and expose a `kind` discriminator,
nullable `accountId` (null for hosted), description, sort order, update time and deletion time.
Hosted freshness is `{ lastSuccessAt: null, pushActive: false, expectedLatency: 0, stale: false }`.
The hosted account is absent from account listings, and every account-by-id route returns 404
for it. The public Account provider union remains the five connected providers. The dashboard
groups connected calendars by visible account, lists hosted calendars in a group of their own, and
manages them on the Hosted screen.

### Maintenance

`normalizeDirtyGroups` is shared with the sync runner. Re-normalization marks stale objects dirty
in batches, wakes connected calendars' event targets, and rebuilds hosted calendars directly in
separate transactions under their calendar locks. `rebuildHostedCalendar` ends with
`recordChanges`, carrying object names. Rows left dirty by an interrupted maintenance run are also
rebuilt at the next run. A failed group keeps its last good data, marked incomplete.

The daily `purge-hosted-calendars` job visits each tenant and permanently deletes hosted calendars
whose `gone_at` is older than 30 days. Foreign keys cascade to raw objects, resources and
publication-source links. Restoring a calendar before retention expires preserves its data.

### REST events and JSCalendar conversion

The direct event API uses JSCalendar 2.0, pinned to
[`draft-ietf-calext-jscalendarbis-22`](https://datatracker.ietf.org/doc/html/draft-ietf-calext-jscalendarbis-22)
and the conversion rules in
[`draft-ietf-calext-jscalendar-icalendar-29`](https://datatracker.ietf.org/doc/html/draft-ietf-calext-jscalendar-icalendar-29).
`packages/core/src/jscalendar` converts to and from the existing jCal `EventResource`; it adds
no storage model or migration. Reads cover hosted and connected calendars. Writes require an
active hosted calendar and use `writeObject` or `deleteObject`, with the same revision ETag as
CalDAV. The UID is the only event identifier, including when it contains percent-encoded path
characters; new object names are the first 22 base64url characters of SHA-256 over the UID plus
`.ics`.

`fromJSCalendar` changes mapped property groups on a copy of the previous resource. Unmapped
properties, child components and unknown parameters survive PATCH, including on an override
with the same recurrence id. PUT builds a replacement from scratch. Unknown JSON properties
and unmapped nested fields use `JSPROP` with a quoted `JSPTR` and a JSON-encoded TEXT value;
these properties add missing JSON fields and cannot overwrite fields already mapped from
standard iCalendar properties. A top-level null vendor value is treated as absent, because the
mapping draft forbids a null `JSPROP` value. Version 1.0 fields `recurrenceRules`,
`excludedRecurrenceRules` and `timeZones` are rejected, as are `method` and versions other than
`2.0`; validation errors identify the field or patch pointer. Unknown and vendor properties
with valid names remain accepted.

The mapped properties cover event text, timing, status, transparency, classification, color,
keywords, priority, revision metadata, locations, conference links, attachments, participants,
recurrence, relations and alarms. Location details can use VLOCATION, participant details can
use PARTICIPANT, and link relations select ATTACH, IMAGE, URL or LINK according to mapping
§3.4. Description content type and other unsupported presentation details remain in JSPROP.
Participants are stored as data; these writes send no invitations.

Time arithmetic uses Temporal. An all-day event uses DATE only when it has no zone and every
temporal value has a zero time part; a floating event uses a local DATE-TIME. Zoned writes
require an IANA zone, convert recurrence `until` to UTC in RRULE, and generate missing
VTIMEZONEs before serialization. A source's custom TZID remains in jCal but has no JSCalendar
`timeZone`. DTEND and DURATION both read as `duration`; `endTimeZone` writes a DTEND.
The span index stores a zero-duration event as a closed point, so it is readable and overlaps
windows containing that instant.

Override JSON values are patches against the occurrence's inherited master fields, with its
start shifted to the recurrence id. A changed occurrence writes a complete RECURRENCE-ID
VEVENT, an exclusion writes EXDATE, and an empty patch writes RDATE. RDATE PERIOD values also
preserve their duration on read. A resource with one detached instance reads as an Event with
`recurrenceId` and, when known, `recurrenceIdTimeZone`; several detached instances read as a
Group, as required by mapping §2.1.2. GET, list and changes expose the same union. PATCH of a
resource without a master returns `event-has-no-master`.

REST writes set `updated`, DTSTAMP and Supercal's product identifier; creates also set `created`.
Client values for these fields do not control stored metadata. SEQUENCE starts at zero and
increments when start, duration, time zone or recurrence rule changes; changing a title alone
retains it. Import applies the same metadata policy to each component.

Splitting a series writes both objects in one transaction, links the original with a `next`
relation and the new series with a `first` relation, and divides overrides at the split point.
The patch applies to the new event last. The split must be an occurrence after the first;
non-recurring events and invalid split points return 422. Expansion counts rule instances
before EXDATE subtraction when dividing COUNT, as RFC 5545 requires. UNTIL is shortened to the
last retained occurrence before the split. Wall times stay in the event's zone across DST.

Lists page by UID with an opaque versioned cursor; optional time bounds filter the coarse span.
The direct changes token carries version, calendar sync epoch and a decimal bigint sequence.
`changesSince` supplies each page and position from one statement. Initial reads omit tombstones;
malformed tokens, epoch mismatches and positions below `tombstone_floor` return 410
`sync-token-expired`. Direct occurrences use the feed preview's expansion and UTC formatting,
with a 366-day window and a 5,000-item cap reported through `truncated`.

Export streams one VCALENDAR from live `resource.data`, emitting each TZID once. Import accepts
up to 8 MiB of `text/calendar`, groups VEVENTs by UID and writes the batch in one transaction;
per-UID savepoints isolate invalid objects. `onConflict=skip` leaves existing events and change
sequences untouched; `replace` replaces their objects. Import reports created, updated, skipped
and failed UIDs, and rejects a calendar with no VEVENT. Audits record UIDs and never event contents.

### Calendar sharing

`GET|POST /api/v1/calendars/{id}/shares` and
`PATCH|DELETE /api/v1/calendars/{id}/shares/{shareId}` require `manage`. The grantee is a
union on `type`: `{ type: 'user', userId }` or `{ type: 'tenant' }`. Listing includes a
colleague's name and email. Non-members return 404, sharing with the owner returns 422,
and duplicate grants return 409 with the existing `id`. PATCH honors `If-Match`.
Grant changes audit `share.create`, `share.update` and `share.delete` and apply on the next
request. Managers cannot change or remove an existing `manage` grant, including their own.

`endMembership` deletes personal grants, device logins and API key bindings, clears both feed
credential hashes, disables non-hosted accounts and erases their credentials in one tenant transaction.
It parks account targets, deletes push leases and marks calendars stale; synced data remains published
until an admin deletes the account. Afterwards it deletes the unbound key secrets and publishes auth
revocation. `/organization/leave` is disabled because Better Auth skips the removal hook there.
Bans are reversible and skip cleanup: ICS, feed CalDAV and provider jobs recheck membership before
opening a tenant transaction, as sessions, API keys and device logins already do. There is no backfill.

`pruneOrphanLinks` uses one SQL DELETE after grant removal, downgrade or member departure.
Calendar owners retain their own bearer links; other creators need current membership and admin,
personal manage or tenant-wide manage access. Link metadata includes `createdBy`, shown in the
Links tab. Departed owners appear as “Former member”; admins can still list their calendars and feeds.
API keys can only be issued from signed-in sessions; bearer keys cannot mint successors.

Calendar list and get include effective `access` and `owner: { id, name }`. Free-busy grants
receive only id, name, colour, kind, time zone, state, access and owner, with empty
`publicationIds` and neutral freshness. Other metadata is absent. Publication ids are empty
for all sharees; owners and tenant admins see them. The dashboard still groups by its visible
accounts, so shared calendars add no screen.

REST event reads use one shared projection before JSCalendar conversion, occurrence expansion
or iCalendar export. Exactly `read` uses `audience: 'member'`: restricted events become Busy
under the projection rules. Editors see stored details. Read-grant ETags append `.redacted` to
the stored revision; other reads and writes use the unsuffixed revision. GET sends
`Cache-Control: no-store` on both 200 and 304 responses, and changes tombstones retain source UIDs.
Soft-deleted calendars return 404 for event reads by grantees; owners and tenant admins can
still read retained events while they can restore the calendar. With `since`,
a live event now hidden by the member projection is also returned as a UID-only tombstone,
so the client discards its cached details; initial reads omit hidden events. Full
passthrough specs need no UID secret; other privacy modes reject a null key. SSE rechecks
accessible calendars on every wake, delivering resource changes at `read` and above.

Device CalDAV homes include calendars with actual personal or tenant-wide grants at `read`
and above under their `cal_…` segment, retaining the caller’s effective access. Tenant admin
status alone never adds a colleague’s calendar, and even admins need an actual readable grant;
free-busy grants have no collection. Own provider-calendar segments resolve first. Shared
display names append the owner's name. Read collections use the member projection and a
synthetic `<calId>.r` publication id, while writable hosted collections preserve stored names,
payloads and ETags. Crossing between read and write invalidates the old sync token, requiring a
resync for the changed hrefs and ETags. Every mutation rechecks its access level. A write
sharee's PROPPATCH returns 403 per property, and DELETE of a shared collection returns 403
`need-privileges`, even for a manager. Feed logins retain their original views.

The access levels map to `CalendarRights` in
[draft-ietf-jmap-calendars-33](https://www.ietf.org/archive/id/draft-ietf-jmap-calendars-33.html):
free-busy maps to `mayReadFreeBusy`; read adds `mayReadItems`; write adds `mayWriteAll`,
`mayUpdatePrivate` and `mayRSVP`; manage adds `mayShare`; owner adds `mayDelete`.
This is a rights mapping for a later facade, not a JMAP endpoint.

### Free-busy queries

`core.freeBusy` expands recurrence using the calendar zone, clips intervals to the window and
merges equal statuses. Busy wins where it overlaps tentative time. Cancelled and transparent
occurrences do not count; private events do. Expansion bounds propagate as `truncated`.
Floating and all-day times use the calendar zone, including daylight-saving transitions.

`POST /api/v1/free-busy` accepts UTC/offset `from`, `to` and up to 50 `calendarIds`; windows
must be positive and at most 62 days. Each calendar returns `busy` intervals with `start`,
`end` and `status` (`busy` or `tentative`), plus `truncated`. Missing, inaccessible and gone
calendars all return `{ error: 'not-accessible' }`. Resource reads run in one tenant transaction.

Device CalDAV collections advertise and handle the
[RFC 4791 §7.10 free-busy-query REPORT](https://www.rfc-editor.org/rfc/rfc4791.html#section-7.10).
Exactly one valid UTC time-range is required. The response is 200 `text/calendar`, with one
VFREEBUSY containing DTSTART, DTEND, DTSTAMP and BUSY or BUSY-TENTATIVE periods. Expansion
truncation returns 403 `number-of-matches-within-limits`. Feed logins return 403
`supported-report`; free-busy-only grantees use REST.

Cross-tenant sharing, invitation emails, CalDAV sharing extensions and per-user names, colours
and alerts are outside this interface. Event alarms belong to the event and editors share them.
