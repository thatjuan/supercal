# Platform spike: Gnomon

Run on 2026-11-07 against Bun 1.3.4, macOS arm64, and Postgres 18.6 on hare. All code and evidence are under `spikes/platform/`; only `spike_platform` was used. No email was sent and no third-party accounts were used. Password signup runs with verification disabled and fixture addresses under `example.invalid`.

## Results

| Question | Verdict | Recommendation |
| --- | --- | --- |
| API + OpenAPI, R16 | confirmed with caveats | Keep Hono + `@hono/zod-openapi` + Zod 4; pin TypeScript 5.9.3 for the generator. |
| Better Auth, R12 | confirmed with caveats | Keep Better Auth; choose user-owned tenant-bound keys for the requested principal, or add a separate service-principal type for native organization keys. |
| Postgres driver + RLS, R13 | confirmed with caveats | Use postgres.js with Drizzle on Bun 1.3.4; enforce tenant context inside transactions using a restricted application role. |
| Lease scheduler, R14 | confirmed with caveats | Keep calendar leases, add a monotonically increasing generation, renew leases, and fence resource commits; external side effects need idempotency. |
| Secrets | confirmed | Use the tested WebCrypto AES-256-GCM envelope module with versioned keys and tenant/record context. |
| Compiled daemon + container, R15 | confirmed with caveats | Compile using `better-auth/minimal`; embed SQL explicitly and run standard Drizzle migrations under an advisory lock. |
| SSE fan-out | confirmed with caveats | Keep one postgres.js listener per process; use notifications to wake durable change-log/outbox consumers. |
| Web skeleton | confirmed | Vite + React + TanStack Router/Query + Better Auth React client and the generated client build successfully. |

Installed versions are captured in [evidence/versions.txt](evidence/versions.txt) and `bun.lock`. Main versions: Hono 4.13.17; `@hono/zod-openapi` 1.6.3; Zod 4.6.7; Scalar 0.12.18; Better Auth and `@better-auth/api-key` 1.7.18; Drizzle 0.45.4; postgres.js 4.1.0; openapi-typescript 7.13.0; openapi-fetch 0.17.0; openapi-react-query 0.5.4; pg-boss 12.38.1.

## 1. API and generated client

[src/api.ts](src/api.ts) implements four documented operations: `GET/POST /api/v1/feeds` and `GET/PATCH /api/v1/feeds/{id}`. Feeds are held in a tenant-filtered in-memory map because this question tests the API contract. Lists use an exclusive UUID cursor, ordered by ID, with a maximum page size of 100. This is a minimal keyset example; production ordering should use immutable `(created_at, id)` values and a versioned opaque cursor if creation order is required.

Schemas reuse named components for feed input, patch, output, page, problems, and the two publication variants. `z.discriminatedUnion('kind', ...)` emits `oneOf`, named component references, and a `kind` discriminator with mappings. A virtual publication requires at least two source calendar IDs at runtime. The generated TypeScript narrows the two variants correctly, but the generated array type does not encode the minimum length; runtime validation remains necessary.

Every documented operation includes `400/401/404/500` errors with `application/problem+json` and a reference to the same Problem component. A validation hook converts Zod failures to RFC 9457 bodies. Malformed JSON also returns 400 through the error handler. The auth plugin retains its own error format. Scalar is served at `/docs`, with the management document at `/openapi.json`.

Evidence:

```sh
bun run generate
bunx openapi-typescript openapi.json -o src/generated.ts
bun run src/spec-evidence.ts
bun run src/auth-evidence.ts
bun run check
```

Key output, saved in [spec-generation.txt](evidence/spec-generation.txt), [spec.txt](evidence/spec.txt), [api-auth.txt](evidence/api-auth.txt), and [typecheck.txt](evidence/typecheck.txt):

```text
management: 3.1.0
openapi.json → src/generated.ts
Publication.oneOf: PassthroughPublication, VirtualPublication
Publication.discriminator.propertyName: kind
400.content.application/problem+json.schema.$ref: #/components/schemas/Problem
feedCreate: 201; patch: 200; pagination: [1, 1]
invalidUnion: {status: 400, contentType: application/problem+json}
malformedJson: 400; scalar: 200
$ tsc --noEmit                         # exit 0
```

