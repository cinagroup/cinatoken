"""Owned Linux direct-socket executor. Real process exits and /proc live/Z closure only."""
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


def parse_stat(text):
    end = text.rfind(') ')
    start = text.find(' (')
    fields = text[end + 2:].split()
    if start < 0 or end < start or len(fields) < 20:
        raise ValueError('Invalid /proc stat')
    return {'pid': int(text[:start]), 'comm': text[start + 2:end], 'state': fields[0],
            'ppid': int(fields[1]), 'pgrp': int(fields[2]), 'session': int(fields[3]),
            'startTimeTicks': fields[19]}


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
    raise SystemExit('Output must be a fresh unique directory outside the checkout/package')
out.mkdir(mode=0o700, exist_ok=False)
stdout_path = out / 'executor.stdout.txt'
stderr_path = out / 'executor.stderr.txt'
started_wall = time.time()
started = time.monotonic()
child = None
raw = None
runner_code = None
timed_out = False
interrupted = False
fatal = None
manifest_hash = None
checkout_sha = None
subreaper = False
group_gone = True
leftover_killed = False
direct_child_reaped = False
reaped_descendants = []
cleanup_errors = []
census_records = []
signal_attempts = []
run_metadata = {name: os.environ.get(name) for name in ('GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_WORKFLOW', 'GITHUB_JOB')}


def interrupt(signum, _frame):
    raise InterruptedError('Executor interrupted by signal ' + str(signum))


def group_exists():
    if child is None:
        return False
    try:
        os.killpg(child.pid, 0)
        return True
    except ProcessLookupError:
        return False


def census(label):
    members = []
    unknown = []
    if child is not None:
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit():
                continue
            try:
                item = parse_stat((entry / 'stat').read_text())
                if item['pgrp'] == child.pid and item['session'] == child.pid:
                    members.append(item)
            except (FileNotFoundError, ProcessLookupError):
                pass  # A process vanished during the finite sample.
            except (OSError, ValueError) as error:
                unknown.append({'pid': int(entry.name), 'error': type(error).__name__})
    row = {'label': label, 'elapsedMs': (time.monotonic() - started) * 1000,
           'pgrp': child.pid if child else None, 'session': child.pid if child else None,
           'members': sorted(members, key=lambda item: item['pid']),
           'live': sum(item['state'] not in ('Z', 'X') for item in members),
           'zombies': sum(item['state'] == 'Z' for item in members),
           'unknown': unknown, 'complete': not unknown,
           'groupExists': group_exists()}
    if len(census_records) >= 256:
        raise RuntimeError('Process census receipt bound exceeded')
    census_records.append(row)
    return row


def poll_direct():
    global direct_child_reaped
    if child is not None and child.poll() is not None:
        direct_child_reaped = True


def reap_adopted_zombies(sample):
    """Popen alone owns Node. Only individually confirmed adopted Z descendants."""
    if child is None or not subreaper:
        return
    for candidate in sample['members']:
        if candidate['pid'] == child.pid or candidate['ppid'] != os.getpid() or candidate['state'] != 'Z':
            continue
        try:
            current = parse_stat(Path('/proc', str(candidate['pid']), 'stat').read_text())
            identity = ('pid', 'startTimeTicks', 'pgrp', 'session')
            if any(current[key] != candidate[key] for key in identity) or current['ppid'] != os.getpid() or current['state'] != 'Z':
                cleanup_errors.append('Adopted candidate identity/state changed: ' + str(candidate['pid']))
                continue
            pid, status = os.waitpid(candidate['pid'], os.WNOHANG)
            if pid:
                reaped_descendants.append({'pid': pid, 'startTimeTicks': current['startTimeTicks'],
                                          'waitStatus': status, 'waitExitCode': os.waitstatus_to_exitcode(status),
                                          'source': 'individually identified adopted zombie'})
            else:
                cleanup_errors.append('Confirmed adopted zombie did not return a wait status: ' + str(candidate['pid']))
        except (FileNotFoundError, ProcessLookupError, ChildProcessError):
            # Race is observable; do not synthesize a wait status.
            cleanup_errors.append('Adopted candidate wait status unavailable: ' + str(candidate['pid']))
            reaped_descendants.append({'pid': candidate['pid'], 'startTimeTicks': candidate['startTimeTicks'],
                                      'waitStatus': None, 'waitExitCode': None, 'source': 'candidate vanished/no longer waitable'})


def live_or_unknown(sample):
    # killpg(0) observes zombies too. It is never used alone to claim live members.
    return bool(sample['live'] or sample['unknown'] or (sample['groupExists'] and not sample['members']))


