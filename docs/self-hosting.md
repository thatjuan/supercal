# Self-hosting Supercal

Supercal ships as one container image. It holds a single compiled binary, which serves the API, the dashboard, the CalDAV and ICS feeds and the sync worker, and it keeps all of its state in Postgres. This guide takes you from nothing to a working install, then covers the Google and Microsoft app registrations, upgrades, scaling and backups.

## Requirements

- **Postgres 14 or newer.** It is the only stateful dependency. Supercal also uses it for scheduling and for signalling between replicas (LISTEN/NOTIFY), so connect it directly: a transaction-pooling proxy such as PgBouncer in transaction mode breaks LISTEN.
- **A public HTTPS URL**, such as `https://cal.example.com`. Apple Calendar will not send credentials to a CalDAV server over plain HTTP, Google and Microsoft deliver push notifications only to HTTPS endpoints, and OAuth redirect URIs must use HTTPS for anything but `localhost`. Put Supercal behind a reverse proxy that terminates TLS (the Compose example below uses Caddy).
- **Docker**, or any runtime for OCI images, on a machine that can build for its own architecture.

## Building the image

There is no published image yet. Build it from a checkout; the tag is the daemon version in `apps/daemon/package.json`:

```sh
git clone https://github.com/thatjuan/supercal.git
cd supercal
docker build -t supercal:0.1.0 .
```

The build takes about a minute and produces an image of roughly 130 MB. To run it on other machines, push it to a registry you control:

```sh
docker tag supercal:0.1.0 registry.example.com/supercal:0.1.0
docker push registry.example.com/supercal:0.1.0
```

The image runs as the unprivileged user 65532 and listens on port 4316.

## Quick start

### Trying it on one machine

This starts a throwaway Postgres and Supercal on `http://localhost:4316`. `SUPERCAL_INSECURE_DEV=1` allows plain HTTP and encrypts stored secrets with a fixed public development key, so never use it for real accounts.

```sh
docker network create supercal-trial
docker run -d --name supercal-trial-db --network supercal-trial -e POSTGRES_PASSWORD=trial postgres:18
docker run -d --name supercal-trial --network supercal-trial -p 4316:4316 \
  -e DATABASE_URL=postgres://postgres:trial@supercal-trial-db:5432/postgres \
  -e SUPERCAL_PUBLIC_URL=http://localhost:4316 \
  -e SUPERCAL_INSECURE_DEV=1 \
  supercal:0.1.0
```

If Supercal starts before Postgres accepts connections, it exits; run `docker start supercal-trial` again. Open `http://localhost:4316` and sign up. The first account on an empty install becomes the operator and gets its own tenant. Remove everything afterwards with `docker rm -f supercal-trial supercal-trial-db && docker network rm supercal-trial`.

### A production install with Docker Compose

This Compose file runs Postgres, Supercal and Caddy, which obtains a TLS certificate for your domain from Let's Encrypt. Point the domain's DNS at the machine and open ports 80 and 443 first.

Create a directory with three files. `.env` holds the settings and secrets; generate each secret separately:

```sh
SUPERCAL_DOMAIN=cal.example.com
POSTGRES_PASSWORD=          # openssl rand -hex 24
SUPERCAL_OWNER_PASSWORD=    # openssl rand -hex 24
SUPERCAL_RUNTIME_PASSWORD=  # openssl rand -hex 24
SUPERCAL_KEYS=v1:           # v1: followed by the output of openssl rand -base64 32
BETTER_AUTH_SECRET=         # openssl rand -hex 32
SUPERCAL_METRICS_TOKEN=     # openssl rand -hex 32
```

`initdb/supercal.sh` creates the database and its logins the first time Postgres starts (the database setup section explains them):

```sh
#!/bin/sh
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<SQL
CREATE ROLE supercal_owner LOGIN PASSWORD '$SUPERCAL_OWNER_PASSWORD';
CREATE ROLE supercal_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE supercal_control NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT supercal_app, supercal_control TO supercal_owner WITH ADMIN OPTION;
CREATE ROLE supercal_runtime LOGIN PASSWORD '$SUPERCAL_RUNTIME_PASSWORD';
GRANT supercal_app, supercal_control TO supercal_runtime;
CREATE DATABASE supercal OWNER supercal_owner;
SQL
```

