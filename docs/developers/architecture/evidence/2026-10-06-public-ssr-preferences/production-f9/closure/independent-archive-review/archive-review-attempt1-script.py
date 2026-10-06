import datetime
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import zipfile
import zlib

F = Path(__file__).parent
P = Path('C:/Users/cina/AppData/Local/Temp/cinatoken-public-preferences-6e3e9f61c91546db9fc1c9886740fed4')
REPO = Path('C:/cinagroup/cinatoken')
A = REPO / 'docs/developers/architecture/evidence/2026-10-06-public-ssr-preferences/production-f9'
REPORT = F / 'archive-final-roundtrip-review.json'
COMMIT = 'f9b9140f7fdc35b4bddcd27e13df14cb2e444a34'
INDEX_SHA = 'b8649463f6bb12e1083d3cb80ac8bac83a5bc2de2208bae04a5145d25f920988'
ZIP_SHA = '9262b469b0f1160a27d00f3e352f2a023b5804e0a29a39aba0d60cdf06b16e6f'
START = datetime.datetime.now(datetime.timezone.utc).isoformat()

def sha(data):
    return hashlib.sha256(data).hexdigest()

def check(condition, name):
    if not condition:
        raise AssertionError(name)

def regular(file):
    check(file.is_file() and not file.is_symlink(), 'Regular source: ' + str(file))
    return file.read_bytes()

def parse(data):
    return json.loads(data)

def normalized(file):
    return str(file.resolve()).replace('\\', '/').casefold()

index_bytes = regular(A / 'index.json')
zip_bytes = regular(A / 'raw-evidence.zip')
check(len(index_bytes) == 805993 and sha(index_bytes) == INDEX_SHA, 'Pinned index identity')
check(len(zip_bytes) == 35638466 and sha(zip_bytes) == ZIP_SHA, 'Pinned ZIP identity')
index = parse(index_bytes)
records = index['files']
check(index['sourceCommit'] == COMMIT, 'Source commit')
check(len(records) == 1614 and len({r['path'] for r in records}) == 1614, '1614 unique logical mappings')
check(len({normalized(Path(r['original'])) for r in records}) == 1614, '1614 unique originals')
check(sum(r['bytes'] for r in records) == 94355288, 'Original byte sum')
by_path = {r['path']: r for r in records}
payloads = {}
member_proofs = []
with zipfile.ZipFile(A / 'raw-evidence.zip') as archive:
    infos = archive.infolist()
    check(len(infos) == 1195 and len({i.filename for i in infos}) == 1195, '1195 unique ZIP members')
    check(set(i.filename for i in infos) == set(r['member'] for r in records), 'No missing or extra ZIP member')
    for info in infos:
        check(re.fullmatch(r'sha256/[0-9a-f]{64}', info.filename) is not None, 'Content-addressed safe ZIP path')
        check(not info.is_dir() and not info.flag_bits & 1, 'Unencrypted regular ZIP member')
        data = archive.read(info.filename)
        digest = sha(data)
        crc = zlib.crc32(data) & 0xffffffff
        check(digest == info.filename.split('/')[1], 'Member SHA equals address')
        check(len(data) == info.file_size and crc == info.CRC, 'Member exact length and CRC')
        payloads[info.filename] = data
        member_proofs.append({'member': info.filename, 'bytes': len(data), 'sha256': digest, 'crc32': f'{crc:08x}', 'passed': True})

mtime_matches = 0
for row in records:
    parts = PurePosixPath(row['path']).parts
    check(parts and not PurePosixPath(row['path']).is_absolute() and '..' not in parts, 'Safe logical mapping')
    check(row['member'] == 'sha256/' + row['sha256'], 'Mapping content address')
    data = payloads[row['member']]
    check(len(data) == row['bytes'] and sha(data) == row['sha256'], 'Mapping member bytes/SHA')
    source = Path(row['original'])
    check(regular(source) == data, 'Original byte-equal to decompressed member: ' + row['path'])
    mtime_matches += source.stat().st_mtime_ns == row['mtimeNs']
