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
- Manage their name, colour, description, time zone and order from the dashboard or the API. Hosted
  calendars start unpublished; enable their publications to include them in feeds, ICS, read-only CalDAV,
  virtual calendars and sinks.
- Delete a hosted calendar reversibly for 30 days. Restore retains its events; publications stay
  disabled and removed virtual memberships must be added again. After 30 days, deletion is permanent.
- Store iCalendar events through one service layer, preserving raw payloads and unknown properties.
  Create, edit and delete events from calendar apps through read-write CalDAV; create and rename
  calendars there too. Each device gets its own named DAV login with a password shown once and
  immediate revocation. Feed logins stay read-only, and DAV logins grant no API or feed access.
  One device login also lists imported calendars enabled on the Calendars page, read-only with
  full event details, alongside shared calendars. Feed privacy and filters do not apply to the
  owner's device login; hosted calendars stay listed even when their feed publication is disabled.
  The dashboard also shows each hosted calendar's events and creates, edits and deletes them,
  including one occurrence or this and following. The REST API supports JSCalendar event reads and
  writes, and calendar apps stay fully supported.
- Keep at most 100 retained hosted calendars per user, with up to 50,000 objects per calendar and
  1 MiB per object. Attendees are stored as data; Supercal sends no invitations.

### Calendar sharing and free-busy

- Share a calendar with a colleague or everyone in the tenant from the Hosted screen or through the API. Free-busy grants
  expose busy time; read adds event details; write adds event editing; manage adds calendar
  metadata, shares and published links. Only owners and tenant admins can grant or remove
  manage access, delete a calendar or restore it. Imported calendars support free-busy and read.
- Read grants show private and confidential events as “Busy”. Write and manage grants show
  those events in full so editors can edit them. Shared calendar listings include the owner's
  name; publication membership remains visible only to the owner and tenant admins.
- Readable shared calendars appear in the recipient's device CalDAV home, named with the owner
  in parentheses. Tenant admin status adds no device collections by itself; an admin needs an
  explicit read-or-higher grant for a colleague's calendar. Writable hosted shares support event creation, editing and deletion. Calendar
  apps cannot delete a shared calendar, even with manage access. Changing between read and
  write requires a client resync because object addresses and ETags change.
- See one calendar's busy time, week by week, on its Availability tab on the Hosted screen. Query up to 50 calendars for a window of at most 62 days through `POST /api/v1/free-busy`.
  Results merge busy and tentative time, with busy taking precedence. Cancelled and transparent
  events do not count; private events do. Readable device CalDAV collections also support
  free-busy REPORT. Free-busy-only grants use REST and receive no event-change stream.
- Revoke a grant for the recipient's next request. Removing a tenant member deletes personal
  grants, device logins and API keys, clears feed credentials, and disables connected accounts while
  erasing their provider credentials. Their targets stop syncing; already synced events stay published
  until an admin deletes the account. Re-inviting requires new credentials and personal grants;
  tenant-wide grants apply to current members. A ban pauses authenticated access, feed subscriptions and syncing until it is lifted.
- A published link created by a grantee ends when they lose manage access or leave the tenant.
  Calendar owners' own links keep working without an account. The Links tab shows each creator.
- Sharing stays within one tenant; people outside it use published links. Invitation emails,
  CalDAV sharing extensions and per-user names, colours and alerts are not included. Event
  alarms are shared by everyone who can edit the event. A shared calendar cannot be republished
  in the recipient's feed.

### Feeds and publications

- Each user gets a default feed. Connected source calendars are published to it unless the user turns them off; hosted calendars start disabled. An account-level setting decides whether newly discovered calendars publish automatically.
- A publication can be renamed and recoloured without touching the source.
- **Virtual calendars** merge two or more source calendars (from any accounts) into one publication. A source calendar can sit in several virtual calendars and still be published on its own, or be hidden on its own while it still feeds a virtual calendar.
- When the same event appears in more than one member of a virtual calendar (e.g. an invite to both work and personal), it is shown once.
- **Privacy mode** per publication: `full`, `title-only`, `busy-only`. Owners see private events in full mode; title-only reduces them to busy-only. Published links always reduce private events to busy-only.
- **Event filters** per publication, kept deliberately small: hide declined, hide cancelled, hide all-day.
- Extra feeds can be created for sharing (e.g. a busy-only feed for an assistant), each with its own credentials and set of publications.
- Feed credentials: a CalDAV username/app password and a secret ICS token. Both can be rotated; rotating revokes the old one immediately.

### Subscribing

