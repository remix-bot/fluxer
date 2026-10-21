# syntax=docker/dockerfile:1

# ---- Builder stage: install deps ----
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev --legacy-peer-deps 2>/dev/null || npm install --omit=dev --legacy-peer-deps

COPY . .

# ---- Runtime stage: minimal image with ffmpeg ----
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
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

USER 10001:10001

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "const fs = require('fs'); try { const diff = Date.now() - fs.statSync('/tmp/.remix-health').mtimeMs; process.exit(diff < 30000 ? 0 : 1); } catch { process.exit(1); }"

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/docker-entrypoint.sh"]

CMD ["node", "shard.mjs"]