check(mtime_matches == 1614, 'Original exact collection mtimes remain unchanged')

# Reconstruct the archive builder's exact declared roots, while explicitly leaving
# files created after its as-at inventory outside this frozen collection.
SCOPE = Path('C:/Users/cina/AppData/Local/Temp/cinatoken-public-preferences-md-scope-79204d34279045ad83a65f36ab1e0bab')
roots = [('root', P), ('fixture-and-independent-review', F), ('scope-review', SCOPE)]
root_dirs = {
    'browser-v2-runner': 'cinatoken-public-early-controls-browser-v2-c4d921d24edb4ce281eaa19d5ba7cf87',
    'browser-v3-runner': 'cinatoken-public-early-controls-browser-v3-d87161eb51c74dc29b0f2be294908b24',
    'browser-v4-runner': 'cinatoken-public-early-controls-browser-v4-50c8f957d37548d4a017908c81f8a17b',
    'http-v1-runner': 'cinatoken-public-live-http-verifier-9406634467954d769ef38bdc9a2e80ba',
    'http-v2-runner': 'cinatoken-public-live-http-verifier-v2-bd8c394b6a6b4cfbb9e1e562fa885436',
    'source-download-runner': 'cinatoken-source-download-verifier-70afb49c4efd44c78319d56f5344c2d3',
    'offline-asset-byteproof-runner': 'cinatoken-offline-composite-byteproof-0b8a3614f07b4b1aae293d409b8203e2',
    'csp-cause-diagnostic': 'cinatoken-public-preferences-eval-diagnostic-ea849e9a904a4a01b7a2122c38de7335',
    'old-loader-after-commit-diagnostic': 'cinatoken-public-preferences-dynamic-network-a5486b6e68384135b9b72c670f955cf6',
    'old-loader-before-commit-negative': 'cinatoken-public-preferences-dynamic-network-before-commit-22ff0060a1e64ce28511f2fa9cac278e',
}
roots += [(label, P.parent / directory) for label, directory in root_dirs.items()]
excluded = {'root/archive-final-production.result.json', 'root/archive-final-production.stderr.log', 'root/archive-final-production.stdout.log'}
check(set(e['path'] for e in index['exclusions']) == excluded, 'Exact three in-flight exclusions')
check(not excluded.intersection(by_path), 'In-flight receipt paths excluded from main ZIP mapping')
collection_dt = datetime.datetime.fromisoformat(index['at'])
epoch = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
elapsed = collection_dt - epoch
cutoff_ns = (elapsed.days * 86400 + elapsed.seconds) * 1000000000 + elapsed.microseconds * 1000
post_collection = []
expected_paths = set()
for label, directory in roots:
    check(directory.is_dir(), 'Inventory root exists')
    for file in directory.rglob('*'):
        check(not file.is_symlink(), 'No symlink in declared root')
        if not file.is_file():
            continue
        logical = label + '/' + file.relative_to(directory).as_posix()
        if logical in excluded:
            continue
        if logical not in by_path and file.stat().st_mtime_ns > cutoff_ns:
            post_collection.append(logical)
            continue
        expected_paths.add(logical)
        check(logical in by_path and normalized(file) == normalized(Path(by_path[logical]['original'])), 'Complete declared root mapping: ' + logical)
for label, release in [('linux-f9', COMMIT), ('previous-2e', 'web-2e40b9212b24-20261006-retained'), ('retirement-bridge', 'web-2e-retirement-20261006-f9b9140f'), ('activated-f9', 'web-f9b9140f7fdc-20261006-retained')]:
    for relative in ['manifest.json', 'assets/build-contract.json', 'assets/sources/index.json', 'assets/sources/index.html']:
        logical = 'release-contracts/' + label + '/' + relative
        expected_paths.add(logical)
        expected = REPO / '.release/web' / release / relative
        check(logical in by_path and normalized(expected) == normalized(Path(by_path[logical]['original'])), 'Exact release-contract mapping')
check(expected_paths == set(by_path), 'Complete as-at inventory: no extra/missing mapping')

