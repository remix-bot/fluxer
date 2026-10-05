# syntax=docker/dockerfile:1

# ---- Builder stage: install deps ----
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# .npmrc carries legacy-peer-deps (the @fluxerjs peer ranges conflict); package-lock.json pins versions.
COPY package.json package-lock.json* .npmrc ./

RUN npm ci --omit=dev --legacy-peer-deps || npm install --omit=dev --legacy-peer-deps

COPY . .

# ---- Runtime stage: minimal image ----
# No ffmpeg: audio goes through NodeLink and the in-process Opus/WebM pipeline; ffprobe comes from
# the bundled ffprobe-static package.
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      tini \
      curl \
      ca-certificates \
    && \
    rm -rf /var/lib/apt/lists/*

RUN groupadd -r -g 10001 remix && useradd -r -u 10001 -g remix -d /app -s /sbin/nologin remix

WORKDIR /app

COPY --from=builder --chown=10001:10001 /app ./

RUN chmod +x docker/docker-entrypoint.sh && \
    mkdir -p /app/storage && chown -R 10001:10001 /app

# Commit shown by the bot (the image has no .git). CI passes it with --build-arg GIT_SHA=<sha>.
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}

# The bot touches this file every 15s while its event loop is running and it is logged in.
# docker/healthcheck.mjs reports unhealthy when it is missing or stale (no procps needed).
ENV HEARTBEAT_FILE=/tmp/remix-heartbeat

USER 10001:10001

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD ["node", "docker/healthcheck.mjs"]

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/docker-entrypoint.sh"]

CMD ["node", "index.mjs"]
