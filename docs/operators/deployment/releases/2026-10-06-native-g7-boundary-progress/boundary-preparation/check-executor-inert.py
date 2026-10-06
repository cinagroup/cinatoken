import ast
import json
from pathlib import Path
import signal
import types

source = Path('C:/cinagroup/cinatoken/scripts/diagnostics/v364-owned-linux-boundary/execute-owned-linux.py').read_text()
tree = ast.parse(source)
names = {'parse_stat', 'reap_adopted_zombies', 'live_or_unknown', 'send_owned_signal', 'terminate_group'}
module = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names], type_ignores=[])
ns = {'os': types.SimpleNamespace(), 'signal': types.SimpleNamespace(SIGTERM=15, SIGKILL=9), 'subprocess': types.SimpleNamespace(TimeoutExpired=RuntimeError)}
exec(compile(module, '<inert-extracted-functions>', 'exec'), ns)


def stat(pid, comm, state='Z', ppid=6000, pgrp=5000, session=5000, start='12345'):
    fields = [state, str(ppid), str(pgrp), str(session)] + ['0'] * 15 + [start, '0', '0']
    return str(pid) + ' (' + comm + ') ' + ' '.join(fields)


sample = ns['parse_stat'](stat(5001, 'workerd (nested) ) tail'))
assert sample == {'pid': 5001, 'comm': 'workerd (nested) ) tail', 'state': 'Z', 'ppid': 6000, 'pgrp': 5000, 'session': 5000, 'startTimeTicks': '12345'}
tests = [{'name': 'proc stat parses comm parentheses and actual field22 identity', 'actualExit': 0}]
waited = []
ns.update(child=types.SimpleNamespace(pid=5000), subreaper=True, cleanup_errors=[], reaped_descendants=[])
ns['os'] = types.SimpleNamespace(getpid=lambda: 6000, WNOHANG=1, waitpid=lambda pid, flags: (waited.append((pid, flags)) or (pid, 0)), waitstatus_to_exitcode=lambda status: 0)


class FakePath:
    value = stat(5001, 'workerd')
    raises = False
    def __init__(self, *args):
        self.parts = args
    def read_text(self):
        if FakePath.raises:
            raise FileNotFoundError()
        return FakePath.value


ns['Path'] = FakePath
ns['reap_adopted_zombies']({'members': [sample, {**sample, 'pid': 5000}, {**sample, 'pid': 5002, 'ppid': 42}, {**sample, 'pid': 5003, 'state': 'S'}]})
assert waited == [(5001, 1)]
assert ns['reaped_descendants'][0]['waitStatus'] == 0 and not ns['cleanup_errors']
tests.append({'name': 'only adopted zombie exact PID reaped; direct Node/nonchild/live excluded', 'actualExit': 0})
ns['os'].waitpid = lambda pid, flags: (0, 0)
ns['reap_adopted_zombies']({'members': [sample]})
assert ns['cleanup_errors']
tests.append({'name': 'WNOHANG0 is unknown failure, never synthetic exit', 'actualExit': 0})
ns['cleanup_errors'] = []
FakePath.raises = True
ns['reap_adopted_zombies']({'members': [sample]})
assert ns['cleanup_errors'] and ns['reaped_descendants'][-1]['waitStatus'] is None
tests.append({'name': 'vanished adopted candidate retains null waitstatus and failure', 'actualExit': 0})
FakePath.raises = False
FakePath.value = stat(5001, 'workerd', start='99999')
ns['cleanup_errors'] = []
ns['reap_adopted_zombies']({'members': [sample]})
assert ns['cleanup_errors']
tests.append({'name': 'start identity drift fails without waitpid', 'actualExit': 0})


def row(live=0, zombies=0, unknown=None, exists=False, members=None, label='stub'):
    return {'label': label, 'live': live, 'zombies': zombies, 'unknown': unknown or [], 'groupExists': exists, 'members': members or [], 'complete': not unknown}


