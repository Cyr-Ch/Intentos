#!/usr/bin/env bash
set -euo pipefail
TOOL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${MERGEGUARD_PYTHON:-$TOOL_ROOT/.venv/bin/python}"
if [[ ! -x "$PYTHON" ]]; then
  python3 -m venv "$TOOL_ROOT/.venv"
  "$PYTHON" -m pip install -e "$TOOL_ROOT[test]"
fi
exec "$PYTHON" -m mergeguard.demo setup --world "${1:-$TOOL_ROOT/../mergeguard-world}"
