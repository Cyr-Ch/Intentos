#!/usr/bin/env bash
# One command per demo act. act1..act5 follow the brief; the named forms are aliases.
set -euo pipefail
TOOL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${MERGEGUARD_PYTHON:-$TOOL_ROOT/.venv/bin/python}"
ACT="${1:-act1}"
WORLD="${2:-$TOOL_ROOT/../mergeguard-$ACT}"
[[ $# -gt 0 ]] && shift
[[ $# -gt 0 ]] && shift
case "$ACT" in
  act1|prevent)
    "$PYTHON" -m mergeguard.demo prevent --world "$WORLD" "$@"
    echo
    echo "Live version with a real agent on laptop B:  $0 live ${WORLD}-live [--agent claude|codex]" ;;
  act2|review)   exec "$PYTHON" -m mergeguard.demo review  --world "$WORLD" "$@" ;;
  act3|recover)  exec "$PYTHON" -m mergeguard.demo recover --world "$WORLD" "$@" ;;
  act4|learn)    exec "$PYTHON" -m mergeguard.demo learn   --world "$WORLD" "$@" ;;
  act5|evaluate) exec "$PYTHON" "$TOOL_ROOT/eval/compare.py" --repeats 3 "$@" ;;
  live)          exec "$PYTHON" -m mergeguard.demo live    --world "$WORLD" "$@" ;;
  merge-a)       exec "$PYTHON" -m mergeguard.demo merge-a --world "$WORLD" ;;
  live-eval)     exec "$PYTHON" "$TOOL_ROOT/eval/live_compare.py" "$@" ;;
  *) echo "usage: $0 {act1|act2|act3|act4|act5|prevent|review|recover|learn|evaluate|live|merge-a|live-eval} [world] [args]" >&2; exit 2 ;;
esac
