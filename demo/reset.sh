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
# Prepare the replacement before moving the live tree. The dashboard and MCP server
# may still have open files in the old tree; a directory swap keeps the reset usable.
STAGED="$ROOT.reset-$$"
OLD="$ROOT.old-$$"
trap 'rm -rf "$STAGED"' EXIT HUP INT TERM
cp -R "$SNAP" "$STAGED"
# Agent preferences belong to the user, not the disposable demo run state.
if [ -f "$ROOT/home/agent-config.json" ]; then cp "$ROOT/home/agent-config.json" "$STAGED/home/agent-config.json"; fi
if [ -d "$ROOT/home/agent-skills" ]; then
  rm -rf "$STAGED/home/agent-skills"
  cp -R "$ROOT/home/agent-skills" "$STAGED/home/agent-skills"
fi
if [ -e "$ROOT" ]; then mv "$ROOT" "$OLD"; fi
mv "$STAGED" "$ROOT"
trap - EXIT HUP INT TERM
python3 -I - "$ROOT/home/dashboard.json" <<'EOF'
import datetime, json, pathlib, sys
file = pathlib.Path(sys.argv[1])
config = json.loads(file.read_text()) if file.exists() else {}
config["visible_after"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
file.write_text(json.dumps(config, indent=2) + "\n")
EOF
if [ -e "$OLD" ]; then rm -rf "$OLD" || echo "warning: old demo directory remains at $OLD" >&2; fi
echo "restored $ROOT from $SNAP ($(date))"
echo "prepared runs:"
python3 -I - "$ROOT/state.json" <<'EOF'
import json, sys
s = json.load(open(sys.argv[1]))
for k, v in s["runs"].items():
    print(f"  {k:16} {v['runId']}  {v['state']}")
if s.get("rename_pr"): print(f"  rename PR        #{s['rename_pr']['pr']} on {s['rename_pr']['branch']} (tier {s['rename_pr']['tier']})")
print("red main:", s.get("red", {}).get("main", {}).get("status", "not prepared"))
print("restart Codex, then follow demo/RUNBOOK.md")
EOF