def saved(logical):
    check(logical in by_path, 'Required evidence archived: ' + logical)
    return parse(payloads[by_path[logical]['member']])

copy_sources = {
    'browser-production-report.json': 'root/browser-production-f9-v4/report.json',
    'http-matrix-report.json': 'root/live-http-production-f9-v2/http/report.json',
    'source-download-report.json': 'root/source-download-production-f9/report.json',
    'asset-coverage-report.json': 'root/asset-coverage-production-f9/report.json',
    'deployment-guard.json': 'root/post-acceptance-f9-guard.deployment-guard.json',
    'independent-production-review.json': 'fixture-and-independent-review/FINAL-production-f9-acceptance-reviewed.json',
    'checklist-scope-report.json': 'scope-review/final-md.report.json',
}
plain_proofs = []
plain_before = {}
for name, logical in copy_sources.items():
    data = regular(A / name)
    check(data == payloads[by_path[logical]['member']], 'Plain authoritative report exact copy: ' + name)
    plain_before[name] = data
    plain_proofs.append({'path': name, 'archivedOriginal': logical, 'bytes': len(data), 'sha256': sha(data), 'byteEqualToOriginalAndZip': True})
derived = regular(A / 'archive-verification.json')
check(derived == regular(P / 'final-archive-verification.json'), 'Eighth plain derived report exact copy')
derived_report = parse(derived)
check(derived_report['intendedArchiveVerificationExit'] == 0, 'Derived intended value retained')
check(derived_report['indexBytes'] == len(index_bytes) and derived_report['indexSha256'] == INDEX_SHA and derived_report['bundleBytes'] == len(zip_bytes) and derived_report['bundleSha256'] == ZIP_SHA, 'Derived receipt exact archive identities')
plain_before['archive-verification.json'] = derived
plain_proofs.append({'path': 'archive-verification.json', 'original': str(P / 'final-archive-verification.json'), 'bytes': len(derived), 'sha256': sha(derived), 'byteEqualToOriginal': True, 'derivedIntendedExitIsNotActualChildExitProof': True})

closure_index_bytes = regular(A / 'closure/index.json')
closure = parse(closure_index_bytes)
check(closure['actualArchiveChildExit'] == 0 and closure['actualArchiveChildSignal'] is None, 'Closure actual child exit0')
check(len(closure['files']) == 4 and len({r['path'] for r in closure['files']}) == 4, 'Four unique closure copies')
closure_proofs = []
closure_before = {}
for row in closure['files']:
    file = A / 'closure' / row['path']
    check(PurePosixPath(row['path']).name == row['path'], 'Flat safe closure path')
    data = regular(file)
    check(data == regular(Path(row['original'])) and len(data) == row['bytes'] and sha(data) == row['sha256'], 'Closure original exact bytes/SHA')
    closure_before[row['path']] = data
    closure_proofs.append({'path': row['path'], 'bytes': len(data), 'sha256': sha(data), 'originalByteEqual': True})
archive_close = parse(closure_before['archive-process.result.json'])
check(archive_close['actualExit'] == 0 and archive_close['signal'] is None and archive_close['spawnError'] is None, 'Actual closed archive result')
check(datetime.datetime.fromisoformat(archive_close['finishedAt'].replace('Z', '+00:00')) > collection_dt, 'Actual close follows as-at collection')
for label in ['stdout', 'stderr']:
    receipt = archive_close[label]
    data = closure_before['archive-process.' + label + '.log']
    check(len(data) == receipt['bytes'] and sha(data) == receipt['sha256'] and data == regular(Path(receipt['path'])), 'Actual close log exact bytes/SHA')
check(parse(closure_before['archive-process.stdout.log']) == derived_report, 'Actual stdout contains exact derived archive receipt')

