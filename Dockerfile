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
# Newer time zone rules than Bun's built-in ICU data: BC's permanent UTC-7 from 2026-11 (tzdata
# 2026e) is missing from every Bun release up to 1.4.4, so Vancouver events would be an hour off.
# ICU loads these files in place of its own when ICU_TIMEZONE_FILES_DIR names their directory.
# Drop this block once the base image's Bun gives America/Vancouver UTC-7 for 2026-11-11.
# 755, not 644: ADD gives the directory it creates the same mode, and UID 65532 must enter it.
ARG ICU_TZ=https://raw.githubusercontent.com/unicode-org/icu-data/6eac2f4d349d9f4a0825103bb41845d8e5ab7add/tzdata/icunew/2026f/44/le
ADD --chmod=755 --checksum=sha256:d9382726ee8a499514310e63a9e97f1dbdd7fc2db328e1a785dde05f2afbb7e6 $ICU_TZ/zoneinfo64.res /app/icu-tz/zoneinfo64.res
ADD --chmod=755 --checksum=sha256:5e77ce5afb7374a36cbe3be197d0a6deaa919e6f672c2a372f7a9d91b7f8534f $ICU_TZ/timezoneTypes.res /app/icu-tz/timezoneTypes.res
ADD --chmod=755 --checksum=sha256:cc9d283bb2797813a17c00d80c2a86d27bc80da5e1cd24da846e8b4af6dbd860 $ICU_TZ/metaZones.res /app/icu-tz/metaZones.res
ADD --chmod=755 --checksum=sha256:377691d021bbdd7012806d8188412d13e587a76b64ecc7b79fec4dc36a419deb $ICU_TZ/windowsZones.res /app/icu-tz/windowsZones.res
USER 65532:65532
ENV PORT=4316 SUPERCAL_WEB_DIR=/app/web ICU_TIMEZONE_FILES_DIR=/app/icu-tz
EXPOSE 4316
ENTRYPOINT ["/app/supercal"]