[src/client-usage.ts](src/client-usage.ts) checks openapi-fetch response and Problem types, React Query query options/hooks/mutations, and publication narrowing. Negative compile assertions reject a nonexistent path, a string page limit, and an invalid virtual-publication body.

The installed `@hono/zod-openapi` declares `zod: ^4.0.0` as a peer dependency. Schema construction, validation, document generation, and client generation all worked. No fallback comparison with hono-openapi was needed: the condition for that comparison, a poor fit, was not met. The [Hono example](https://hono.dev/examples/zod-openapi) describes the same route/schema approach.

One toolchain incompatibility was reproduced in an isolated temporary project:

```sh
(cd build/ts7-friction && bun node_modules/openapi-typescript/bin/cli.js ../../openapi.json -o generated.ts)
```

```text
TypeScript 7.0.2 + openapi-typescript 7.13.0
TypeError: undefined is not an object (evaluating 'ts.factory.createKeywordTypeNode')
```

See [typescript7-friction.txt](evidence/typescript7-friction.txt). Pinning TypeScript 5.9.3 fixes this. The temporary reproduction project was removed after capture.

Architecture impact: retain the proposed API stack and a generated `packages/api-client`. Keep source schemas in the API package and generated files out of hand editing. Problem responses must be declared in each operation, using shared response definitions; registering a global error handler alone does not document them.

## 2. Better Auth and tenant principals

[src/auth.ts](src/auth.ts) enables email/password, organization, admin, API key, and OpenAPI plugins over the Drizzle Postgres adapter. The current API-key plugin imports from `@better-auth/api-key`, not `better-auth/plugins`. Schema generation uses `auth@1.7.18`; the old `@better-auth/cli` package resolved to 1.4.21 and was removed to avoid mixing CLI and server generations.

[src/principal.ts](src/principal.ts) resolves one typed principal:

```ts
{ userId: string; tenantId: string; role: 'owner' | 'admin' | 'member'; via: 'session' | 'apiKey' }
```

Sessions use `activeOrganizationId`, then recheck `member` in the database. User API keys are verified once, joined to an immutable application-owned tenant binding, and checked against current membership. An invalid key does not fall back to a cookie. The organization membership role is distinct from the admin plugin's global `user.role`.

The binding table is `platform_api_key_binding(api_key_id PK/FK apikey.id, tenant_id FK organization.id, user_id FK user.id)`. The spike writes it through trusted server code. Production issuance must create this binding for the authorized active tenant, and revoke a newly created key if binding creation fails.

A first implementation used metadata for tenant binding. Inspection and a run showed that key owners can edit metadata through Better Auth; the final resolver ignores it. The test changes metadata to an attacker-supplied tenant and confirms the principal stays bound to the stored tenant. Removing membership immediately makes the key return 401.

The plugin also supports native organization ownership: configure `apiKey({configId: 'tenant', references: 'organization'})`, then create a key with `organizationId`. The run confirmed `referenceId === organizationId` and successful verification. These keys have no user identity suitable for the requested `userId` field. The [official API-key docs](https://better-auth.com/docs/plugins/api-key) document organization ownership. The [advanced guide](https://better-auth.com/docs/plugins/api-key/advanced) explains that organization-owned keys cannot create mock user sessions.

Evidence:

```sh
bunx auth generate --config src/auth.ts --output src/auth-schema.ts --yes
bunx drizzle-kit generate
bunx drizzle-kit migrate
bun run src/auth-evidence.ts
```

```text
signup: 200; createOrg: 200
session: {userId: ..., tenantId: ..., role: owner, via: session}
apiKey:  {userId: ..., tenantId: ..., role: owner, via: apiKey}
invalidKey: 401; revokedMembership: 401
editableMetadataIgnored: true
resolvedRoles: [admin, member, owner]
nativeOrgKey: {created: 200, verified: true, referenceIsTenant: true}
```

Roles were changed directly in the fixture membership row to prove resolution for all three defaults. The admin plugin's operator actions and authorization rules for feed mutations were not exercised; enabled plugins, schemas, generated endpoints, and compiled composition were exercised. API keys currently inherit the user's live tenant role; narrower machine permissions would need an explicit intersection with key scopes.

Better Auth emits OpenAPI **3.1.1**, with 72 relative paths and a server URL ending in `/api/auth`; ours emits 3.1.0. This was inspected by `bun run src/spec-evidence.ts`. The two small documents have no schema-name collisions today, so merging is feasible by prefixing auth paths, rewriting/reconciling components and servers, and aligning security declarations. A blind object spread is incorrect. Its emitted security schemes include a generic `apiKeyCookie` cookie name and bearer auth, so they need review before presenting a merged document as an exact contract for our session/key middleware.

Recommendation: serve the auth document/reference separately at Better Auth's `/api/auth/open-api/generate-schema` and `/api/auth/reference`; link it from management docs. The [OpenAPI plugin docs](https://better-auth.com/docs/plugins/open-api) describe its generated plugin/core reference. Use Better Auth's client for auth and the generated management client for application calls.

Architecture impact: Better Auth works on Bun 1.3.4 with Hono and Drizzle. Keep explicit principal resolution instead of API-key session emulation. For the brief's user principal, use user keys plus immutable tenant bindings. If keys must outlive individual members, use native organization keys and add a service-principal variant with `apiKeyId`, `tenantId`, and permissions, without inventing a user ID. Set `WEB_ORIGIN` when using Vite so Better Auth permits the development origin.

## 3. Drivers, transactions, and RLS

[src/db-evidence.ts](src/db-evidence.ts) runs both Drizzle adapters against the same isolated fixture table. Both commit and roll back transactions. Bun.SQL sends `pg_notify()` successfully and accepts raw SQL `LISTEN`, but **Bun 1.3.4 has no `listen` method**, so it cannot deliver notifications through a supported callback API. Current Bun documentation describes a newer runtime and must not be treated as evidence for 1.3.4. The [pg-boss backend guide](https://github.com/timgit/pg-boss/blob/master/docs/database-backends.md) identifies Bun 1.4.0 as the addition of its LISTEN support; a runtime upgrade was not tested.

The RLS run creates a `supercal_platform_app` role with `NOSUPERUSER NOBYPASSRLS`, grants only fixture-table access, and enters it with `SET LOCAL ROLE` inside each test transaction. The table is owned by the setup role and has both ENABLE and FORCE RLS. Each transaction calls `set_config('app.tenant_id', tenant, true)` before any data query.

Evidence:

```sh
bun run src/db-evidence.ts
```

```text
postgresJs: {transactionCommit: true, rollback: true, listenNotify: true, notifyMs: 1}
bunSql: {transactionCommit: true, rollback: true, notifyViaSql: true,
         rawListenAccepted: true, listenAPI: undefined}
pgForgotWhere: [A]; bunForgotWhere: [B]
unsetTenantRows: 0
crossTenantInsertBlocked: true; blockedSqlState: 42501
```

Full output is in [drivers-rls.txt](evidence/drivers-rls.txt). The reads deliberately have no WHERE clause. The next transaction with no tenant sees zero rows, proving the context did not leak. A cross-tenant insert fails with Postgres SQLSTATE 42501. The shared setup login is a superuser, so the test explicitly switches to the restricted role; using that setup login directly would bypass RLS even with FORCE.

[src/tenant-db.ts](src/tenant-db.ts) contains the small typed transaction wrapper. In production, connect the data pool as the restricted application login; do not give it permission to become the migration owner. Use a separate migration credential, and give Better Auth the auth-table access it needs before a principal/tenant exists. The worker's cross-tenant scheduling query also needs a narrowly scoped control-plane role; perform tenant resource writes through the tenant transaction wrapper.

The fixtures use synthetic UUID tenant IDs. Better Auth's default IDs are opaque strings, so production `tenant_id` should be **text**, referencing `organization(id)`, unless ID generation is deliberately standardized. For text IDs, the policy is:

```sql
ALTER TABLE tenant_resource ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_resource FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_resource
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
-- Within one app-role transaction, before all reads and writes:
SELECT set_config('app.tenant_id', $1, true);
```

The tested UUID fixture adds `::uuid` to the setting. Always use transaction-local context, and pass the transaction handle through the entire operation. RLS limits accidental query omissions; application code must still derive tenant context from a verified principal. The [Postgres RLS documentation](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) explains owner and superuser bypass rules.

Architecture impact: choose `drizzle-orm/postgres-js` + postgres.js 4.1.0 for one consistent query/listener stack on Bun 1.3.4. No performance comparison was attempted. RLS remains useful defense in depth, with an explicit role and pool design.

## 4. Lease scheduler

[src/scheduler.ts](src/scheduler.ts) claims due rows with a CTE containing `FOR UPDATE SKIP LOCKED`, then updates the lease atomically. The fixture table has `id`, `tenant_id`, `next_run_at`, `lease_until`, `lease_owner`, `lease_version`, `attempts`, and `last_error`, with an index on `(next_run_at, id)`. Claiming increments the generation and attempts. A successful completion clears attempts; failure retains them and stores the error.

The scaled fixture polls changed calendars after one second and quiet calendars after four seconds. Failures use capped exponential backoff with equal jitter, from half to the full calculated delay. Completion requires the same owner and generation and a lease that is still live.

Evidence:

```sh
bun run src/scheduler-evidence.ts
bun run src/boss-evidence.ts
```

The first command starts three Bun **processes** over 1,000 rows for one minute. One exits with code 86 immediately after claiming eight rows; the two remaining workers continue. Server timestamps in an audit table identify overlapping claim-to-completion intervals.

```text
scheduler durationMs: 60124
claims: 19568; accepted: 19560; distinct_rows: 1000
worker handled: 9800, 9760
concurrentCompletedOverlaps: 0
crashedLeasesReclaimed: {count: 8, min_ms: 1202}
failedAttempts: 645
attempt 3 jitter bounds: [2000, 4000] ms
```

[Scheduler output](evidence/scheduler.txt) also contains a separate fault test: a live worker pauses beyond a 100 ms lease and another worker claims the same calendar. Both workers are alive, so unconditional no-concurrent-processing is **disproved**. The old worker's completion is rejected and the current worker's completion succeeds:

```text
sameCalendarClaimedTwiceWhileOldWorkerAlive: true
staleCompletionAccepted: false
newCompletionAccepted: true
```

Production needs lease renewal and cancellation on lease loss, plus fencing around the transaction that writes normalized resources and advances checkpoints. Fencing only the scheduler row, as this spike does, is insufficient if an expired worker has already written resources elsewhere. External provider/sink side effects must be idempotent; a lease cannot offer exactly-once execution after a pause or network partition.

pg-boss 12.38.1 runs on Bun 1.3.4 using its default `pg` backend:

```text
startSendFetchComplete: true; elapsedMs: 114
```

See [pg-boss.txt](evidence/pg-boss.txt). This is a start/create-queue/send/fetch/complete test, not a queue reliability benchmark. pg-boss would add durable generic jobs, retries, scheduling, concurrency controls, and maintenance/schema overhead. It does not make arbitrary external side effects exactly once. Its Bun.SQL backend was not exercised.

Architecture impact: retain the brief's small calendar-state scheduler, with `lease_owner` and `lease_version` added and fenced resource transactions required. Use realistic production lease/poll intervals, not these stress-test values. Reconsider pg-boss when there are enough distinct job types or workflow needs to justify it.

## 5. Secrets

[src/secrets.ts](src/secrets.ts) implements actual envelope encryption: a fresh random 256-bit data key per value; AES-256-GCM encrypts the value; the versioned master key wraps the data key with AES-256-GCM. Both operations use independent random 96-bit IVs and authenticated context containing the format, master version, and caller-provided tenant/record/field identity.

Configuration is `SUPERCAL_KEYS=v2:base64,v1:base64`. The first version is active, and all keys must decode to 32 bytes. The stored format is:

```text
sc1.<master-version>.<wrap-iv>.<wrapped-data-key>.<data-iv>.<ciphertext-and-tag>
```

Binary fields use base64url. `decrypt()` returns plaintext plus a replacement ciphertext when the record used an older key. Persist the replacement with compare-and-swap against the original ciphertext to avoid overwriting a concurrent credential update. Keep old master versions until live records and needed backups have migrated.

Evidence:

```sh
bun test src/secrets.test.ts
```

```text
4 pass; 0 fail; 16 expect() calls
```

[Tests](evidence/secrets.txt) cover Unicode and empty plaintext, randomized output, wrong-context rejection, ciphertext tampering, lazy rotation, retiring an old key, and malformed/duplicate key configurations. The module uses Bun WebCrypto and no crypto dependency. It does not persist provider credentials or perform the application-level compare-and-swap.

Architecture impact: the brief's encryption approach works. Use stable tenant/account/field context, and keep feed-token hashing separate from reversible provider-secret encryption.

## 6. Compilation and container

[src/migrate.ts](src/migrate.ts) statically imports three SQL files as text, then materializes them and the journal under a temporary directory for Drizzle's standard migration reader. A reserved postgres.js connection holds `pg_advisory_lock(731605012)` while migrations run, then unlocks/releases in `finally`. The temporary files are removed. Generating an embedded migration manifest at build time would remove the spike's manual import list.

Evidence:

```sh
bun build --compile --minify src/server.ts --outfile build/platform-macos
codesign --force --sign - build/platform-macos
bun run src/compiled-evidence.ts
```

Two compiled processes ran concurrently from the system temporary directory, without adjacent source files, SQL files, or node_modules. The previously absent key-binding table appeared through the embedded migration. Password signup, organization creation, protected session access, and Scalar all succeeded.

```text
macOS binaryBytes: 61011504
health ready: 664 and 684 ms
bindingTableBefore.probe_exists: false
bindingTableAfter.probe_exists: true
compiledAuth: {signup: 200, organization: 200, protectedRoute: 200}
scalar: 200
migrations: applied; embeddedFiles: 3; advisoryLock: true
```

See [compile-macos.txt](evidence/compile-macos.txt) and [compiled-run.txt](evidence/compiled-run.txt). The first macOS launch was killed with exit 137 before code ran; replacing its ad hoc signature with `codesign` fixed it. Linux did not require that step.

The [Dockerfile](Dockerfile) uses `oven/bun:1.3.4` to install and compile, then `gcr.io/distroless/cc-debian12:nonroot` with UID/GID 65532. The first build attempted an unused better-sqlite3 install script through the wider CLI dependency set and failed without Python. The final build omits development dependencies and uses `--ignore-scripts`; the compiled Postgres application runs without SQLite/native addons. Better Auth imports from `better-auth/minimal`.

The exact remote build/run procedure appears below. Captured [Docker build output](evidence/docker-build.txt) and [runtime evidence](evidence/docker-run.txt):

```text
architecture: amd64; Bun: 1.3.4
imageBytes: 128833741                 # 128.8 MB / 122.9 MiB
binaryBytes: 105161752
runtimeUser: 65532:65532
coldStartThroughHealthMs: 370
signup: 200; organization: 200; activeOrganization: 200
protectedRoute: 200; principalVia: session
nativeOrgKeyCreate: 200; nativeOrgKeyBoundToTenant: true
migrations: applied; embeddedFiles: 3; advisoryLock: true; elapsedMs: 38
```

This is one process-cold startup measurement with an already built local image, excluding pull/build time. It is not a distribution or a memory benchmark. The spike image serves API/auth/SSE; it does not yet bundle the built web assets or implement role-selection orchestration. `/tmp` must remain writable for the standard migration reader. The Docker test container is removed by its harness; the temporary context and spike image are cleaned after the run.

Architecture impact: one Bun binary/container is viable for these dependencies. Keep migration ownership separate from application RLS privileges; production boot migrations need a separate migration URL/pool or a deployment migration step. Embedding SQL does not eliminate that permission requirement.

## 7. SSE fan-out

[src/sse.ts](src/sse.ts) establishes one named postgres.js listener connection per process, listens on `platform_changes`, validates small `{tenantId, calendarId, seq}` messages, and filters subscribers by the resolved tenant. Event sequence values are strings to avoid JavaScript integer precision limits. Slow subscribers have a small pending-write limit. Streams send heartbeats every 15 seconds; the Bun server uses `idleTimeout: 0`.

Evidence:

```sh
bun run src/sse-evidence.ts
```

The notifier/test harness and Hono server are separate Bun processes. Six HTTP SSE connections use real session cookies for two fixture tenants. The first notification is held inside an uncommitted transaction for 150 ms and produces no event until commit. Ten notifications target tenant A and two target B.

```text
subscriberCount: 6; tenants: 2
eventsPerSubscriber: [10, 10, 10, 2, 2, 2]
listenerConnections: 1
noDeliveryBeforeCommit: true; crossTenantEvents: 0
latencyMs: {min: 1.11, p95: 2.64, max: 2.72}
idleTimeout: 0; heartbeatSeconds: 15
```

[Full SSE evidence](evidence/sse.txt). Timing starts immediately before the COMMIT round trip and ends when the other process's event reaches the HTTP client, so it conservatively includes commit transport time. This tests one server process with multiple subscribers; multi-replica fan-out follows the same Postgres broadcast mechanism but was not separately load-tested.

The [Postgres NOTIFY documentation](https://www.postgresql.org/docs/current/sql-notify.html) describes commit delivery, connection-local listening, and payload limits. Notifications are transient, visible to database listeners, and unsuitable as the sole trigger for durable sink work. Put sink jobs/outbox entries in the same transaction as the change, send only identifiers, and reconcile from durable sequence state after reconnect. postgres.js supports automatic re-listening; its [listener documentation](https://github.com/porsager/postgres#listen) includes an on-listen callback suitable for catch-up.

The spike does not implement Last-Event-ID replay, listener-disconnect recovery tests, or authorization revocation for an already-open stream. Production should catch up from the change log and close/revalidate streams when membership/session authorization changes. A finite global Bun timeout can instead be disabled per SSE request; leaving the default short idle timeout with a 15-second heartbeat is insufficient. See [Bun server timeout documentation](https://bun.sh/docs/runtime/http/server).

Architecture impact: retain NOTIFY + SSE for low-latency invalidation, and make durable change-log/outbox processing the source of recovery and sink delivery.

## 8. Web skeleton

[web/](web/) contains an unstyled React screen, code-defined TanStack Router routes, a QueryClient provider, Better Auth React session/client plugins, and typed feed calls through [src/client.ts](src/client.ts). Vite proxies `/api` to the daemon on port 4316. Auth and management use same-origin browser requests with cookies.

Evidence:

```sh
bunx vite build web
bun run check
```

```text
vite v8.3.6
237 modules transformed
web/dist/assets/index-CkpWhLyP.js 382.85 kB; gzip 122.62 kB
built in 82ms
$ tsc --noEmit                         # exit 0
```

See [vite.txt](evidence/vite.txt). React is 19.3.1, TanStack Router 1.170.46, and React Query 5.107.1. This is a build/type proof; dashboard login/organization UX and a browser end-to-end run were outside the small skeleton's scope.

Architecture impact: keep the proposed web stack and share the generated API client. Start the daemon with `WEB_ORIGIN=http://localhost:5173` for Vite development; set the exact public origin in deployment.

## Decisions I recommend

- Use Bun 1.3.4, Hono 4.13.17, `@hono/zod-openapi` 1.6.3, Zod 4.6.7, and Scalar 0.12.18 for the management API.
- Use openapi-typescript 7.13.0, openapi-fetch 0.17.0, openapi-react-query 0.5.4, and TypeScript 5.9.3; commit the lockfile and verify generation during normal builds.
- Use Better Auth 1.7.18 with `@better-auth/api-key` 1.7.18 and its matching `auth` CLI. Keep auth's OpenAPI separate and keep global operator roles separate from organization membership roles.
- Keep the requested user principal and bind user API keys with an immutable `api_key_tenant(api_key_id PK, tenant_id, user_id)` table. Add a service-principal variant if organization-owned keys are required.
- Use text `tenant_id` foreign keys to Better Auth organizations, postgres.js 4.1.0 + Drizzle 0.45.4, transaction-local tenant context, and a non-owner application role without BYPASSRLS.
- Use `calendar_sync(next_run_at, lease_until, lease_owner, lease_version, attempts, last_error)` and SKIP LOCKED; require fenced resource transactions and idempotent side effects.
- Use durable change-log/outbox rows plus NOTIFY wakeups and one listener connection per process. Carry sequence IDs as strings over JSON/SSE.
- Use `createSecretBox()` with authenticated record context and lazy rotation through compare-and-swap updates.
- Compile a minimal Better Auth/Postgres daemon and embed the migration manifest; use advisory-locked migrations with separate credentials and a non-root distroless runtime.

## New risks discovered

- A lease does not prevent a paused live worker from overlapping its replacement. Every checkpoint/resource commit needs generation fencing; sink writes need idempotency.
- Tenant binding in client-editable API-key metadata is mutable. Native organization ownership also changes the meaning of `referenceId`, so it cannot be treated as a user ID.
- A notification-only path can silently lose sink jobs and cache invalidations during disconnects. Durable catch-up/outbox state is required.
- RLS is ineffective through the shared superuser login. Auth lookups, tenant data operations, migrations, and global scheduling need deliberate role/pool boundaries.
- Better Auth default organization IDs are strings, while standalone database prototypes often default to UUID columns. Pick the ID representation before schema integration.
- Existing SSE streams retain their initial authorization unless the application actively revalidates or closes them.
- TypeScript 7.0.2 removes the compiler API expected by openapi-typescript 7.13.0. Current Bun docs/types also describe APIs absent from Bun 1.3.4; runtime-version matching matters.
- Naively importing the full auth/tooling dependency graph can pull unused native SQLite install scripts into the build. Keep the runtime import and installation graph small.

## How to rerun

Run from `spikes/platform/`. All database scripts use `DATABASE_URL`, defaulting to the assigned `postgres://supercal:spike@hare:55432/spike_platform`. These are isolated spike fixtures: the driver/scheduler scripts reset their own fixture tables and the auth scripts create fixture users/organizations.

```sh
bun install --frozen-lockfile --ignore-scripts
bunx drizzle-kit migrate
bun run generate
bunx openapi-typescript openapi.json -o src/generated.ts
bun run src/spec-evidence.ts
bun run check
bun run src/auth-evidence.ts
bun run src/db-evidence.ts
bun run src/scheduler-evidence.ts    # approximately one minute; three child processes
bun run src/boss-evidence.ts
bun test src/secrets.test.ts
bun run src/sse-evidence.ts
bunx vite build web
```

To inspect locally:

```sh
WEB_ORIGIN=http://localhost:5173 bun run start
# Separate terminal:
bunx vite web
# API docs: http://localhost:4316/docs
# Auth docs: http://localhost:4316/api/auth/reference
```

To compile on this Mac and exercise two concurrent boot migrations:

```sh
bun build --compile --minify src/server.ts --outfile build/platform-macos
codesign --force --sign - build/platform-macos
bun run src/compiled-evidence.ts
```

The recorded first compiled run created the then-missing binding table. Later runs use already-applied migrations and should report both before/after as true; no database reset is necessary.

To repeat the TypeScript 7 incompatibility:

```sh
mkdir -p build/ts7-friction
cat > build/ts7-friction/package.json <<'JSON'
{"private":true,"type":"module","dependencies":{"openapi-typescript":"7.13.0","typescript":"7.0.2"}}
JSON
bun install --cwd build/ts7-friction --ignore-scripts
(cd build/ts7-friction && bun node_modules/openapi-typescript/bin/cli.js ../../openapi.json -o generated.ts)
# Expected failure: ts.factory is undefined.
rm -rf build/ts7-friction
```

To build and run the non-root Linux container on hare:

```sh
rsync -az --exclude=node_modules --exclude=build --exclude=.git --exclude=evidence --exclude=web ./ user@hare:/tmp/supercal-spike-gnomon-platform/
ssh user@hare 'docker build -t supercal-spike-gnomon-platform /tmp/supercal-spike-gnomon-platform'
ssh user@hare 'python3 /tmp/supercal-spike-gnomon-platform/scripts/container_probe.py'
# Probe removes its own named container, even if a check fails.
ssh user@hare 'docker image rm supercal-spike-gnomon-platform'
ssh user@hare 'rm -rf /tmp/supercal-spike-gnomon-platform'
```