`compose.yaml`:

```yaml
services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      SUPERCAL_OWNER_PASSWORD: ${SUPERCAL_OWNER_PASSWORD}
      SUPERCAL_RUNTIME_PASSWORD: ${SUPERCAL_RUNTIME_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql
      - ./initdb:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U postgres"]
      interval: 2s
      retries: 30
    restart: unless-stopped

  supercal:
    image: supercal:0.1.0
    depends_on:
      postgres:
        condition: service_healthy
    read_only: true
    tmpfs:
      - /tmp
    environment:
      DATABASE_URL: postgres://supercal_runtime:${SUPERCAL_RUNTIME_PASSWORD}@postgres:5432/supercal
      DATABASE_MIGRATION_URL: postgres://supercal_owner:${SUPERCAL_OWNER_PASSWORD}@postgres:5432/supercal
      SUPERCAL_PUBLIC_URL: https://${SUPERCAL_DOMAIN}
      SUPERCAL_CLIENT_IP_HEADER: X-Forwarded-For
      SUPERCAL_KEYS: ${SUPERCAL_KEYS}
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET}
      SUPERCAL_METRICS_TOKEN: ${SUPERCAL_METRICS_TOKEN}
    restart: unless-stopped

  caddy:
    image: caddy:2
    command: caddy reverse-proxy --from ${SUPERCAL_DOMAIN} --to supercal:4316
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - caddy:/data
    restart: unless-stopped

volumes:
  pgdata:
  caddy:
```

Caddy replaces client-sent `X-Forwarded-For` by default, so Supercal can trust that header for login throttles and auth rate limits.

Make the init script executable and start the stack:

```sh
chmod +x initdb/supercal.sh
docker compose up -d
docker compose logs -f supercal
```

Supercal logs one JSON object per line. Once you see `migrations applied` and `listening`, open `https://cal.example.com` and sign up as the operator. Add the provider settings from the Google and Microsoft sections to the `environment` block when you are ready, then run `docker compose up -d` again.

### Running the container elsewhere

Keep these in mind on Kubernetes, Nomad or plain `docker run`:

- **Probes.** The image has no shell, so it has no `HEALTHCHECK`. Point your orchestrator at `GET /healthz` for liveness (the process is up) and `GET /readyz` for readiness. `/readyz` answers 200 only when the database answers `select 1` within one second, the database's newest migration is the one this binary ships, the notification listener is connected, and, in a process with the `worker` role, the scheduler has ticked in the last 30 seconds. Otherwise it answers 503 with the failing checks, such as `{"status":"not ready","failing":["bus"]}`.
- **Read-only root filesystem.** Supported, but `/tmp` must stay writable: migrations are written to a temporary directory before they are applied. Mount a tmpfs there (`--read-only --tmpfs /tmp` with `docker run`).
- **Metrics.** `GET /metrics` serves Prometheus text: sync duration and errors per provider, lost leases, recorded changes, notification lag, feed requests by kind and status, ICS cache hits and misses, push subscriptions by provider and state, and sink writes. Set `SUPERCAL_METRICS_TOKEN` and send `Authorization: Bearer <token>` to scrape it. Without a token, the endpoint returns 404 unless `SUPERCAL_INSECURE_DEV=1`.
- **Time zone data.** Supercal converts zoned times with the time zone rules in Bun's built-in ICU data, which can lag behind tzdata. The image ships newer ICU rule files in `/app/icu-tz` and sets `ICU_TIMEZONE_FILES_DIR=/app/icu-tz` so ICU loads them instead; keep that variable if you override the environment. Running the binary outside the image, point `ICU_TIMEZONE_FILES_DIR` at the same four `.res` files (the Dockerfile names them), or times in zones whose rules changed recently, such as `America/Vancouver` from November 2026, are off by the change.
- **Client addresses.** Set `SUPERCAL_CLIENT_IP_HEADER` only when a proxy you run overwrites or appends that header; otherwise clients can forge it. When unset, login throttles and auth rate limits use the socket peer.
- **Shutdown.** On SIGTERM, Supercal stops accepting requests, hands back its sync leases and exits within ten seconds.

## Database setup

### Two credentials (recommended)