original_failures = []
for folder, passed in [('live-http-production-f9-network', 167), ('live-http-production-f9-v2', 175)]:
    report = saved('root/' + folder + '/http/report.json')
    closed = saved('root/' + folder + '/process-closed.json')
    check(closed['actualExitCode'] == 1 and report['summary']['planned'] == 177 and report['summary']['attempted'] == 177 and report['summary']['passed'] == passed, 'Original real HTTP actual failure preserved')
    check(report['summary']['failed'] == 177 - passed and report['intendedExitCode'] == 1, 'Original HTTP failure totals')
    original_failures.append({'scope': folder, 'actualExitCode': 1, 'attempted': 177, 'passed': passed, 'failed': 177 - passed})
source = saved('root/source-download-production-f9/report.json')
source_close = saved('root/source-download-production-f9/process-closed.json')
check(source_close['actualExitCode'] == 1 and source['outcome'] == 'FAIL', 'Separate 60-second actual failure preserved')
check(source['summary']['passedSourceDownloads'] == 3 and source['summary']['failedSourceDownloads'] == 2 and source['summary']['compositeOutcome'] == 'FAIL', 'Source 3/5 composite FAIL preserved')
check(source['priorThirtySecondPerformancePassed'] is False and source['single177RunPassed'] is False, 'Source report does not claim performance pass')
source_rows = []
for row in source['rows']:
    check(row['deadlineMs'] == 60000 and row['attempts'] == 1 and row['networkAttempted'] is True, 'Original source fixed single60s')
    data = regular(Path(row['rawBodyFile']))
    matching = [r for r in records if normalized(Path(r['original'])) == normalized(Path(row['rawBodyFile']))]
    check(len(matching) == 1 and data == payloads[matching[0]['member']], 'Original full or partial source rawbody archived')
    if row['outcome'] == 'FAIL':
        check(row['savedBodyKind'] == 'partial' and row['byteContractPassed'] is False, 'Failed source partial retained without PASS')
    source_rows.append({'path': row['path'], 'outcome': row['outcome'], 'elapsedMs': row['elapsedMs'], 'bodyBytes': len(data), 'bodySha256': sha(data), 'savedBodyKind': row['savedBodyKind']})
original_failures.append({'scope': 'source-download-production-f9', 'actualExitCode': 1, 'attempted': 5, 'passed': 3, 'failed': 2, 'compositeOutcome': 'FAIL'})

negative_paths = [
    'root/browser-production-f9/report.json', 'root/browser-production-f9.result.json',
    'root/browser-production-f9-v3/report.json', 'root/browser-production-f9-v3.result.json',
    'root/browser-production-f9-v3-network/report.json', 'root/browser-production-f9-v3-network.result.json',
    'root/live-http-production-f9/http/report.json', 'root/live-http-production-f9/process-closed.json',
    'fixture-and-independent-review/FINAL-production-pre-final-failures-reviewed.json',
    'fixture-and-independent-review/FINAL-production-f9-first-run-evidence-gap.json',
]
for logical in negative_paths:
    saved(logical)
for logical in negative_paths:
    if logical.endswith('.result.json'):
        check(saved(logical)['actualExit'] == 1, 'Original browser actual1 negative preserved')
check(saved('root/live-http-production-f9/process-closed.json')['actualExitCode'] == 1, 'Sandbox HTTP actual1 preserved')
check(saved('root/browser-production-f9-v3/report.json')['summary']['attempted'] == 0, 'Sandbox browser zero-attempt distinction retained')

