import hashlib
import json
from pathlib import Path
import subprocess

review = Path(__file__).resolve().parent
repo = Path('C:/cinagroup/cinatoken')
package = repo / 'scripts/diagnostics/v364-owned-linux'
sha = lambda data: hashlib.sha256(data).hexdigest()
receipt = lambda path: {'path': str(path), 'bytes': len(path.read_bytes()), 'sha256': sha(path.read_bytes())}
allowed = ['scripts/diagnostics/v364-owned-linux/execute-owned-linux.py',
           'scripts/diagnostics/v364-owned-linux/README.md', 'scripts/diagnostics/v364-owned-linux/sealed-package.json']
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
assert head == '4d645f954ea76d8546409aaa6b684a8279c0deb9'
old_manifest = (review / 'before-sealed-package.json').read_bytes()
assert sha(old_manifest) == 'cc8346861d175eeb2458a1765ba3c22768d0cb8dc9eee17f702faa868e6e7d92'
assert old_manifest == subprocess.check_output(['git', 'show', 'HEAD:' + allowed[2]], cwd=repo)
manifest = json.loads(old_manifest)
for name in ['execute-owned-linux.py', 'README.md']:
    path = package / name
    data = path.read_bytes().replace(b'\r\n', b'\n')
    assert not data.startswith(b'\xef\xbb\xbf')
    path.write_bytes(data)
for item in manifest['files']:
    data = (package / item['path']).read_bytes()
    assert b'\r' not in data
    item['bytes'] = len(data)
    item['sha256'] = sha(data)
(package / 'sealed-package.json').write_bytes((json.dumps(manifest, indent=2) + '\n').encode())
frozen = json.loads((package / 'source-inputs.json').read_bytes())
for item in frozen:
    data = (repo / item['path']).read_bytes()
    assert len(data) == item['bytes'] and sha(data) == item['sha256']
    assert data == subprocess.check_output(['git', 'show', 'HEAD:' + item['path']], cwd=repo)
for path in ['scripts/diagnostics/v364-owned-linux/run-v364-owned-diagnostic.mjs',
             'scripts/diagnostics/v364-owned-linux/gateway-observer.mjs',
             'scripts/diagnostics/v364-owned-linux/holder-observer.mjs',
             'scripts/diagnostics/v364-owned-linux/source-inputs.json',
             '.github/workflows/v364-owned-linux-diagnostic.yml']:
    assert (repo / path).read_bytes() == subprocess.check_output(['git', 'show', 'HEAD:' + path], cwd=repo)
git_proof = []
for path in allowed:
    data = (repo / path).read_bytes()
    assert b'\r' not in data
    raw = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
    clean = subprocess.check_output(['git', 'hash-object', '--path', path, path], cwd=repo, text=True).strip()
    assert raw == clean
    git_proof.append({**receipt(repo / path), 'LF': True, 'GitCleanFilterPreservesBytes': True, 'gitBlobSHA': raw})
changes = subprocess.check_output(['git', 'diff', '--name-only'], cwd=repo, text=True).splitlines()
assert sorted(changes) == sorted(allowed), changes
diff = subprocess.check_output(['git', 'diff', '--'] + allowed, cwd=repo)
(review / 'only-three-final.diff').write_bytes(diff)
subprocess.run(['git', 'diff', '--check', '--'] + allowed, cwd=repo, check=True)
check = json.loads((review / 'exit-fields-check.json').read_bytes())
assert check['actualExit'] == 0 and check['successASTUnchanged']
report = {'schema': 'v364-exit-receipt-minimal-fix-closed-v1', 'actualExit': 0,
          'headPreserved': head, 'changedFiles': allowed, 'files': git_proof,
          'previousCommittedSeal': receipt(review / 'before-sealed-package.json'),
          'newPortableSeal': receipt(package / 'sealed-package.json'),
          'checks': check, 'frozen10WorktreeAndGitUnchanged': True, 'mainObserversSourceInputsWorkflowGitUnchanged': True,
          'manifestItemsVerified': len(manifest['files']), 'scopeExact3': True,
          'actualProcessExitMeaning': 'real child.returncode after wait; None before child startup',
          'runnerOutcomeCodeMeaning': 'original normal/timeout/interruption runner outcome code, including 124/130',
          'successConditionsUnchanged': True, 'nativeStarts': 0, 'CIInvocations': 0, 'productionRequests': 0,
          'commits': 0, 'LinuxForcedLifecycleNotExecuted': True}
body = (json.dumps(report, indent=2) + '\n').encode()
(review / 'FINAL-v364-exit-receipt-fix.json').write_bytes(body)
(review / 'FINAL-v364-exit-receipt-fix.sha256').write_text(sha(body) + '\n')
print(json.dumps({'actualExit': 0, 'report': str(review / 'FINAL-v364-exit-receipt-fix.json'),
                  'bytes': len(body), 'sha256': sha(body), 'manifestSHA': report['newPortableSeal']['sha256'],
                  'changedFiles': len(allowed)}))