Supercal runs every query inside a transaction that switches to one of two restricted roles, which migrations create if they do not exist:

- `supercal_app` reads and writes tenant data, and row-level security limits it to one tenant per transaction.
- `supercal_control` performs the few lookups that happen before a tenant is known, such as claiming sync jobs and resolving feed logins.

The recommended setup gives Supercal two logins. `DATABASE_MIGRATION_URL` is the schema owner, used only to apply migrations. `DATABASE_URL` is a login that belongs to both roles and owns nothing, so even a bug that escaped the role switch could not change the schema or read past row-level security. As a Postgres superuser:

```sql
CREATE ROLE supercal_owner LOGIN PASSWORD 'owner-password';
CREATE ROLE supercal_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE supercal_control NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT supercal_app, supercal_control TO supercal_owner WITH ADMIN OPTION;
CREATE ROLE supercal_runtime LOGIN PASSWORD 'runtime-password';
GRANT supercal_app, supercal_control TO supercal_runtime;
CREATE DATABASE supercal OWNER supercal_owner;
```

Then set:

```sh
DATABASE_URL=postgres://supercal_runtime:runtime-password@db.example.com:5432/supercal
DATABASE_MIGRATION_URL=postgres://supercal_owner:owner-password@db.example.com:5432/supercal
```

Roles are cluster-wide. If several Supercal databases share one Postgres cluster, they share `supercal_app` and `supercal_control`; create the roles once and grant them to each install's logins.

On a managed Postgres without superuser access, run the same statements as the administrative user the provider gives you. It needs to be able to create roles (the `CREATEROLE` attribute).

### One credential

For a small install, `DATABASE_URL` alone can name the schema owner, and Supercal applies migrations with it too. This is weaker: the restricted roles still apply to every query that goes through Supercal's transaction wrappers, but a code path that escaped them would run with the owner's rights, including DDL. The owner must be able to create roles, or the two roles must exist beforehand with the owner granted `WITH ADMIN OPTION`, as above.

## Configuration

Supercal reads its configuration from environment variables once at startup. An invalid value stops it with a message that names the variable and never prints the value. Empty values count as unset. `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` must not be set (see the LAN section).

<!-- config-table:start (generated by `bun run docs:config`; edit the descriptions in apps/daemon/src/config.ts) -->
| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PORT` |  | `4316` | Port the HTTP server listens on. |
| `DATABASE_URL` | yes |  | Postgres connection URL the daemon runs on. Recommended: a login that is a member of `supercal_app` and `supercal_control` and owns nothing. |
| `DATABASE_MIGRATION_URL` |  |  | Postgres URL of the schema owner, used only to apply migrations. Defaults to `DATABASE_URL` (single-URL mode). |
| `SUPERCAL_PUBLIC_URL` | production |  | Public https base URL, used in feed links, OAuth redirect URIs and push webhooks. Required unless `SUPERCAL_INSECURE_DEV=1`. |
| `SUPERCAL_CLIENT_IP_HEADER` |  |  | Header holding the client address, set by a reverse proxy you run. When unset, the socket peer is used. |
| `SUPERCAL_KEYS` | production |  | Master keys for secrets at rest, `v2:<base64 32 bytes>,v1:…`; the first one encrypts. Required unless `SUPERCAL_INSECURE_DEV=1`. |
| `BETTER_AUTH_SECRET` | production |  | Secret that signs sessions and OAuth state; at least 32 random characters. Required unless `SUPERCAL_INSECURE_DEV=1`. |
| `SUPERCAL_ROLES` |  | `api,dav,worker` | Comma list of roles this process runs: `api` (API and dashboard), `dav` (CalDAV and ICS feeds), `worker` (sync). |
| `SUPERCAL_MIGRATE` |  | `auto` | `auto` applies migrations at boot under an advisory lock; `off` leaves them to `supercal migrate`. |
| `SUPERCAL_SIGNUP` |  | `invite` | Who may create an account: anyone (`open`), invitees (`invite`) or nobody (`disabled`). The first user always may, and becomes the operator. |
| `SUPERCAL_INSECURE_DEV` |  | `0` | `1` allows plain http, a built-in development key and insecure cookies. Never in production. |
| `GOOGLE_CLIENT_ID` |  |  | Google OAuth client id; enables Google accounts. Set together with `GOOGLE_CLIENT_SECRET`. |
| `GOOGLE_CLIENT_SECRET` |  |  | Google OAuth client secret. |
| `MICROSOFT_CLIENT_ID` |  |  | Microsoft Entra application (client) id; enables Microsoft accounts. Set together with `MICROSOFT_CLIENT_SECRET`. |
| `MICROSOFT_CLIENT_SECRET` |  |  | Microsoft Entra client secret value. |
| `SUPERCAL_EGRESS_ALLOW` |  |  | LAN servers accounts may reach, as `https://host[:port]=cidr` entries separated by commas. |
| `SUPERCAL_ICS_CACHE_MB` |  | `64` | Memory bound, in MiB, of the cache of rendered ICS feeds. |
| `SUPERCAL_SYNC_CONCURRENCY` |  | `8` | Sync jobs a worker process runs at once (at most 2 per account; one tenant uses at most half, rounded up). |
| `SUPERCAL_METRICS_TOKEN` |  |  | Required to enable `/metrics` unless `SUPERCAL_INSECURE_DEV=1`; when set, requires `Authorization: Bearer <token>`. |
| `RESEND_API_KEY` |  |  | Resend API key. With `MAIL_FROM`, enables verification, password-reset and invitation email. |
| `MAIL_FROM` |  |  | Sender of that email, such as `Supercal <cal@example.com>`, on a domain verified in Resend. |
| `WEB_ORIGIN` |  |  | Extra trusted origin for the Vite dev server, such as `http://localhost:5173`. Development only. |
| `SUPERCAL_WEB_DIR` |  |  | Directory of the built dashboard. Defaults to `web/` next to the binary; the image sets `/app/web`. |
<!-- config-table:end -->

