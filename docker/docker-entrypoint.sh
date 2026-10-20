#!/bin/sh
set -e

export OPENSSL_CONF="${OPENSSL_CONF:-/etc/ssl/openssl.cnf}"
if [ -z "$NODE_OPTIONS" ]; then
  export NODE_OPTIONS="--dns-result-order=ipv4first --tls-max-v1.2 --openssl-shared-config"
elif ! echo "$NODE_OPTIONS" | grep -q -- "--dns-result-order=ipv4first"; then
  export NODE_OPTIONS="--dns-result-order=ipv4first $NODE_OPTIONS"
fi

CONFIG_FILE="/app/config.json"

if [ ! -f "$CONFIG_FILE" ]; then
  if [ -n "$CONFIG_JSON" ]; then
    printf '%s' "$CONFIG_JSON" > "$CONFIG_FILE"
    echo "[Docker] Generated config.json from CONFIG_JSON env var."
  elif [ -f "/app/docker/config_example.json" ]; then
    cp /app/docker/config_example.json "$CONFIG_FILE"
    echo "[Docker] WARNING: config.json not found — copied from docker/config_example.json."
    echo "[Docker] Edit the mounted config.json and restart the container."
  else
    echo "[Docker] FATAL: config.json not found and no template available." >&2
    exit 1
  fi
fi

if [ "$1" = "node" ] && [ "$2" = "index.mjs" ]; then
  echo "[Docker] Starting Remix bot..."
fi

if [ "$1" = "node" ] && [ "$2" = "shard.mjs" ]; then
  echo "[Docker] Starting Remix bot (sharded supervisor)..."
fi

if [ "$1" = "npm" ] && [ "$2" = "start" ]; then
  echo "[Docker] Starting Remix bot (standard start)..."
fi

if [ "$1" = "npm" ] && [ "$2" = "run" ] && [ "$3" = "shard" ]; then
  echo "[Docker] Starting Remix bot (sharded supervisor via npm run shard)..."
fi

echo "[Docker] Testing cluster egress IP and api.fluxer.app TLS connection..."
echo -n "[Docker] Cluster Public IP: "
curl -s -m 5 https://api.ipify.org || echo "Failed to get IP"
echo ""
curl -v -m 5 https://api.fluxer.app/v1/gateway/bot 2>&1 | head -n 25 || true

exec "$@"
