#!/usr/bin/env bash
# Runs the relay and the two echo agents together. Ctrl-C stops both.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f relay/.env ]; then
  cp relay/.env.example relay/.env
  echo "created relay/.env"
fi

# shellcheck disable=SC1091
set -a; . relay/.env; set +a

[ -d relay/node_modules ] || (echo "installing relay deps..." && cd relay && npm install --silent)
[ -d adapters/echo/node_modules ] || (echo "installing echo deps..." && cd adapters/echo && npm install --silent)

pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

( cd relay && node server.js ) & pids+=($!)
sleep 1.5

RELAY_URL="http://127.0.0.1:${PORT:-8787}" RELAY_TOKEN="${RELAY_TOKEN:-dev-token}" \
  node adapters/echo/index.js & pids+=($!)

wait
