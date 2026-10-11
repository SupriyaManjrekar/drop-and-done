#!/usr/bin/env sh
# Drop & Done with a Gemini API key: starts server/gemini_bridge.py, then the normal server pointed at it.
# Needs a JDK 8+ and Python 3.8+.   GEMINI_API_KEY=... sh run-gemini.sh
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -z "$GEMINI_API_KEY" ]; then
  echo "Set GEMINI_API_KEY first (get one at https://aistudio.google.com/apikey)." >&2
  exit 1
fi
PY="$(command -v python3 || command -v python)"
if [ -z "$PY" ]; then echo "Could not find python3. Install Python 3.8 or newer." >&2; exit 1; fi

BRIDGE_PORT="${BRIDGE_PORT:-8788}"
export BRIDGE_PORT
"$PY" "$HERE/server/gemini_bridge.py" &
BRIDGE=$!
trap 'kill $BRIDGE 2>/dev/null' EXIT INT TERM
sleep 1
kill -0 $BRIDGE 2>/dev/null || { echo "The Gemini bridge did not start (is port $BRIDGE_PORT free? set BRIDGE_PORT)." >&2; exit 1; }

# The server only forwards to the bridge; the placeholder key just switches live mode on.
ANTHROPIC_URL="http://127.0.0.1:$BRIDGE_PORT/v1/messages" ANTHROPIC_API_KEY=gemini-bridge sh "$HERE/run.sh"
