#!/usr/bin/env bash
# Installs the Agent Inbox platform plugin into a Hermes Agent checkout.
#
#   ./install.sh <hermes-checkout> <relay-url> <connect-token>
#
# The app hands you this exact line when you add an agent.
set -euo pipefail

HERMES="${1:-}"
RELAY_URL="${2:-}"
TOKEN="${3:-}"

if [ -z "$HERMES" ] || [ -z "$RELAY_URL" ] || [ -z "$TOKEN" ]; then
  echo "usage: ./install.sh <hermes-checkout> <relay-url> <connect-token>" >&2
  echo "example: ./install.sh ~/code/hermes-agent http://192.168.1.20:8787 aic_abc123" >&2
  exit 1
fi

HERMES="${HERMES/#\~/$HOME}"
PLUGINS="$HERMES/plugins/platforms"

if [ ! -d "$PLUGINS" ]; then
  echo "error: $PLUGINS does not exist — is $HERMES a hermes-agent checkout?" >&2
  exit 1
fi

SRC="$(cd "$(dirname "$0")" && pwd)/agentinbox"
DEST="$PLUGINS/agentinbox"

rm -rf "$DEST"
cp -r "$SRC" "$DEST"
echo "installed  $DEST"

# Reachability check before writing anything else — a wrong URL here is the
# most common way this ends up silently not working.
if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 5 "$RELAY_URL/health" >/dev/null 2>&1; then
    echo "reached     $RELAY_URL"
  else
    echo "warning: could not reach $RELAY_URL/health from this machine." >&2
    echo "         The gateway will retry, but check the address is right." >&2
  fi
fi

# Hermes loads $HERMES_HOME/.env first and only falls back to the checkout's
# own .env for development, so write to the home when there is one.
HERMES_HOME="${HERMES_HOME:-}"
if [ -z "$HERMES_HOME" ]; then
  PARENT="$(dirname "$HERMES")"
  if [ -f "$PARENT/config.yaml" ]; then
    HERMES_HOME="$PARENT"
  else
    HERMES_HOME="$HERMES"
  fi
fi

ENV_FILE="$HERMES_HOME/.env"
touch "$ENV_FILE"

set_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    # macOS and GNU sed disagree about -i, so rewrite the file instead.
    grep -vE "^${key}=" "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
}

set_env AGENTINBOX_RELAY_URL "$RELAY_URL"
set_env AGENTINBOX_TOKEN "$TOKEN"
echo "wrote       $ENV_FILE"

cat <<DONE

Done. Start the gateway:

  cd $HERMES
  hermes gateway

Your agent appears in the Agent Inbox app as soon as it connects.
DONE
