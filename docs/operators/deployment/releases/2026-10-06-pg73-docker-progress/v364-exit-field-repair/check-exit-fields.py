import ast
import json
from pathlib import Path
from types import SimpleNamespace
import sys

review = Path(__file__).resolve().parent
current = Path('C:/cinagroup/cinatoken/scripts/diagnostics/v364-owned-linux/execute-owned-linux.py')
before = ast.parse((review / 'before-execute-owned-linux.py').read_text())
after = ast.parse(current.read_text())
find = lambda tree, name: next(node.value for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets))
assert ast.dump(find(before, 'success')) == ast.dump(find(after, 'success')), 'success logic changed'
result_expr = compile(ast.Expression(find(after, 'result')), '<result-only>', 'eval')
print_expr = compile(ast.Expression(next(node.value.args[0] for node in after.body if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id == 'print')), '<print-only>', 'eval')
success_expr = compile(ast.Expression(find(after, 'success')), '<success-only>', 'eval')
cases = [
    ('normal-pass', 0, 0, False, False, 0),
    ('normal-fail', 1, 1, False, False, 1),
    ('timeout', 124, -15, True, False, 1),
    ('interrupt', 130, -9, False, True, 1),
    ('preflight-no-child', 1, None, False, False, 1),
]
rows = []
for label, runner, child_return, timeout, interruption, expected_exit in cases:
    raw = {'actualExit': runner} if child_return is not None else None
    env = dict(actual=runner, child=SimpleNamespace(returncode=child_return) if child_return is not None else None,
               fatal=None, timed_out=timeout, interrupted=interruption, leftover_killed=timeout or interruption,
               group_gone=True, direct_child_reaped=child_return is not None, cleanup_errors=[],
               cooperative_close=not timeout and not interruption and child_return is not None, raw=raw,
               started_wall=0, started=0, time=SimpleNamespace(monotonic=lambda: 1), manifest_hash='stub',
               run_metadata={}, subreaper=child_return is not None, reaped_descendants=[],
               out=SimpleNamespace(iterdir=lambda: []), digest=lambda path: None, json=json)
    success = eval(success_expr, env)
    env['success'] = success
    env['final_exit'] = 0 if success else 1
    result = eval(result_expr, env)
    stdout = json.loads(eval(print_expr, env))
    for receipt in (result, stdout):
        assert receipt['actualProcessExit'] == child_return
        assert receipt['runnerOutcomeCode'] == runner
        assert receipt['actualExit'] == expected_exit
    rows.append({'case': label, 'runnerOutcomeCode': runner, 'actualProcessExit': child_return, 'actualExit': expected_exit})
report = {'actualExit': 0, 'method': 'pure AST expression evaluation with inert child stubs',
          'successASTUnchanged': True, 'cases': rows, 'NodeStarts': 0, 'workerdStarts': 0}
(review / 'exit-fields-check.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
