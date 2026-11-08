# Supercal: one compiled Bun binary plus the built dashboard, on distroless, as UID 65532.
#   docker build -t supercal:$(bun -p "require('./apps/daemon/package.json').version") .
# The runtime has no shell, so there is no HEALTHCHECK: probe /healthz (liveness) and /readyz
# (readiness) from the orchestrator. Migrations write temp files: keep /tmp writable (a tmpfs
# with --read-only). See docs/self-hosting.md.

FROM oven/bun:1.3.4 AS build
WORKDIR /src
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/daemon/package.json apps/daemon/
COPY apps/web/package.json apps/web/
COPY packages/api-client/package.json packages/api-client/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/providers/package.json packages/providers/
# Development dependencies stay: the dashboard build needs Vite. They never reach the binary,
# which bundles only what the daemon imports. No install scripts run (none are needed).
RUN bun install --frozen-lockfile --ignore-scripts
COPY apps apps
COPY packages packages
COPY scripts scripts
RUN bun run build

FROM gcr.io/distroless/cc-debian12:nonroot
WORKDIR /app
COPY --from=build /src/dist/supercal /app/supercal
COPY --from=build /src/dist/web /app/web
USER 65532:65532
ENV PORT=4316 SUPERCAL_WEB_DIR=/app/web
EXPOSE 4316
ENTRYPOINT ["/app/supercal"]