## Email

Supercal sends email through [Resend](https://resend.com) when both `RESEND_API_KEY` and `MAIL_FROM` are set. Add and verify your sending domain in Resend, create an API key with sending access, and set `MAIL_FROM` to an address on that domain, such as `Supercal <cal@example.com>`.

With email on, new accounts must confirm their address before they can sign in, and Supercal mails invitation and password-reset messages. Without it, nobody needs to confirm an address, and admins copy invitation and password-reset links from the dashboard to send themselves.

## Google

Google accounts need an OAuth client of your own. These steps use the Google Cloud console at <https://console.cloud.google.com>; Google moves its menus around from time to time, so look for the same names if a path differs.

1. Create a project (or pick an existing one) in the project selector.
2. Open **APIs & Services → Library**, search for **Google Calendar API**, and enable it.
3. Open **Google Auth Platform** (formerly the OAuth consent screen) and fill in **Branding**: the app name your users will see, a support email, and your domain under authorized domains. Under **Audience**, choose **External**, unless every user is in your own Google Workspace organization, in which case choose **Internal** and skip the publishing and verification steps below.
4. Under **Data access**, add exactly these scopes:
   - `openid`
   - `.../auth/userinfo.email`
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
   - `https://www.googleapis.com/auth/calendar.events.readonly`
5. Under **Clients**, create an OAuth client of type **Web application**. Add one authorized redirect URI: your `SUPERCAL_PUBLIC_URL` followed by `/api/v1/oauth/google/callback`, for example `https://cal.example.com/api/v1/oauth/google/callback`. It must match exactly, with no trailing slash.
6. Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` and restart Supercal. Users can now connect Google accounts from the dashboard.
7. **Publish the app.** Under **Audience**, click **Publish app** to move it from Testing to In production. An app left in Testing issues refresh tokens that expire after seven days, so every connected Google account would stop syncing each week and need reconnecting. The dashboard marks such accounts as needing reauthorization.

After publishing, Google shows an "unverified app" warning on the consent screen until the app passes verification, because the calendar scopes are sensitive. You do not need verification if the app is for your own use or has fewer than 100 users: users click **Advanced** and continue past the warning, and Google caps an unverified app at 100 users. A service open to the public should apply for verification under **Verification Center**. Google's rules are in its help pages on [verification exceptions](https://support.google.com/cloud/answer/13464323) and [unverified app limits](https://support.google.com/cloud/answer/13463817).

Quotas: for projects created from May 2026, the Calendar API allows 600 requests per minute per user and 10,000 per minute per project, and Google has announced a billing threshold of 1,000,000 requests per day per project, with details to follow. Check **APIs & Services → Google Calendar API → Quotas** for the numbers that apply to your project. Supercal backs off when Google throttles it.

Push notifications need an HTTPS `SUPERCAL_PUBLIC_URL` with a certificate Google trusts; Google posts them to `/hooks/google`. Without HTTPS, Supercal polls Google calendars every two minutes instead.

## Microsoft

Microsoft 365 and Outlook.com accounts need an app registration in Microsoft Entra. Any Microsoft account can create one at <https://entra.microsoft.com>, including a personal one.

1. Open **Applications → App registrations → New registration**.
2. Enter a name. Under **Supported account types**, choose **Accounts in any organizational directory and personal Microsoft accounts**, so both work accounts and Outlook.com accounts can connect.
3. Under **Redirect URI**, choose the **Web** platform and enter your `SUPERCAL_PUBLIC_URL` followed by `/api/v1/oauth/microsoft/callback`, for example `https://cal.example.com/api/v1/oauth/microsoft/callback`. Register the app.
4. Copy the **Application (client) ID** from the overview page into `MICROSOFT_CLIENT_ID`.
5. Open **API permissions → Add a permission → Microsoft Graph → Delegated permissions** and add `Calendars.Read`, `offline_access` and `User.Read` (`User.Read` is usually there already; `openid` and `email` are requested at sign-in and need no entry). Admin consent is not required for these, although some organizations require it for any app; their admins can grant it from the same page.
6. Open **Certificates & secrets → Client secrets → New client secret**, pick an expiry, and copy the secret's **Value** (not its ID) into `MICROSOFT_CLIENT_SECRET`. Restart Supercal.

Client secrets expire, after at most 24 months. When one expires, every Microsoft account stops syncing until you create a new secret and restart Supercal, so put a reminder in your calendar a few weeks before the expiry date. You can create the new secret while the old one is still valid and switch over with no downtime.

Change notifications, like Google push, need an HTTPS `SUPERCAL_PUBLIC_URL`; Microsoft posts them to `/hooks/microsoft` and `/hooks/microsoft/lifecycle`. Without HTTPS, Supercal polls every two minutes.

## Connecting a calendar app to hosted calendars

Create a separate login for each device under **Settings → Calendar apps**: choose **New device**,
name it, and copy the server URL, username and password. The password is shown only then. In Apple
Calendar, Thunderbird or DAVx5, add a CalDAV account using those three values. Discovery finds your
active hosted calendars. You can create calendars and create, edit and delete events from the app,
as you can in the dashboard's event editor. HTTPS must reach the `dav` role, including `/`, `/dav/` and
`/.well-known/caldav`, and your proxy must forward WebDAV methods such as PROPFIND, REPORT,
MKCALENDAR, PROPPATCH, PUT and DELETE.

To automate this, create the login with your tenant API key (or an authenticated session):

```sh
curl --fail https://cal.example.com/api/v1/dav-logins \
  -H "Authorization: Bearer $SUPERCAL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Work iPhone"}'
```

The 201 response contains `id`, `name`, `username`, `password`, `serverUrl` and `createdAt`.
Save the password now; it is shown only in this response.

Revoke a device under **Settings → Calendar apps**, or list them with `GET /api/v1/dav-logins` and
revoke one with `DELETE /api/v1/dav-logins/<id>`. It stops authenticating immediately without
affecting other devices. A tenant admin can revoke a member's device login too. Each user may have at most
20 logins in a tenant. Removing or banning a member also stops that member's device logins.
Feed usernames and passwords continue to provide read-only publications; use a DAV login to
edit hosted calendars. Device credentials cannot open the management API or ICS feeds.

## CalDAV servers on your LAN

To protect your network, Supercal refuses to connect to private, loopback, link-local and other non-public addresses when it syncs a CalDAV or ICS account. To let users add a server on your LAN, list it in `SUPERCAL_EGRESS_ALLOW` as its exact origin and the address range it may resolve to:

```sh
SUPERCAL_EGRESS_ALLOW=https://nas.home.arpa:5232=192.168.1.0/24,http://radicale.lan=10.0.0.5/32
```

Each entry allows only that scheme, host and port, and only to addresses inside its CIDR. Tenants cannot change the list.

Supercal refuses to start when `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY` is set. It connects to the address it has already vetted, and the Bun runtime it is built on cannot exempt individual requests from an ambient proxy, so a proxy would make those connections itself and bypass that check. Unset them in Supercal's environment.

## Rotating the encryption key

`SUPERCAL_KEYS` holds the master keys that encrypt provider credentials and feed secrets in the database. The first key encrypts new values; the others only decrypt. To rotate:

1. Generate a new key and put it first, with a new version name: `SUPERCAL_KEYS=v2:<new>,v1:<old>`. Restart every replica with it.
2. Wait for existing values to move to the new key. Supercal re-encrypts an account's credentials the next time it syncs the account, usually within minutes, and a feed's secret the next time a client fetches the feed or someone previews it. Check progress with the owner credential:

   ```sql
   SELECT count(*) FROM calendar_account WHERE credentials LIKE 'sc1.v1.%';
   SELECT count(*) FROM feed WHERE uid_secret LIKE 'sc1.v1.%';
   ```

3. When both counts are zero, remove the old key (`SUPERCAL_KEYS=v2:<new>`) and restart. A feed that nobody has read since the rotation keeps the old key; preview it in the dashboard first, or keep the old key listed until it is.

Back up your keys separately from the database. Without them, the stored credentials cannot be decrypted, and every account must be reconnected.

## Scaling

Every process runs the roles listed in `SUPERCAL_ROLES`, and every role is safe to run on any number of replicas:

- `api` serves the management API, the dashboard, sign-in and the provider push webhooks.
- `dav` serves the CalDAV and ICS feeds that calendar apps subscribe to.
- `worker` syncs accounts. Replicas share the work through leases in Postgres, and each runs up to `SUPERCAL_SYNC_CONCURRENCY` jobs at once (default 8, at most 2 per account).

Better Auth rate limits and CalDAV login failure budgets are in memory, separately on each replica. Adding replicas increases the total number of attempts an address can make.

A single process with all three roles comfortably serves a household or a small team. To grow, run separate deployments, for example two `api,dav` replicas behind the load balancer and one or more `worker` replicas that receive no traffic.

Every replica needs the same `DATABASE_URL`, `SUPERCAL_KEYS`, `BETTER_AUTH_SECRET` and `SUPERCAL_PUBLIC_URL`. The Google and Microsoft client settings are needed by `api` (to connect accounts) and `worker` (to refresh tokens and sync); email settings only by `api`. Each process opens up to 16 database connections: ten for queries, five for sign-in and sessions, and one that listens for notifications. Size Postgres's `max_connections` for your replica count. Only `/readyz` on worker processes checks the scheduler.

## Backups

Postgres holds all of Supercal's state, so back up the database with your usual tools: `pg_dump` for a small install, or your provider's snapshots and point-in-time recovery. Keep `SUPERCAL_KEYS` and `BETTER_AUTH_SECRET` in your secret store as well; a database restored without its keys has credentials nobody can decrypt. The container itself holds nothing worth backing up.

## Upgrading

Build or pull the new image and restart your replicas with it. With the default `SUPERCAL_MIGRATE=auto`, each process applies pending migrations at startup under a Postgres advisory lock: the first one applies them, the others wait and find nothing left to do.

When a release changes how events are normalised, such as a time zone rules update that moves stored time ranges, the first worker to start re-normalises every stored event from its raw copy. Connected calendars run one incremental sync to finish it. Only events whose result changed are written, and calendar apps see those as changed.

To run migrations as a separate step, for example as a job before a rolling deploy, set `SUPERCAL_MIGRATE=off` on the replicas and run the binary's `migrate` command with the owner credential:

```sh
docker run --rm --read-only --tmpfs /tmp \
  -e DATABASE_MIGRATION_URL=postgres://supercal_owner:owner-password@db.example.com:5432/supercal \
  supercal:0.2.0 migrate
```

It applies whatever is pending and exits. Once a newer migration has been applied, replicas still running an older binary report `migrations` among their failing readiness checks, so your orchestrator stops sending them traffic until they are replaced.
