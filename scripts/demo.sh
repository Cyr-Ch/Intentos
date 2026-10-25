#!/usr/bin/env bash
# One-command offline demonstration: index -> explain -> good patch (review-ready) -> bad patch (blocked) -> abstain route.
set -euo pipefail
cd "$(dirname "$0")/.."
NODE="node --disable-warning=ExperimentalWarning bin/intentos.js"
FIX=.intentos/fixtures/startup_billing
TASK="Add a 15% promotional discount for eligible enterprise subscriptions"

[ -x .intentos/venv/bin/python ] || $NODE setup python
$NODE fixture build --force >/dev/null
$NODE index "$FIX"
echo; echo "=== explain ==="; $NODE explain "$FIX" "$TASK" | head -40
echo; echo "=== offline run: known-good patch ==="
$NODE run "$FIX" "$TASK" --offline --offline-patch benchmarks/offline_patches/task-a.good.patch
echo; echo "=== offline run: known-bad patch + fake success claim ==="
$NODE run "$FIX" "$TASK" --offline --offline-patch benchmarks/offline_patches/task-a.bad.patch --offline-claim-success || true
echo; echo "=== offline run: abstain route (bug already fixed on HEAD) ==="
$NODE run "$FIX" "Fix the bug where cancelled contracts still receive the volume discount" --offline --offline-route abstain
echo; echo "=== runs ==="; $NODE runs
echo; echo "Reports are in .intentos/runs/<run-id>/report.md"