- One CalDAV login carries every publication in a feed (Apple Calendar, Thunderbird, DAVx5, Fantastical, BusyCal, Evolution).
- Apple devices get a one-tap configuration profile download.
- Every publication also has an ICS URL, and the feed has a combined ICS that flattens all publications into one calendar.
- Publish one hosted or imported calendar with a view-only link, managed for hosted calendars from the Hosted screen. Anyone holding the URL can subscribe without an account. Each calendar can have up to 20 links, each with an explicit `full`, `title-only` or `busy-only` privacy level, an optional label and expiry, and independent revocation. A client can receive full details while a personal website shows only busy time.
- Published links hide attendees, organizers, attachments, comments, alarms and custom event properties even in full mode. Events marked private or confidential show as “Busy”. Privacy is fixed at creation; create a new link to change it. The secret URL is shown once, with webcal, Google Calendar and Outlook subscription links. Deleting a calendar pauses its links; restoring it resumes them.
- One-click subscribe links for Google Calendar and Outlook, plus a QR code for phones.
- **Sinks**: for Google and Outlook users who need fast updates, Supercal mirrors chosen publications into calendars it creates in the user's own Google or Microsoft account. Sinks never send invitations and are never ingested back as sources. (Pending spike R10.)

### Real time

- Inbound: provider push (Google watch channels, Graph change notifications) where the deployment has a public HTTPS URL; adaptive polling everywhere else (seconds to minutes depending on provider and activity).
- Outbound: CalDAV and ICS reflect a change as soon as it is stored; clients pick it up on their next poll. Sinks and the dashboard receive it as a push.
- The dashboard shows changes live and shows the end-to-end freshness of each account.

### Management API

- REST under `/api/v1`, OpenAPI 3.1 spec at `/api/v1/openapi.json`, interactive docs at `/api/docs`.
- Authentication: session cookie (dashboard) or API key (automation). API keys are bound to one tenant and carry a role.
- Roles per tenant: `owner`, `admin`, `member`. Members manage their own accounts and feeds; admins manage everyone's in the tenant and invite or remove members; owners also manage tenant settings and roles through REST. A tenant must retain an owner. A platform `operator` role manages tenants across the install; operators cannot impersonate users or replace their passwords.
- Errors as RFC 9457 problem details; cursor pagination; `ETag`/`If-Match` on mutable resources to prevent lost updates.
- Server-sent events stream for live changes, scoped to what the caller may see.
- Every mutation is written to a tenant audit log, including invitations, joins, removals and role changes, with the acting user's identity. Self-service tenant deletion is disabled so its audit history remains available.

### Operations

- One image, configured by environment variables. `DATABASE_URL` is the only required external dependency; `SUPERCAL_PUBLIC_URL` and a master encryption key are required for production.
- Migrations run at boot under an advisory lock, or on demand.
- `/healthz`, `/readyz`, Prometheus `/metrics`, structured JSON logs.
- Sign-up mode: `open`, `invite`, or `disabled` (operator creates tenants through the API).
- User-supplied URLs cannot reach private networks unless the operator allowlists them.

## Web dashboard

Screens, in the order a new user meets them:

1. Sign up / sign in (email + password). With email configured, confirm your address, then sign in. If the link opens on another device, reset the password to finish setting up access. Password reset signs out existing sessions and revokes API keys and device logins; automation and calendar apps need new credentials. Read-only feed credentials stay valid so subscribers keep working.
2. Onboarding: connect the first account, watch calendars appear, get the subscribe step.
3. Accounts: list with health badges, add, reconnect, remove.
4. Calendars: every source calendar grouped by account, with hosted calendars in their own group; publish toggle, rename, colour, privacy.
5. Hosted: create, edit, reorder, delete and restore hosted calendars; a week and agenda view of each calendar's events, with create, edit and delete; import and export `.ics` files; calendars shared with you.
6. Virtual calendars: create by picking calendars; see the merged result.
7. Preview: week/agenda view of exactly what the feed publishes, updating live.
8. Subscribe: per-client instructions, CalDAV credentials, ICS links, QR code, Apple profile, Google/Outlook buttons, sinks.
9. Settings: profile, calendar apps (a CalDAV login per device), API keys, feed credential rotation, extra feeds.
10. Tenant admin: members and invitations, roles, audit log. Operator: tenants.

## Out of scope for v1

Writing changes back to source calendars, tasks (VTODO), scheduling/iTIP (accepting invites through Supercal), Exchange EWS, JMAP, per-tenant bring-your-own OAuth apps, billing.