browser = saved(copy_sources['browser-production-report.json'])
browser_close = saved('root/browser-production-f9-v4.result.json')
check(browser['summary']['passed'] == 13 and browser['summary']['failed'] == 0 and browser['outcome'] == 'PASS', 'Final browser13/13')
check(browser_close['actualExit'] == 0 and browser_close['signal'] is None and browser['browserClosed'] is True, 'Browser actual0 and closed')
check(len(browser['cases']) == 13 and all(c['contextClosed'] and c['outcome'] == 'PASS' and not c['policyViolations'] and not c['pageErrors'] and not c['evidenceErrors'] for c in browser['cases']), 'Browser retained strict results/context cleanup')
coverage = saved(copy_sources['asset-coverage-report.json'])
coverage_close = saved('root/asset-coverage-production-f9.result.json')
check(coverage_close['actualExit'] == 0 and coverage['outcome'] == 'PASS', 'Offline byte proof actual0')
check(coverage['uniqueAssetCoverage'] == 158 and coverage['overlapAssetCount'] == 154 and coverage['summary']['originalRunsActualExitCodes'] == [1, 1], 'Composite complete bytes preserves source run actual1')
check(coverage['claims']['networkRequestsMade'] == 0 and coverage['claims']['compositeByteCoverageOnly'] is True and coverage['claims']['single177RunPassed'] is False and coverage['claims']['thirtySecondPerformancePassed'] is False and coverage['claims']['fiveSequentialSixtySecondDownloadsPassed'] is False, 'Composite not performance or single-run green')
independent = saved(copy_sources['independent-production-review.json'])
check(sha(plain_before['independent-production-review.json']) == '3f83a0701d5b0a4348b63972ed5743ec1d8c5588c4ef61e03fb3703f88aa2bcb', 'Pinned independent final report identity')
check(independent['status'] == 'REVIEW_COMPLETE_WITH_PERFORMANCE_GATE_PENDING' and independent['performanceGatePending'] is True, 'Final performance pending preserved')
proof = saved('fixture-and-independent-review/f9-linux-proof-run/FINAL-linux-source-git-blobs.json')
check(proof['status'] == 'PASS' and proof['requestedCommit'] == COMMIT and proof['resolvedCommit'] == COMMIT, 'Exact Linux source Git proof retained')
check(proof['archiveFileCount'] == 2297 and proof['declaredPolicySelectedGitFiles'] == 2297 and proof['allExactGitBlobBytes'] is True and not proof['mismatches'], 'Complete2297 exact Git blobs retained')
guard = saved(copy_sources['deployment-guard.json'])
check(guard['actualExit'] == 0 and guard['deployment']['commitTag'] == COMMIT and guard['deployment']['id'] == 'b1fc86e3-a392-488c-9eca-6b5a99f8c713', 'Exact deployed f9 guard retained')
check(guard['deployment']['versions'] == [{'version_id': '218e2b8c-6153-4163-8b9f-cffc34445e27', 'percentage': 100}], 'Exact production100 percent version')
check(index['httpV2']['actualExit'] == 1 and index['sourceDownloads']['actualExit'] == 1 and index['assetCoverage']['actualExit'] == 0, 'Top index honest distinct scopes')
check('FAIL' in index['httpV2']['scope'] and 'FAIL' in index['sourceDownloads']['scope'] and 'not performance' in index['assetCoverage']['scope'], 'Top index failures/representation scope explicit')
readme_before = regular(A / 'README.md')
readme = readme_before.decode('utf-8')
check('175/177' in readme and '167/177' in readme and '3/5' in readme and '158' in readme and '154' in readme, 'README original scoped counts explicit')
source_proofs = []
check(len(index['source']) == 7, 'Seven current source-file hash inventory entries')
for row in index['source']:
    data = regular(REPO / row['path'])
    check(len(data) == row['bytes'] and sha(data) == row['sha256'], 'Current source hash inventory matches; separate from Git proof')
    source_proofs.append({**row, 'passed': True, 'scope': 'current seven workspace file bytes only; exact Linux 2297 Git-blob proof reviewed separately'})

# A second full source read closes the collection-to-verification race for indexed
# originals; later files are explicitly outside the historical as-at inventory.
for row in records:
    check(regular(Path(row['original'])) == payloads[row['member']], 'Original unchanged after verification: ' + row['path'])
check(regular(A / 'index.json') == index_bytes and regular(A / 'raw-evidence.zip') == zip_bytes, 'Pinned main archive unchanged after read')
check(regular(A / 'closure/index.json') == closure_index_bytes, 'Closure index unchanged after read')
for name, data in plain_before.items():
    check(regular(A / name) == data, 'All eight plain reports unchanged')
for name, data in closure_before.items():
    check(regular(A / 'closure' / name) == data, 'All four closure files unchanged')
check(regular(A / 'README.md') == readme_before, 'README unchanged')

