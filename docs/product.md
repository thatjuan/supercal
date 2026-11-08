# Supercal: product definition

Supercal aggregates many calendar accounts into one feed that any major calendar client can subscribe to. It runs as a single container, serves many tenants, and is driven entirely by a versioned management API. The web dashboard is a client of that API and has no private back door.

Vocabulary (tenant, account, source calendar, feed, publication, sink) is defined in `docs/brief.md` and used here without restating it.

## Who uses it

- **Individuals** who live in three calendars (work Google, personal iCloud, a client's M365) and want one view everywhere, including on a phone that can hold only one work profile.
- **Teams and assistants** who share one person's combined availability (busy-only) without exposing details.
- **Operators** who self-host Supercal for a household, company or as a service, and integrate it through the API.

## Capabilities

### Accounts and calendars

- Connect accounts: Google (OAuth), Microsoft 365 / Outlook.com (OAuth), iCloud (app-specific password), any CalDAV server (server URL + credentials, discovered via `/.well-known/caldav`), any ICS/webcal URL.
- Supercal discovers the account's calendars and keeps discovering: new calendars appear automatically, removed ones are retired.
- Per account: sync status, last success, last error, next run, and whether push is active or Supercal fell back to polling.
- Reconnect flow when credentials expire or are revoked; the account stays, its data stays visible but stale, and the dashboard says why.
- Per source calendar: provider name, colour, time zone, and whether the provider is still sending it.

### Hosted calendars

- Create calendars whose events live in Supercal, alongside calendars imported from providers.
- Manage their name, colour, description, time zone and order through the API. Hosted calendars
  start unpublished; enable their publications to include them in feeds, ICS, read-only CalDAV,
  virtual calendars and sinks.
- Delete a hosted calendar reversibly for 30 days. Restore retains its events; publications stay
  disabled and removed virtual memberships must be added again. After 30 days, deletion is permanent.
- Store iCalendar events through one service layer, preserving raw payloads and unknown properties.
  Event REST writes and writable CalDAV follow in #25 and #26; the dashboard adds no event editor.
- Keep at most 100 retained hosted calendars per user, with up to 50,000 objects per calendar and
  1 MiB per object. Attendees are stored as data; Supercal sends no invitations.

### Feeds and publications

- Each user gets a default feed. Connected source calendars are published to it unless the user turns them off; hosted calendars start disabled. An account-level setting decides whether newly discovered calendars publish automatically.
- A publication can be renamed and recoloured without touching the source.
- **Virtual calendars** merge two or more source calendars (from any accounts) into one publication. A source calendar can sit in several virtual calendars and still be published on its own, or be hidden on its own while it still feeds a virtual calendar.
- When the same event appears in more than one member of a virtual calendar (e.g. an invite to both work and personal), it is shown once.
- **Privacy mode** per publication: `full`, `title-only`, `busy-only`. Source events marked private stay private in every mode.
- **Event filters** per publication, kept deliberately small: hide declined, hide cancelled, hide all-day.
- Extra feeds can be created for sharing (e.g. a busy-only feed for an assistant), each with its own credentials and set of publications.
- Feed credentials: a CalDAV username/app password and a secret ICS token. Both can be rotated; rotating revokes the old one immediately.

### Subscribing

- One CalDAV login carries every publication in a feed (Apple Calendar, Thunderbird, DAVx5, Fantastical, BusyCal, Evolution).
- Apple devices get a one-tap configuration profile download.
- Every publication also has an ICS URL, and the feed has a combined ICS that flattens all publications into one calendar.
- One-click subscribe links for Google Calendar and Outlook, plus a QR code for phones.
- **Sinks**: for Google and Outlook users who need fast updates, Supercal mirrors chosen publications into calendars it creates in the user's own Google or Microsoft account. Sinks never send invitations and are never ingested back as sources. (Pending spike R10.)

### Real time

- Inbound: provider push (Google watch channels, Graph change notifications) where the deployment has a public HTTPS URL; adaptive polling everywhere else (seconds to minutes depending on provider and activity).
- Outbound: CalDAV and ICS reflect a change as soon as it is stored; clients pick it up on their next poll. Sinks and the dashboard receive it as a push.
- The dashboard shows changes live and shows the end-to-end freshness of each account.

### Management API

- REST under `/api/v1`, OpenAPI 3.1 spec at `/api/v1/openapi.json`, interactive docs at `/api/docs`.
- Authentication: session cookie (dashboard) or API key (automation). API keys are bound to one tenant and carry a role.
- Roles per tenant: `owner`, `admin`, `member`. Members manage their own accounts and feeds; admins manage everyone's in the tenant; owners also manage tenant settings and membership. A platform `operator` role manages tenants across the install.
- Errors as RFC 9457 problem details; cursor pagination; `ETag`/`If-Match` on mutable resources to prevent lost updates.
- Server-sent events stream for live changes, scoped to what the caller may see.
- Every mutation is written to a tenant audit log.

### Operations

- One image, configured by environment variables. `DATABASE_URL` is the only required external dependency; `SUPERCAL_PUBLIC_URL` and a master encryption key are required for production.
- Migrations run at boot under an advisory lock, or on demand.
- `/healthz`, `/readyz`, Prometheus `/metrics`, structured JSON logs.
- Sign-up mode: `open`, `invite`, or `disabled` (operator creates tenants through the API).
- User-supplied URLs cannot reach private networks unless the operator allowlists them.

## Web dashboard

Screens, in the order a new user meets them:

1. Sign up / sign in (email + password; magic link when an email provider is configured).
2. Onboarding: connect the first account, watch calendars appear, get the subscribe step.
3. Accounts: list with health badges, add, reconnect, remove.
4. Calendars: every source calendar grouped by account; publish toggle, rename, colour, privacy.
5. Virtual calendars: create by picking calendars; see the merged result.
6. Preview: week/agenda view of exactly what the feed publishes, updating live.
7. Subscribe: per-client instructions, CalDAV credentials, ICS links, QR code, Apple profile, Google/Outlook buttons, sinks.
8. Settings: profile, API keys, feed credential rotation, extra feeds.
9. Tenant admin: members and invitations, roles, audit log. Operator: tenants.

## Out of scope for v1

Writing changes back to source calendars, tasks (VTODO), scheduling/iTIP (accepting invites through Supercal), Exchange EWS, JMAP, per-tenant bring-your-own OAuth apps, billing.
