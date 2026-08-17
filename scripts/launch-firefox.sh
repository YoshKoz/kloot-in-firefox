#!/usr/bin/env bash
# Start Firefox Nightly with WebDriver BiDi enabled ("debugging mode"), which is
# what gives the bridge trusted input events and per-context screenshots.
#
# A dedicated profile is used so remote debugging is never left enabled on the
# everyday browsing profile.
set -euo pipefail

FIREFOX="${FIREFOX:-/usr/bin/firefox-nightly}"
PORT="${KLOOT_BIDI_PORT:-9222}"
PROFILE="${KLOOT_PROFILE:-$HOME/.local/share/kloot-in-firefox/profile}"

if [[ ! -x "$FIREFOX" ]]; then
  echo "Firefox binary not found at $FIREFOX (override with FIREFOX=...)" >&2
  exit 1
fi

if ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN; then
  echo "Port $PORT is already listening — Firefox may already be in debugging mode." >&2
  exit 1
fi

mkdir -p "$PROFILE"

echo "Launching $FIREFOX"
echo "  profile:      $PROFILE"
echo "  BiDi endpoint: ws://127.0.0.1:$PORT/session"

exec "$FIREFOX" \
  --profile "$PROFILE" \
  --remote-debugging-port "$PORT" \
  --no-remote \
  "$@"