zombie = row(zombies=1, exists=True, members=[sample])
assert not ns['live_or_unknown'](zombie)
assert ns['live_or_unknown'](row(live=1, exists=True, members=[{**sample, 'state': 'S'}]))
assert ns['live_or_unknown'](row(unknown=[{'pid': 5001}], exists=True))
assert ns['live_or_unknown'](row(exists=True))
assert not ns['live_or_unknown'](row())
tests.append({'name': 'zombie-only is distinct from live/unknown/group-only existence', 'actualExit': 0})
sent = []
ns.update(signal_attempts=[], leftover_killed=False)
ns['os'].killpg = lambda pg, signum: sent.append((pg, signum))
ns['send_owned_signal'](signal.SIGTERM, zombie)
assert not sent and not ns['leftover_killed']
ns['send_owned_signal'](signal.SIGTERM, row(live=1, exists=True, members=[sample]))
assert sent == [(5000, signal.SIGTERM)] and ns['leftover_killed']
tests.append({'name': 'kill only live/unknown, actual send marks forced', 'actualExit': 0})


class Clock:
    now = 0.0
    def monotonic(self):
        self.now += 0.001
        return self.now
    def sleep(self, value):
        self.now += value


class Child:
    pid = 5000
    def __init__(self, returncode):
        self.returncode = returncode
        self.waits = []
    def wait(self, timeout):
        self.waits.append(timeout)
        if self.returncode is None:
            raise RuntimeError('stub TimeoutExpired')
        return self.returncode


def cleanup_stub(zombie_only):
    model = {'members': [sample] if zombie_only else [{**sample, 'pid': 5000, 'state': 'S'}]}
    child = Child(1 if zombie_only else None)
    ns.update(child=child, cleanup_errors=[], reaped_descendants=[], signal_attempts=[], leftover_killed=False,
              direct_child_reaped=zombie_only, group_gone=False, time=Clock())
    ns['poll_direct'] = lambda: None
    ns['group_exists'] = lambda: bool(model['members'])
    ns['census'] = lambda label: row(live=sum(v['state'] != 'Z' for v in model['members']), zombies=sum(v['state'] == 'Z' for v in model['members']), exists=bool(model['members']), members=model['members'][:], label=label)
    def fake_reap(sample):
        if sample['zombies']:
            model['members'] = [v for v in model['members'] if v['state'] != 'Z']
    ns['reap_adopted_zombies'] = fake_reap
    def fake_signal(pg, signum):
        child.returncode = -int(signum)
        model['members'] = []
    ns['os'].killpg = fake_signal
    ns['terminate_group']()
    assert ns['group_gone'] and ns['direct_child_reaped'] and not ns['cleanup_errors']
    if zombie_only:
        assert not ns['leftover_killed'] and not ns['signal_attempts'] and child.returncode == 1
    else:
        assert ns['leftover_killed'] and len(ns['signal_attempts']) == 1 and child.returncode == -15
    return child


cleanup_stub(True)
tests.append({'name': 'authoritative cleanup first reaps zombie-only group and never sends kill', 'actualExit': 0})
forced_child = cleanup_stub(False)
tests.append({'name': 'authoritative cleanup live group sends TERM, preserves real child -15', 'actualExit': 0})
result_dict = next(node.value for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'result' for t in node.targets))
fields = {key.value: value for key, value in zip(result_dict.keys, result_dict.values)}
for runner, child, expected in [(124, forced_child, -15), (130, Child(-9), -9), (0, Child(0), 0), (1, Child(1), 1), (1, None, None)]:
    scope = {'child': child, 'runner_code': runner}
    actual = eval(compile(ast.Expression(fields['actualProcessExit']), '<actual-exit>', 'eval'), scope)
    reported_runner = eval(compile(ast.Expression(fields['runnerOutcomeCode']), '<runner-outcome>', 'eval'), scope)
    assert actual == expected and reported_runner == runner
tests.append({'name': 'real receipt AST keeps runner124/130 separate from child -15/-9 and null', 'actualExit': 0})
assert 'os.waitpid(-' not in source
print(json.dumps({'schema': 'v364-boundary-executor-inert-check-v1', 'actualExit': 0, 'checks': tests,
                  'realProcessSpawned': False, 'nodeExecuted': False, 'workerdExecuted': False, 'linuxClosureProven': False}))
