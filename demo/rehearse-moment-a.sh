#!/bin/sh
# Rehearse Moment A from the command line (same actions the Codex session performs through the MCP tools):
# start a live run on T12, merge the rename PR while it implements, and show the hook's note reaching the agent.
#   demo/rehearse-moment-a.sh [--root ~/intentos-demo] [--model gpt-6-luna] [--delay 35]
# Costs one live run. Run demo/reset.sh first; run it again afterwards.
set -eu
ROOT="$HOME/intentos-demo"; MODEL="${INTENTOS_CODEX_MODEL:-gpt-6-luna}"; DELAY=35
while [ $# -gt 0 ]; do case "$1" in --root) ROOT="$2"; shift 2;; --model) MODEL="$2"; shift 2;; --delay) DELAY="$2"; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
INTENTOS="$(cd "$(dirname "$0")/.." && pwd)"
export INTENTOS_HOME="$ROOT/home" INTENTOS_CODEX_MODEL="$MODEL"
DEMO="$ROOT/demandlib"
PR=$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))['rename_pr']['pr'])" "$ROOT/state.json")
TICKET=$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))['sentences']['momentA_start'].split(':',1)[1].strip())" "$ROOT/state.json")
echo "[rehearse] starting the T12 run ($MODEL); the rename PR #$PR merges after ${DELAY}s"
node --disable-warning=ExperimentalWarning "$INTENTOS/bin/intentos.js" --json run "$DEMO" "$TICKET" --task T12 > "$ROOT/rehearse-run.json" 2> "$ROOT/rehearse-run.log" &
RUNPID=$!
sleep "$DELAY"
echo "[rehearse] merging PR #$PR now"
node --disable-warning=ExperimentalWarning "$INTENTOS/bin/intentos.js" merge "$PR" --repo "$DEMO" --approve Priya Sam --by demo 2>&1 | grep -E "^PR|blocked" || true
wait $RUNPID || true
RUN=$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))['run_id'])" "$ROOT/rehearse-run.json")
STATE=$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))['state'])" "$ROOT/rehearse-run.json")
echo "[rehearse] run $RUN ended $STATE"
echo "[rehearse] hook activity (mergeguard how-made log in the worktree's git dir):"
HOWMADE="$DEMO/.git/worktrees/$RUN/mergeguard/howmade.jsonl"
if [ -f "$HOWMADE" ]; then python3 -I -c "
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1])]
kinds={}
for r in rows: kinds[r.get('kind') or r.get('type') or '?']=kinds.get(r.get('kind') or r.get('type') or '?',0)+1
print('  records:', len(rows), kinds)
for r in rows:
    if 'note' in json.dumps(r).lower() or 'stop' in json.dumps(r).lower(): print('  ', json.dumps(r)[:220])
" "$HOWMADE"; else echo "  (no how-made log: the hooks did not fire)"; fi
python3 -I -c "
import json,sys
v=json.load(open(sys.argv[1]))
print('[rehearse] verification:', v['status'], '| coordination:', v.get('coordination'))
" "$ROOT/home/runs/$RUN/verification.json" 2>/dev/null || echo "[rehearse] no verification.json"
sqlite3 "$ROOT/home/intentos.db" "select '[rehearse] runner sync: ' || event_type from run_events where run_id='$RUN' and event_type in ('coordination.synced','coordination.sync_conflict','coordination.sync_failed','base.advanced') order by rowid" 2>/dev/null || true
echo "[rehearse] events:"; sqlite3 "$ROOT/home/intentos.db" "select event_type from run_events where run_id='$RUN' order by rowid" 2>/dev/null | tr '\n' ' '; echo
echo "[rehearse] now: intentos merge $RUN --approve Priya   (Moment A's last sentence)"