def send_owned_signal(signum, sample):
    global leftover_killed
    if not live_or_unknown(sample):
        return
    row = {'signal': signum, 'censusLabel': sample['label'], 'live': sample['live'],
           'zombies': sample['zombies'], 'unknown': sample['unknown'], 'sent': False}
    try:
        os.killpg(child.pid, signum)
        row['sent'] = True
        leftover_killed = True
    except ProcessLookupError:
        row['alreadyGone'] = True
    signal_attempts.append(row)


def terminate_group():
    global group_gone, direct_child_reaped
    if child is None:
        return
    poll_direct()
    before = census('before-initial-adopted-reap')
    reap_adopted_zombies(before)
    sample = census('after-initial-adopted-reap')
    # Allow completed Node's adopted zombies to be reaped before deciding that
    # any kill is necessary. Never waitpid(-pgrp), which could steal Node's status.
    deadline = time.monotonic() + 1
    while sample['groupExists'] and not live_or_unknown(sample) and time.monotonic() < deadline:
        reap_adopted_zombies(sample)
        time.sleep(0.05)
        sample = census('zombie-only-adopt-drain')
    send_owned_signal(signal.SIGTERM, sample)
    try:
        child.wait(timeout=10)
        direct_child_reaped = True
    except subprocess.TimeoutExpired:
        pass
    reap_adopted_zombies(census('after-term-before-reap'))
    sample = census('after-term-after-reap')
    send_owned_signal(signal.SIGKILL, sample)
    try:
        child.wait(timeout=10)
        direct_child_reaped = True
    except subprocess.TimeoutExpired as error:
        cleanup_errors.append(str(error))
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        poll_direct()
        sample = census('final-adopt-drain')
        reap_adopted_zombies(sample)
        if not group_exists():
            break
        time.sleep(0.05)
    final_sample = census('final-post-reap')
    group_gone = not final_sample['groupExists'] and final_sample['complete']
    if not final_sample['complete']:
        cleanup_errors.append('Final /proc census incomplete; closure is unknown')


with stdout_path.open('wb') as stdout, stderr_path.open('wb') as stderr:
    try:
        if not args.execute_linux or sys.platform != 'linux':
            raise RuntimeError('Requires explicit --execute-linux on an owned Linux runner')
        signal.signal(signal.SIGTERM, interrupt)
        signal.signal(signal.SIGINT, interrupt)
        manifest_bytes = (here / 'sealed-package.json').read_bytes()
        manifest_hash = hashlib.sha256(manifest_bytes).hexdigest()
        manifest = json.loads(manifest_bytes)
        if manifest['schema'] != 'v364-direct-socket-sealed-package-v1':
            raise RuntimeError('Unknown sealed boundary package schema')
        for item in manifest['files']:
            relative = Path(item['path'])
            if relative.is_absolute() or '..' in relative.parts:
                raise RuntimeError('Manifest path escapes package')
            path = here / relative
            if path.is_symlink() or not contained(path.resolve(), here):
                raise RuntimeError('Manifest symlink escapes package')
            data = path.read_bytes()
            if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
                raise RuntimeError('Sealed boundary package changed: ' + item['path'])
        workflow = manifest['workflow']
        if workflow['path'] != '.github/workflows/v364-direct-socket.yml':
            raise RuntimeError('Unexpected workflow seal path')
        workflow_path = repo / workflow['path']
        if workflow_path.is_symlink() or not contained(workflow_path.resolve(), repo):
            raise RuntimeError('Workflow path escapes checkout')
        data = workflow_path.read_bytes()
        if len(data) != workflow['bytes'] or hashlib.sha256(data).hexdigest() != workflow['sha256']:
            raise RuntimeError('Sealed boundary workflow changed')
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'PR_SET_CHILD_SUBREAPER failed')
        subreaper = True
        env = {name: os.environ[name] for name in ('PATH', 'HOME', 'TMPDIR', 'LANG') if name in os.environ}
        env.update({'CI': 'true', 'NO_COLOR': '1'})
        node = shutil.which('node', path=env.get('PATH'))
        if not node:
            raise RuntimeError('Node missing from controlled PATH')
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, env=env, text=True, timeout=10, stderr=stderr).strip()
        checkout_sha = head
        if run_metadata['GITHUB_SHA'] and head != run_metadata['GITHUB_SHA']:
            raise RuntimeError('Checkout differs from workflow SHA')
        receipt = {'schema': 'v364-direct-socket-executor-start-v1', 'repo': str(repo), 'output': str(out),
                   'startedEpoch': started_wall, 'freshOutputCreated': True, 'packageSHA256': manifest_hash,
                   'checkoutSHA': head, 'run': run_metadata, 'outerTimeoutSeconds': 360}
        receipt_path = out / 'executor-start.json'
        receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
        child = subprocess.Popen([node, str(here / 'run-direct-socket.mjs'), '--repo', str(repo), '--out', str(out),
                                  '--execute-linux', '--executor-receipt', str(receipt_path)],
                                 cwd=repo, env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, start_new_session=True)
        try:
            runner_code = child.wait(timeout=360)
            direct_child_reaped = True
        except subprocess.TimeoutExpired:
            timed_out = True
            runner_code = 124
        except InterruptedError:
            interrupted = True
            runner_code = 130
            raise
    except BaseException as error:
        fatal = {'name': type(error).__name__, 'message': str(error)}
        stderr.write(traceback.format_exc().encode())
        stderr.flush()
        if runner_code is None:
            runner_code = 1
    finally:
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
    if raw is not None:
        expected_ids = {'native-worker-reader-cancel'}
        expected_ids.update('direct-socket-' + kind + '-' + mode for kind in ('bare', 'binding') for mode in ('destroy', 'rst'))
        if (not isinstance(raw, dict) or raw.get('schema') != 'v364-direct-socket-closed-v1'
                or type(raw.get('actualExit')) is not int or raw['actualExit'] not in (0, 1)
                or type(raw.get('activeMiniflare')) is not int or raw['activeMiniflare'] < 0
                or not isinstance(raw.get('results'), list)
                or not all(isinstance(item, dict) and isinstance(item.get('caseId'), str) and type(item.get('closed')) is bool
                           and item.get('baselineEligible') is False for item in raw['results'])
                or len(raw['results']) != 5 or {item.get('caseId') for item in raw['results']} != expected_ids):
            raise ValueError('Invalid/incomplete five-case Node closure shape')