report = {
    'status': 'PASS_ARCHIVE_ROUNDTRIP_ONLY_WITH_PERFORMANCE_GATE_PENDING',
    'startedAt': START, 'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'readOnlyOriginals': True, 'productionRequestsMade': 0, 'repoWritesMade': 0,
    'requestedCommit': COMMIT, 'reviewerScriptSha256': sha(Path(__file__).read_bytes()),
    'archive': {'path': str(A), 'collectionAsAt': index['at'], 'indexBytes': len(index_bytes), 'indexSha256': INDEX_SHA, 'zipBytes': len(zip_bytes), 'zipSha256': ZIP_SHA, 'originalFiles': len(records), 'uniqueZipMembers': len(member_proofs), 'originalBytes': sum(r['bytes'] for r in records), 'everyMappingOriginalByteEqualToZip': True, 'everyMemberExactSizeShaAndCrc32': True, 'allOriginalCollectionMtimesUnchanged': True, 'allOriginalBytesFreshlyReadTwice': True, 'allArchiveInputsUnchangedAfterReview': True, 'declaredRootInventoryCompleteAsAt': True},
    'memberProofs': member_proofs,
    'plainReports': {'authoritativeOriginalExactCopies': 7, 'derivedArchiveReceiptExactCopy': 1, 'totalPlainReportsVerified': 8, 'proofs': plain_proofs},
    'closure': {'actualArchiveChildExit': archive_close['actualExit'], 'signal': archive_close['signal'], 'spawnError': archive_close['spawnError'], 'finishedAt': archive_close['finishedAt'], 'actualReceiptSha256': sha(closure_before['archive-process.result.json']), 'indexSha256': sha(closure_index_bytes), 'derivedIntendedExitUsedAsActualProof': False, 'threeInflightMainExclusions': sorted(excluded), 'originalExactCopies': closure_proofs},
    'productionScopes': {'browser': '13/13 actual closed0; original strict case results retained, all contexts/browser closed', 'originalFailures': original_failures, 'sourceDownloadBodies': source_rows, 'offlineComposite': {'actualExit': 0, 'uniqueExactAssets': 158, 'overlaps': 154, 'networkRequestsMade': 0, 'originalHTTPActualExits': [1, 1], 'single177GreenClaim': False, 'thirtySecondPerformancePass': False, 'sixtySecondAllFivePass': False}, 'performanceGatePending': True, 'performanceRootCause': 'UNKNOWN', 'negativeEvidencePathsPreserved': negative_paths},
    'sourceScopes': {'linuxExactSourceGitBlobProof': {'status': proof['status'], 'commit': COMMIT, 'selectedGitFiles': 2297, 'archiveFiles': 2297, 'allExactGitBlobBytes': True, 'archivedReportSha256': by_path['fixture-and-independent-review/f9-linux-proof-run/FINAL-linux-source-git-blobs.json']['sha256']}, 'currentSevenFileInventory': source_proofs},
    'postCollectionFilesOutsideSnapshot': sorted(post_collection),
    'findings': [], 'p1': 0, 'p2': 0,
    'limitations': ['This exit0 certifies the archive mapping and exact roundtrip only; original live HTTP and sequential source-download runs remain actual1.', 'All member CRC/SHA/raw-byte proofs and copied reports were read without extraction, network, production action, or source/Git modification.', 'The historical snapshot is as-at collection; separately indexed closure files follow actual close. Later Temp files are outside that snapshot.', 'No new BFCache, authenticated workspace/key, private API, full legacy business, licensing, or unresolved performance claim is made.', 'Current seven workspace source hashes are a separate limited inventory; exact Linux source linkage uses the retained 2297-file Git-blob proof.']
}
data = (json.dumps(report, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
with REPORT.open('xb') as file:
    file.write(data)
print(json.dumps({'reportPath': str(REPORT), 'bytes': len(data), 'sha256': sha(data), 'originalFiles': 1614, 'zipMembers': 1195, 'plainReports': 8, 'actualArchiveChildExit': 0, 'performanceGatePending': True}, ensure_ascii=False))
