#!/bin/sh
# Restore the interview demo to its prepared state in seconds, without spending Codex runs.
#   demo/reset.sh                 restore <root> from <root>.snapshot (default root ~/intentos-demo)
#   demo/reset.sh --root <dir>    another root
#   demo/reset.sh --destroy       delete the root and the snapshot (then run demo/prepare.ts again)
# Restart the Codex session afterwards so the intentos-demo MCP server reopens the restored store.
set -eu
ROOT="$HOME/intentos-demo"
DESTROY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --destroy) DESTROY=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
SNAP="$ROOT.snapshot"
if [ "$DESTROY" = 1 ]; then
  rm -rf "$ROOT" "$SNAP"
  echo "removed $ROOT and $SNAP; rebuild with: node --disable-warning=ExperimentalWarning demo/prepare.ts --root $ROOT"
  exit 0
fi
if [ ! -d "$SNAP" ]; then
  echo "no snapshot at $SNAP; run demo/prepare.ts first" >&2
  exit 1
fi
# Worktrees are registered inside each clone's .git by absolute path, and the snapshot restores the same paths.
rm -rf "$ROOT"
cp -R "$SNAP" "$ROOT"
echo "restored $ROOT from $SNAP ($(date))"
echo "prepared runs:"
python3 -I - "$ROOT/state.json" <<'EOF'
import json, sys
s = json.load(open(sys.argv[1]))
for k, v in s["runs"].items():
    print(f"  {k:16} {v['runId']}  {v['state']}")
print("red main:", s.get("red", {}).get("main", {}).get("status", "not prepared"))
print("restart Codex, then follow demo/RUNBOOK.md")
EOF
