# Supercal: architecture brief (pre-spike)

This is the working hypothesis the derisking spikes test. Anything marked **H** is a hypothesis a spike must confirm or overturn. The final architecture lives in `docs/architecture.md` once the spikes report.

## Team

| Callsign | Model | Owns |
| --- | --- | --- |
| Almanac | Opus 5.5 (chief architect, coordinator) | Product definition, architecture, integration of findings, issue capture |
| Meridian | Opus 5.5 | Spike: feed output (CalDAV server, ICS, client compatibility) → `spikes/feed/` |
| Astrolabe | Codex Astra (`gpt-6-astra`) | Spike: ingestion (providers, sync, SSRF, sinks) → `spikes/ingest/` |
| Gnomon | Codex Sol (`gpt-6.1-sol`) | Spike: platform (API, auth, tenancy, DB, scheduler, container) → `spikes/platform/` |

## Product in one paragraph

Supercal is a containerised, multitenant daemon. A user connects calendar accounts from any major provider. Supercal syncs them continuously and republishes them as one **feed**: a single subscription that carries every calendar the user chose to publish, plus **virtual calendars** that merge two or more source calendars into one. Any major calendar client can subscribe. A versioned OpenAPI management API drives everything, and a React web dashboard is built on that same API.

## Vocabulary

- **Tenant**: an organisation (Better Auth organization). Holds members, accounts and feeds. All data is tenant-scoped.
- **Account**: a connection to a provider (a Google login, an M365 mailbox, an iCloud CalDAV login, a single ICS URL).
- **Source calendar**: one calendar discovered inside an account.
- **Feed**: the published bundle. It has its own credentials: a CalDAV app password and a secret ICS token. A user has one by default; the model allows several (e.g. a "work-only" feed for sharing).
- **Publication**: one calendar inside a feed. Either *passthrough* (one source calendar) or *virtual* (a merge of several). Each publication has a name, colour and privacy mode (`full`, `title-only`, `busy-only`).
- **Sink**: optional push target. Supercal writes a publication into a calendar it owns inside a Google or Microsoft account, so clients that only poll ICS slowly still get updates within seconds. (**H**: feasible within quotas, without sending invites, and without sync loops.)

## Delivery paths to clients

| Client | Path | Freshness |
| --- | --- | --- |
| Apple Calendar (macOS/iOS), Fantastical, BusyCal | CalDAV account (one login → all publications); one-tap `.mobileconfig` | client poll, ~1–15 min |
| Thunderbird, Evolution, KOrganizer, DAVx5 (Android) | CalDAV autodiscovery | client poll, configurable |
| Google Calendar | ICS URL per publication, or a Google sink | ICS: hours (Google controls it); sink: seconds |
| Outlook (web/new/classic) | ICS URL per publication, or a Microsoft sink | ICS: hours; sink: seconds |
| Anything else | ICS (`webcal://`), combined ICS of the whole feed | client poll |
| Dashboard / API consumers | REST + jCal + SSE stream | live |

A true push to third-party clients is only possible through sinks. We will say so plainly in the product.

## Ingestion

| Provider | Protocol | Change detection |
| --- | --- | --- |
| Google Calendar | Calendar API v3, OAuth2 | `syncToken` incremental + `events.watch` push → fallback poll |
| Microsoft 365 / Outlook.com | Graph, OAuth2 (MSAL, `common`) | delta query + change-notification subscriptions → fallback poll |
| iCloud | CalDAV, app-specific password | `sync-collection` poll |
| Fastmail, Nextcloud, Zoho, Yahoo, Synology, Radicale, Baïkal, SOGo… | generic CalDAV | `sync-collection`, fallback ctag/etag diff |
| ICS / webcal URL (Proton share links, public feeds) | HTTP GET | conditional GET (ETag / If-Modified-Since) |

Out of scope for v1: Exchange EWS (deprecated by Microsoft), JMAP calendars, VTODO, writing back to sources.

## Architecture hypothesis

