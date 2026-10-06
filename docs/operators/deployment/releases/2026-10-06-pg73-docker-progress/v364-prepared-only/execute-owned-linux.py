"""Independent bounded diagnostic executor; no CI dispatch, cloud API or dependency installation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--repo', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--execute-linux', action='store_true')
args = parser.parse_args()
if not args.execute_linux or sys.platform != 'linux':
    raise SystemExit('Requires explicit --execute-linux on an owned Linux runner')
here = Path(__file__).resolve().parent
repo = Path(args.repo).resolve()
out = Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=False)
manifest = json.loads((here / 'sealed-package.json').read_text())
for item in manifest['files']:
    data = (here / item['path']).read_bytes()
    if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
        raise SystemExit('Sealed diagnostic package changed: ' + item['path'])
env = {name: os.environ[name] for name in ('PATH', 'HOME', 'TMPDIR', 'LANG') if name in os.environ}
env.update({'CI': 'true', 'NO_COLOR': '1'})
node = subprocess.check_output(['which', 'node'], env=env, text=True).strip()
started_wall = time.time()
started = time.monotonic()
timed_out = False
with (out / 'executor.stdout.txt').open('wb') as stdout, (out / 'executor.stderr.txt').open('wb') as stderr:
    child = subprocess.Popen([node, str(here / 'run-v364-owned-diagnostic.mjs'), '--repo', str(repo), '--out', str(out), '--execute-linux'],
                             cwd=repo, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
    try:
        actual = child.wait(timeout=320)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=10)
        actual = 124
    # Miniflare children share this process group. A leftover is a failure, even after Node exit.
    leftover = False
    try:
        os.killpg(child.pid, 0)
        leftover = True
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
closed = out / 'closed-result.json'
raw = json.loads(closed.read_text()) if closed.exists() else None
files = []
for path in sorted(out.iterdir()):
    if path.is_file():
        data = path.read_bytes()
        files.append({'path': path.name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
result = {'schema': 'v364-owned-linux-executor-closed-v1', 'startedEpoch': started_wall,
          'elapsedMs': (time.monotonic() - started) * 1000, 'actualProcessExit': actual,
          'timedOut': timed_out, 'leftoverGroupKilled': leftover,
          'closedReportPresent': raw is not None, 'reportedActualExit': raw.get('actualExit') if raw else None,
          'allRuntimeClosed': bool(raw and raw.get('activeMiniflare') == 0 and all(x.get('closed') for x in raw.get('results', []))),
          'productionRequests': 0, 'ciInvocations': 0, 'files': files}
final_exit = 0 if actual == 0 and not leftover and raw and raw.get('actualExit') == 0 and result['allRuntimeClosed'] else 1
result['actualExit'] = final_exit
(out / 'executor.closed.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'actualExit': final_exit, 'actualProcessExit': actual, 'timedOut': timed_out, 'out': str(out)}))
raise SystemExit(final_exit)