except (OSError, ValueError) as error:
    fatal = {'name': type(error).__name__, 'message': 'Invalid Node closed report: ' + str(error)}
    raw = None
api_disposal_reported = bool(raw and raw.get('activeMiniflare') == 0 and len(raw.get('results', [])) == 5
                            and all(item.get('closed') for item in raw['results']))
outer_unforced_close = (api_disposal_reported and group_gone and direct_child_reaped and not leftover_killed
                        and not cleanup_errors and not timed_out and not interrupted)
success = (runner_code == 0 and not fatal and outer_unforced_close and raw.get('actualExit') == 0)
final_exit = 0 if success else 1
result = {'schema': 'v364-direct-socket-executor-closed-v1', 'startedEpoch': started_wall,
          'elapsedMs': (time.monotonic() - started) * 1000,
          'actualProcessExit': child.returncode if child is not None else None,
          'runnerOutcomeCode': runner_code, 'actualExit': final_exit,
          'outcome': 'STRICT_SYNTHETIC_DIRECT_SOCKET_COMPARISON_ONLY' if success else 'STRICT_FAILURE_OR_UNKNOWN_PRESERVED',
          'timedOut': timed_out, 'interrupted': interrupted, 'fatal': fatal,
          'packageSHA256': manifest_hash, 'checkoutSHA': checkout_sha, 'run': run_metadata, 'reportedActualExit': raw.get('actualExit') if raw else None,
          'closedReportPresent': raw is not None,
          'closure': {'authority': 'this executor', 'subreaperEnabled': subreaper, 'directChildReaped': direct_child_reaped,
                      'groupGone': group_gone, 'leftoverGroupKilled': leftover_killed, 'signalAttempts': signal_attempts,
                      'reapedDescendants': reaped_descendants, 'processCensus': census_records,
                      'apiDisposalReported': api_disposal_reported, 'outerUnforcedGroupClose': outer_unforced_close,
                      'gracefulWorkerdExitProven': False, 'miniflareDisposeMaySendSIGKILL': True,
                      'errors': cleanup_errors},
          'causeProven': False, 'productionRequests': 0, 'ciInvocations': 0,
          'files': [digest(path) for path in sorted(out.iterdir()) if path.is_file()]}
(out / 'executor.closed.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'actualExit': final_exit, 'actualProcessExit': child.returncode if child is not None else None,
                  'runnerOutcomeCode': runner_code, 'timedOut': timed_out, 'output': str(out)}))
raise SystemExit(final_exit)
