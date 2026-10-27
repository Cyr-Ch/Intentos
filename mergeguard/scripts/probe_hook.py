"""Record Codex's actual stdin contract before implementing the integration."""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    payload = json.load(sys.stdin)
    target = Path(os.environ.get('MERGEGUARD_PROBE_LOG', '/tmp/mergeguard-hook-probe.jsonl'))
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('a') as stream:
        stream.write(json.dumps({'observed_at': datetime.now(timezone.utc).isoformat(), 'payload': payload}) + '\n')
except Exception as exc:
    print(f'mergeguard probe: {exc}', file=sys.stderr)
print('{}')
