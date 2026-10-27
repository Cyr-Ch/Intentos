#!/bin/sh
# Starts the IntentOS MCP server from the IntentOS checkout. Codex caches the plugin away from the repository, so the
# checkout is found through INTENTOS_ROOT (default ~/intentos), never relative to this script. Node is found through
# INTENTOS_NODE, then PATH, then the Homebrew default, because GUI hosts launch servers with a bare PATH.
ROOT="${INTENTOS_ROOT:-$HOME/intentos}"
ENTRY="$ROOT/bin/intentos.js"
if [ ! -f "$ENTRY" ]; then
  echo "IntentOS checkout not found at $ROOT (no bin/intentos.js); set INTENTOS_ROOT to the checkout" >&2
  exit 1
fi
NODE="${INTENTOS_NODE:-$(command -v node 2>/dev/null || echo /opt/homebrew/bin/node)}"
exec "$NODE" --disable-warning=ExperimentalWarning "$ENTRY" "$@"
