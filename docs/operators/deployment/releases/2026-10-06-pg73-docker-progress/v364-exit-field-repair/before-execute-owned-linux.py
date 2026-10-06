"""Bounded, secret-free Linux executor; never dispatches CI or changes dependencies."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import traceback


def digest(path):
    data = path.read_bytes()
    return {'path': path.name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def contained(path, parent):
    return path == parent or parent in path.parents


parser = argparse.ArgumentParser()
parser.add_argument('--repo', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--execute-linux', action='store_true')
args = parser.parse_args()
here = Path(__file__).resolve().parent
repo = Path(args.repo).resolve()
output_arg = Path(args.out).absolute()
out = output_arg.resolve()
if output_arg.is_symlink() or contained(out, repo) or contained(out, here):
    raise SystemExit('Output must be a new unique directory outside the checkout/package')
# Existing directories and symlinks are rejected before writing anything there.
out.mkdir(mode=0o700, exist_ok=False)
stdout_path = out / 'executor.stdout.txt'
stderr_path = out / 'executor.stderr.txt'
started_wall = time.time()
started = time.monotonic()
child = None
raw = None
actual = None
timed_out = False
interrupted = False
fatal = None
manifest_hash = None
subreaper = False
group_gone = True
leftover_killed = False
direct_child_reaped = False
reaped_descendants = []
cleanup_errors = []
run_metadata = {name: os.environ.get(name) for name in ('GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_WORKFLOW', 'GITHUB_JOB')}


def interrupt(signum, _frame):
    raise InterruptedError('executor interrupted by signal ' + str(signum))


def group_exists():
    if child is None:
        return False
    try:
        os.killpg(child.pid, 0)
        return True
    except ProcessLookupError:
        return False


def reap_group_children():
    if child is None or not subreaper:
        return
    while True:
        try:
            pid, status = os.waitpid(-child.pid, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return
        reaped_descendants.append({'pid': pid, 'waitStatus': status})


def terminate_group():
    global group_gone, leftover_killed, direct_child_reaped
    if child is None:
        return
    if group_exists():
        leftover_killed = True
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    try:
        child.wait(timeout=10)
        direct_child_reaped = True
    except subprocess.TimeoutExpired:
        pass
    reap_group_children()
    if group_exists():
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        child.wait(timeout=10)
        direct_child_reaped = True
    except subprocess.TimeoutExpired as error:
        cleanup_errors.append(str(error))
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        reap_group_children()
        if not group_exists():
            break
        time.sleep(0.05)
    group_gone = not group_exists()


with stdout_path.open('wb') as stdout, stderr_path.open('wb') as stderr:
    try:
        if not args.execute_linux or sys.platform != 'linux':
            raise RuntimeError('Requires explicit --execute-linux on an owned Linux runner')
        signal.signal(signal.SIGTERM, interrupt)
        signal.signal(signal.SIGINT, interrupt)
        manifest_path = here / 'sealed-package.json'
        manifest_bytes = manifest_path.read_bytes()
        manifest_hash = hashlib.sha256(manifest_bytes).hexdigest()
        manifest = json.loads(manifest_bytes)
        if manifest['schema'] != 'v364-owned-linux-sealed-package-v1':
            raise RuntimeError('Unknown sealed package schema')
        for item in manifest['files']:
            relative = Path(item['path'])
            if relative.is_absolute() or '..' in relative.parts:
                raise RuntimeError('Manifest paths must stay in the portable package')
            path = here / relative
            if path.is_symlink() or not contained(path.resolve(), here):
                raise RuntimeError('Manifest symlink/path escapes the portable package')
            data = path.read_bytes()
            if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
                raise RuntimeError('Sealed diagnostic package changed: ' + item['path'])
        # Adopt orphaned descendants and preserve their actual wait statuses after group termination.
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(36, 1, 0, 0, 0) != 0:  # Linux PR_SET_CHILD_SUBREAPER, available since 3.4.
            raise OSError(ctypes.get_errno(), 'PR_SET_CHILD_SUBREAPER failed')
        subreaper = True
        env = {name: os.environ[name] for name in ('PATH', 'HOME', 'TMPDIR', 'LANG') if name in os.environ}
        env.update({'CI': 'true', 'NO_COLOR': '1'})
        node = shutil.which('node', path=env.get('PATH'))
        if not node:
            raise RuntimeError('Node is missing from the controlled PATH')
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, env=env, text=True, timeout=10, stderr=stderr).strip()
        if run_metadata['GITHUB_SHA'] and head != run_metadata['GITHUB_SHA']:
            raise RuntimeError('Checkout HEAD does not match the workflow SHA')
        receipt = {'schema': 'v364-owned-linux-executor-start-v1', 'repo': str(repo), 'output': str(out),
                   'startedEpoch': started_wall, 'freshOutputCreated': True, 'packageSHA256': manifest_hash,
                   'checkoutSHA': head, 'run': run_metadata, 'outerTimeoutSeconds': 320}
        receipt_path = out / 'executor-start.json'
        receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
        child = subprocess.Popen([node, str(here / 'run-v364-owned-diagnostic.mjs'), '--repo', str(repo), '--out', str(out),
                                  '--execute-linux', '--executor-receipt', str(receipt_path)],
                                 cwd=repo, env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, start_new_session=True)
        try:
            actual = child.wait(timeout=320)
            direct_child_reaped = True
        except subprocess.TimeoutExpired:
            timed_out = True
            actual = 124
        except InterruptedError:
            interrupted = True
            actual = 130
            raise
    except BaseException as error:
        fatal = {'name': type(error).__name__, 'message': str(error)}
        stderr.write(traceback.format_exc().encode())
        stderr.flush()
        if actual is None:
            actual = 1
    finally:
        # Promise.race does not cancel tasks. This outer group closure is authoritative.
        for signum in (signal.SIGTERM, signal.SIGINT):
            if sys.platform == 'linux':
                signal.signal(signum, signal.SIG_IGN)
        try:
            terminate_group()
        except BaseException as error:
            cleanup_errors.append(type(error).__name__ + ': ' + str(error))
            group_gone = False
            stderr.write(traceback.format_exc().encode())
        stderr.flush()

closed_path = out / 'closed-result.json'
try:
    raw = json.loads(closed_path.read_text()) if closed_path.exists() else None
except (OSError, ValueError) as error:
    fatal = {'name': type(error).__name__, 'message': 'Invalid Node closed report: ' + str(error)}
cooperative_close = bool(raw and raw.get('activeMiniflare') == 0 and len(raw.get('results', [])) == 8
                         and all(item.get('closed') for item in raw['results']))
success = (actual == 0 and not fatal and not timed_out and not interrupted and not leftover_killed and group_gone
           and direct_child_reaped and not cleanup_errors and cooperative_close and raw.get('actualExit') == 0)
final_exit = 0 if success else 1
result = {'schema': 'v364-owned-linux-executor-closed-v1', 'startedEpoch': started_wall,
          'elapsedMs': (time.monotonic() - started) * 1000, 'actualProcessExit': actual, 'actualExit': final_exit,
          'outcome': 'STRICT_SYNTHETIC_ONLY_PASS' if success else 'STRICT_FAILURE_OR_UNKNOWN_PRESERVED',
          'timedOut': timed_out, 'interrupted': interrupted, 'fatal': fatal,
          'packageSHA256': manifest_hash, 'run': run_metadata, 'reportedActualExit': raw.get('actualExit') if raw else None,
          'closedReportPresent': raw is not None,
          'closure': {'authority': 'this executor', 'subreaperEnabled': subreaper, 'directChildReaped': direct_child_reaped,
                      'groupGone': group_gone, 'leftoverGroupKilled': leftover_killed, 'reapedDescendants': reaped_descendants,
                      'cooperativeNativeFinallyVerified': cooperative_close, 'errors': cleanup_errors},
          'productionRequests': 0, 'ciInvocations': 0,
          'files': [digest(path) for path in sorted(out.iterdir()) if path.is_file()]}
(out / 'executor.closed.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'actualExit': final_exit, 'actualProcessExit': actual, 'timedOut': timed_out, 'output': str(out)}))
raise SystemExit(final_exit)
