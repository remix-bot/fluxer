# syntax=docker/dockerfile:1

# ---- Builder stage: install deps ----
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY . .

# ---- Runtime stage: minimal image with ffmpeg ----
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      tini \
      curl \
    && \
    rm -rf /var/lib/apt/lists/*

RUN groupadd -r remix && useradd -r -g remix -d /app -s /sbin/nologin remix

WORKDIR /app

COPY --from=builder --chown=remix:remix /app ./

RUN chmod +x docker/docker-entrypoint.sh && \
    mkdir -p /app/storage && chown -R remix:remix /app

USER remix

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD pgrep -f "node index.mjs" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/docker-entrypoint.sh"]

CMD ["node", "index.mjs"]
