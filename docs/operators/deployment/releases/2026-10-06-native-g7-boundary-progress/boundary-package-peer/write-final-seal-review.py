import hashlib
import json
from pathlib import Path

here = Path(__file__).parent
repo = Path('C:/cinagroup/cinatoken')
pkg = repo / 'scripts/diagnostics/v364-owned-linux-boundary'
prep_path = Path('C:/Users/cina/AppData/Local/Temp/cinatoken-v364-boundary-preparation-1427c951d98b46c6ae8299694b679b38/FINAL-v364-boundary-portable-preparation.json')
def digest(path):
    data = path.read_bytes()
    return {'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
old_path = here / 'FINAL-new-boundary-implementation-readonly-review.json'
assert digest(old_path)['sha256'] == 'ec1b1d91ba031b6671a2d8e81fb6ad315187581d0a1160a28a124dcfc2ad9c6c'
old = json.loads(old_path.read_text(encoding='utf-8'))
manifest_path = pkg / 'sealed-package.json'
assert digest(manifest_path)['sha256'] == 'b99ede67c0e949fc6aee728f450d564d60c9eed14b60e542e3282e9a8d163af9'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
rows = []
for item in manifest['files'] + [manifest['workflow']]:
    path = repo / item['path'] if item is manifest['workflow'] else pkg / item['path']
    actual = digest(path)
    assert actual['bytes'] == item['bytes'] and actual['sha256'] == item['sha256']
    rows.append({'relativePath': item['path'], **actual, 'exact': True})
old_hashes = {item['relativePath']: item['sha256'] for item in old['sealedChecks']}
changed = [row['relativePath'] for row in rows if old_hashes[row['relativePath']] != row['sha256']]
assert changed == ['execute-owned-linux.py']
python_data = (pkg / 'execute-owned-linux.py').read_bytes()
assert b'\r' not in python_data
assert b"or type(raw.get('activeMiniflare')) is not int or raw['activeMiniflare'] < 0" in python_data
assert digest(prep_path)['bytes'] == 34463
assert digest(prep_path)['sha256'] == '6a871bc68a5611273d64d65d4ea9d6aee46d87f9c92bc427238604710e092f02'
prep = json.loads(prep_path.read_text(encoding='utf-8'))
assert prep['actualExit'] == 0 and prep['runtimeExecuted'] is False
report = {
    'schema': 'cinatoken.v364.boundary-final-reseal.independent-readonly-review.v1',
    'reviewActualExit': 0,
    'conclusion': 'FINAL_RESEALED_PACKAGE_EXACT_OPTIONAL_INTEGER_GUARD_VERIFIED',
    'earlierReviewPreserved': digest(old_path),
    'finalManifest': digest(manifest_path),
    'sealedChecks': rows,
    'changedSealedFileSinceEarlierReview': changed,
    'pythonLFOnly': True,
    'additionalGuard': "execute-owned-linux.py:296 now rejects bool, missing, non-int and negative activeMiniflare before closure evaluation. Genuine nonnegative int Map size remains valid; all actual exit/runner/status logic otherwise reviewed earlier.",
    'ownerPreparationReceipt': digest(prep_path),
    'preparationCommandReceiptsReadOnly': [{'id': item['id'], 'status': item['status'], 'expectedExit': item['expectedExit'], 'terminal': item['terminal']} for item in prep['commands']],
    'retainedNegativePreparationKeys': {key: prep[key] for key in ('historicalPreparationFailure', 'historicalAuditEntryFailure', 'historicalInertStubFailure', 'negativeWindowsReceipt', 'negativeIsLinuxClosureProof')},
    'limits': 'Only new final package bytes and owner preparation receipts read. Earlier report is unchanged. Preparation no-child Windows rejection and inert Linux constants branch checks are not actual Linux process cleanup proof. No runtime/test/preparation command rerun by this reviewer.',
    'repoWrites': 0, 'runtimeExecuted': False, 'ciRequests': 0, 'productionRequests': 0,
}
path = here / 'FINAL-new-boundary-final-reseal-readonly-review.json'
with path.open('x', encoding='utf-8', newline='\n') as file:
    file.write(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(digest(path)))