- One Bun container image, one codebase. `SUPERCAL_ROLES=api,dav,worker` picks the roles a process runs (default: all). Horizontal scale = more replicas.
- Bun workspaces monorepo:
  - `apps/daemon`: Hono server: `/api/v1` (management), `/api/auth` (Better Auth), `/.well-known/caldav` + `/dav` (read-only CalDAV), `/ics` (feeds), `/hooks` (provider webhooks), worker loop. Serves the built web app as static files.
  - `apps/web`: React + Vite + TanStack Router + React Query + Tailwind; typed client generated from OpenAPI.
  - `packages/core`: event model, normalisation, recurrence, iCalendar parse/emit, projections.
  - `packages/providers`: provider adapters behind one interface.
  - `packages/db`: Drizzle schema and migrations.
  - `packages/api-client`: generated OpenAPI client.
- API: Hono + `@hono/zod-openapi` (zod v4; perf is not a concern on the management plane). OpenAPI 3.1, RFC 9457 problem details, cursor pagination. **H**
- Auth: Better Auth with organization (tenancy and roles), apiKey (machine access), admin (operator) plugins. Session cookies for the dashboard, API keys for automation. Feed access uses separate per-feed credentials, never the user's login. **H**
- Tenancy: `tenant_id` on every tenant table, enforced in the data layer, Postgres RLS as defence in depth. **H**
- Storage: events stored as normalised *resources* (a master component plus its overrides, keyed by UID) in jsonb with derived range columns; raw provider payload kept for re-normalisation.
- Change log: global `bigserial` change sequence per source-calendar change. A publication's CalDAV `sync-token` is `epoch:seq`. Membership or projection changes bump the epoch and invalidate old tokens (RFC 6578 allows this). **H**
- Real-time fan-out: worker commits changes → `NOTIFY` → every replica invalidates render caches, pushes SSE to dashboards, and enqueues sink writes. **H**
- Scheduling: per-calendar sync state rows leased with `FOR UPDATE SKIP LOCKED`, adaptive `next_run_at`, backoff with jitter. No generic queue unless the spike shows we need one. **H**
- Secrets: provider tokens and passwords encrypted with AES-256-GCM under a versioned master key from env. Feed tokens stored as SHA-256 hashes.
- Outbound fetches of user-supplied URLs (ICS, CalDAV) go through an SSRF guard: resolve, pin and block private/loopback/link-local/metadata ranges unless an operator allowlist permits them.

## Risk register (what the spikes attack)

| # | Risk | Spike |
| --- | --- | --- |
| R1 | Bun/Hono mishandle WebDAV verbs (PROPFIND, REPORT) or XML bodies | Meridian |
| R2 | Our read-only CalDAV server is rejected or misread by real clients | Meridian |
| R3 | iCalendar libraries lose fidelity (overrides, VTIMEZONE, floating/all-day) | Meridian |
| R4 | UID handling across passthrough and merged calendars causes duplicates or collisions | Meridian |
| R5 | `epoch:seq` sync tokens are wrong under concurrent writes or membership change | Meridian |
| R6 | Google/Graph incremental sync and push have limits that break "real time" | Astrolabe |
| R7 | Graph recurrence and Windows time zones do not map cleanly to iCalendar | Astrolabe |
| R8 | Generic CalDAV servers vary too much (no sync-collection, quirks) | Astrolabe |
| R9 | User-supplied URLs open SSRF | Astrolabe |
| R10 | Sinks are infeasible (quotas, invites, loops, scope sensitivity) | Astrolabe |
| R11 | Google OAuth verification / testing-mode token expiry blocks self-hosters | Astrolabe |
| R12 | Better Auth plugins (org, apiKey) do not compose with Hono + OpenAPI on Bun | Gnomon |
| R13 | Bun Postgres drivers lack LISTEN/NOTIFY or play badly with Drizzle/RLS | Gnomon |
| R14 | Lease scheduler is unsafe across replicas | Gnomon |
| R15 | Single-binary container build breaks (Better Auth, migrations) | Gnomon |
| R16 | OpenAPI → typed client → React Query path is clumsy | Gnomon |
