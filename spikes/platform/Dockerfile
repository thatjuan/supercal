FROM oven/bun:1.3.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY src ./src
COPY migrations ./migrations
RUN bun build --compile --minify src/server.ts --outfile /app/platform

FROM gcr.io/distroless/cc-debian12:nonroot
WORKDIR /app
COPY --from=build --chown=65532:65532 /app/platform /app/platform
USER 65532:65532
ENV PORT=4316
EXPOSE 4316
ENTRYPOINT ["/app/platform"]
