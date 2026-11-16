# Supercal

Bring your calendars together, then choose what to share.

Supercal is a self-hosted calendar hub for Google Calendar, Microsoft 365, iCloud, CalDAV servers, and ICS subscriptions. Connect several accounts, combine their calendars, and subscribe from your calendar app. You can also host calendars in Supercal and edit supported connected calendars through CalDAV.

For example, you can keep your work and personal calendars in separate accounts while giving your family one subscription that shows only when you are busy.

[Try it locally](#try-it-locally) · [Self-hosting guide](docs/self-hosting.md) · [Development](#development) · [Contributing](#contributing)

## What you can do

- Connect multiple accounts, discover their calendars automatically, and see when each one last synced.
- Merge selected calendars into a virtual calendar, with duplicate events shown once.
- Publish full details, titles only, or busy time. Filter out declined, cancelled, or all-day events.
- Subscribe through read-only CalDAV feeds or ICS links. Create separate links with their own privacy settings, expiry, and revocation.
- Create calendars in Supercal, import and export `.ics` files, and edit events in the dashboard or through a device's CalDAV login. Connected-calendar editing depends on the provider's permissions.
- Mirror a chosen publication into a dedicated Google calendar when a subscription's refresh schedule is too slow. These mirrors are one-way and do not send attendee invitations.
- Share an installation with a household or team using separate workspaces, member roles, calendar access grants, and an audit log.
- Automate through the same versioned REST API the dashboard uses, with API keys, interactive documentation, and live change notifications.

A **feed** is the set of calendars you publish for a subscriber. A **virtual calendar** combines several source calendars into one calendar in that feed. Neither changes how the source accounts organize their calendars.

## Calendar sources

| Source | Connection | Editing through Supercal |
| --- | --- | --- |
| Google Calendar | OAuth; the operator registers a Google app | With editing consent and permission to write to the calendar |
| Microsoft 365 / Outlook.com | OAuth; the operator registers a Microsoft app | With editing consent and permission to write to the calendar |
| iCloud | Apple Account and an app-specific password | When the calendar permits writes |
| Other CalDAV servers | Server URL, username, and password | When the calendar permits writes |
| ICS / webcal subscriptions | Calendar URL | Read-only |

CalDAV is an open protocol for accessing calendars. ICS is the standard `.ics` calendar format; an ICS subscription lets an app periodically fetch an updated copy.

Google and Microsoft require your own OAuth app registrations. iCloud, other CalDAV servers, ICS sources, and Supercal-hosted calendars do not need those registrations. See the [Google](docs/self-hosting.md#google) and [Microsoft](docs/self-hosting.md#microsoft) setup instructions.

## Try it locally

You need Git and Docker with the Compose plugin. The demo serves the dashboard at `http://localhost:4316` and stores its data in a Docker volume. You can try hosted calendars without connecting an external account.

This demo uses a public development encryption key and a sample database password. Keep it on localhost and use sample data. For real accounts or a public installation, follow the [production setup](docs/self-hosting.md#a-production-install-with-docker-compose).

Clone the repository and build the image:

```sh
git clone https://github.com/thatjuan/supercal.git
cd supercal
docker build -t supercal:local .
```

Save the following as `compose.yaml` in the repository directory:

```yaml
services:
  db:
    image: postgres:18
    environment:
      POSTGRES_USER: supercal
      POSTGRES_PASSWORD: local-demo-only
      POSTGRES_DB: supercal
    volumes:
      - pgdata:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U supercal -d supercal"]
      interval: 2s
      timeout: 5s
      retries: 30

  app:
    image: supercal:local
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "127.0.0.1:4316:4316"
    environment:
      DATABASE_URL: postgres://supercal:local-demo-only@db:5432/supercal
      SUPERCAL_PUBLIC_URL: http://localhost:4316
      SUPERCAL_INSECURE_DEV: "1"

volumes:
  pgdata:
```

Start the demo:

```sh
docker compose up -d
```

Once startup finishes, open [localhost:4316](http://localhost:4316) and create an account. The first user becomes the installation's operator. Create a hosted calendar to try the event editor, or add an ICS source to try importing a calendar.

To check startup logs, run `docker compose logs app`. To stop the demo, run `docker compose down`. Your data stays in the volume; `docker compose down --volumes` also deletes the demo data.

## Self-hosting

The [self-hosting guide](docs/self-hosting.md) covers production deployment, provider registration, configuration, backups, and upgrades.

Supercal runs as one application container plus Postgres 14 or newer. The application serves the dashboard, API, CalDAV, ICS feeds, and sync worker. Postgres stores its data and coordinates background jobs; Redis and a separate message broker are not required. The image runs as an unprivileged user and can use a read-only root filesystem.

For a production installation:

- Use a public HTTPS URL and a reverse proxy that forwards WebDAV methods.
- Set your own encryption and session keys. Back them up alongside the database.
- Use separate database logins for migrations and normal operation, as described in the guide.
- Register OAuth apps for Google or Microsoft if you want those providers.
- Configure email if you want Supercal to send account verification, invitation, and password-reset messages.

The service exposes `/healthz` for liveness, `/readyz` for readiness, and optional Prometheus metrics at `/metrics`. API documentation is available at `/api/docs`, with the OpenAPI specification at `/api/v1/openapi.json`.

## Sync behavior and current limits

Supercal is early-stage software. Calendar-app interoperability has not been verified across every supported protocol and client. The [verification record](docs/verification.md) distinguishes real-client observations from automated and HTTP-only checks.

- Supercal receives provider push notifications where supported and polls otherwise. Your subscribing calendar app still controls when it fetches CalDAV or ICS updates. Google Calendar and Outlook can take hours to refresh an ICS subscription.
- Feed subscriptions are read-only. For editing, create a separate device login under **Settings → Calendar apps**. That login exposes hosted calendars, enabled connected calendars, and calendars shared with you, subject to their write permissions.
- Meeting scheduling, accepting invitations, and attendee notifications are not a complete workflow in Supercal. Google device-created events use a private import; Microsoft can send attendee notifications for provider writes. Review the [provider behavior](docs/product.md#hosted-calendars) before using attendee-bearing events.
- Google mirrors are separate, one-way copies. Microsoft mirroring is not implemented.
- Supercal handles calendar events, not VTODO/task lists.
- Build the container from source. There is no published container image or hosted service supplied by this repository.

Feed URLs and device passwords grant access to calendar data. Treat them as credentials and rotate or revoke them when they are no longer needed. Provider credentials are encrypted in Postgres; calendar event data is stored so it can be synced and published.

## Development

The project uses TypeScript, Bun, React, Vite, Tailwind CSS, Drizzle, and Postgres. Bun is pinned to **1.3.4** in the repository and Dockerfile.

Install dependencies:

```sh
bun install --frozen-lockfile
```

Create an empty development database on Postgres 14 or newer. Its owner must be able to create the roles used by migrations; see [database setup](docs/self-hosting.md#database-setup). Create a local `.env`, replacing the sample connection string with your own:

```dotenv
DATABASE_URL=postgres://postgres:postgres@localhost:5432/supercal_dev
SUPERCAL_PUBLIC_URL=http://localhost:4316
SUPERCAL_INSECURE_DEV=1
WEB_ORIGIN=http://localhost:5173
```

Run the daemon in one terminal:

```sh
bun run dev
```

Run the dashboard in another:

```sh
bun run --cwd apps/web dev
```

Open [localhost:5173](http://localhost:5173). Vite forwards API requests to the daemon on port 4316. Migrations run automatically when the daemon starts.

### Checks

```sh
bun run typecheck
bun run test
```

Database-backed tests need `TEST_DATABASE_URL` pointing to a disposable Postgres 18 instance whose login can create and drop databases. They create scratch databases and skip when the variable is unset. TLS transport tests also need OpenSSL on `PATH`.

`bun run check` additionally checks the generated API client and configuration documentation. Browser tests use `bun run test:e2e` and require `TEST_DATABASE_URL` plus Playwright's Chromium installation. `bun run build` produces a compiled daemon at `dist/supercal` and the dashboard at `dist/web`.

### Repository map

| Path | Contents |
| --- | --- |
| [`apps/daemon`](apps/daemon) | HTTP API, authentication, sync jobs, CalDAV server, ICS feeds, and Google mirrors |
| [`apps/web`](apps/web) | React dashboard |
| [`packages/providers`](packages/providers) | Provider adapters, credentials, and guarded HTTP transport |
| [`packages/core`](packages/core) | Event normalization, recurrence, merging, and privacy projection |
| [`packages/db`](packages/db) | Drizzle schema, migrations, tenant isolation, and secret encryption |
| [`packages/api-client`](packages/api-client) | Generated API schema and typed client |
| [`spikes`](spikes) | Earlier experiments and their findings; not required to run the application |

## Documentation

- [Self-hosting guide](docs/self-hosting.md): deployment and operations.
- [Product reference](docs/product.md): feeds, sharing, permissions, and provider behavior.
- [Architecture](docs/architecture.md): data model, protocols, and implementation decisions.
- [Client verification](docs/verification.md): observed compatibility and outstanding checks.

Some design documents and spike findings describe earlier stages of the project. Check the implementation and current issues when working from those records.

## Contributing

Bug reports, documentation improvements, and focused pull requests are welcome. Start with the [issue tracker](https://github.com/thatjuan/supercal/issues) to check for an existing discussion.

For a bug report, include the revision you are running, the provider and calendar app involved, what you expected, and steps to reproduce it. Remove account credentials, private calendar URLs, and personal event details from logs and screenshots.

For a pull request, describe the behavior it changes and how you checked it. Add tests when they help demonstrate that behavior. Larger protocol changes are easier to review if you open an issue first.

## License

[MIT](LICENSE).
