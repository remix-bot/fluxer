#!/bin/sh
set -e

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

exec "$@"
