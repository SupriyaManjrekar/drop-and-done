#!/usr/bin/env sh
# Drop & Done prototype launcher (Git Bash / macOS / Linux). Needs only a JDK 8+.
# Optional: export ANTHROPIC_API_KEY to enable live Claude extraction; export PORT to change 8787.
HERE="$(cd "$(dirname "$0")" && pwd)"

# Find javac on PATH; fall back to JAVA_HOME. java comes from the same JDK folder so the
# compiler and runtime always match.
if command -v javac >/dev/null 2>&1; then
  JDK="$(dirname "$(command -v javac)")"
elif [ -n "$JAVA_HOME" ] && { [ -x "$JAVA_HOME/bin/javac" ] || [ -x "$JAVA_HOME/bin/javac.exe" ]; }; then
  JDK="$JAVA_HOME/bin"
else
  echo "Could not find javac. Install a JDK 8 or newer and put it on PATH, or set JAVA_HOME." >&2
  exit 1
fi

mkdir -p "$HERE/server/out"
"$JDK/javac" -encoding UTF-8 -d "$HERE/server/out" "$HERE/server/DropDoneServer.java" || exit 1
TRUST=""
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) TRUST="-Djavax.net.ssl.trustStoreType=Windows-ROOT" ;; esac
exec "$JDK/java" $TRUST -Djava.net.useSystemProxies=true -cp "$HERE/server/out" DropDoneServer "$HERE/.."
