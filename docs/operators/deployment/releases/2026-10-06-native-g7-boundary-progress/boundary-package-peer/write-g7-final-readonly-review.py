import hashlib
import json
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
repo = Path('C:/cinagroup/cinatoken')
owner_dir = Path('C:/Users/cina/AppData/Local/Temp/cinatoken-g7-tls-pg-package-20261006-552eab3dd02f4b15a01d765d9a2aab8f')
owner_path = owner_dir / 'FINAL-local-package-checks.json'
digest = lambda b: hashlib.sha256(b).hexdigest()
owner_raw = owner_path.read_bytes()
owner_report = json.loads(owner_raw)
assert digest(owner_raw) == '404f1d8b571ca89253b55af46a55aebdcd0e631f02941b6b8e926982463905c8'
assert owner_report['actualExit'] == 0
assert owner_report['ownedNewFileCount'] == 10
for key in ['realLinuxDockerExecuted', 'actualTLSExecuted', 'nativeDatabaseExecuted', 'formalG7Complete', 'formalG8Complete']:
    assert owner_report[key] is False
assert owner_report['productionRequests'] == 0

sources = []
texts = {}
for entry in owner_report['files']:
    path = entry['path']
    assert path.startswith('scripts/verification/web-platform-g7/') or path == '.github/workflows/web-platform-g7.yml'
    raw = (repo / path).read_bytes()
    snapshot = (owner_dir / 'final-source' / path).read_bytes()
    assert raw == snapshot
    assert len(raw) == entry['bytes'] and digest(raw) == entry['sha256']
    texts[path] = raw.decode('utf-8')
    sources.append({**entry, 'matchesFrozenSnapshot': True, 'matchesOwnerManifest': True, 'carriageReturns': raw.count(b'\r')})
assert len(sources) == 10 and len({x['path'] for x in sources}) == 10
actual_paths = {str(p.relative_to(repo)).replace('\\', '/') for p in (repo / 'scripts/verification/web-platform-g7').iterdir() if p.is_file()}
actual_paths.add('.github/workflows/web-platform-g7.yml')
assert actual_paths == {x['path'] for x in sources}
snapshot_paths = {str(p.relative_to(owner_dir / 'final-source')).replace('\\', '/') for p in (owner_dir / 'final-source').rglob('*') if p.is_file()}
assert snapshot_paths == actual_paths

receipts = []
for receipt in owner_report['receipts']:
    receipt_path = owner_dir / f"final-{receipt['id']}.result.json"
    receipt_raw = receipt_path.read_bytes()
    assert json.loads(receipt_raw) == receipt
    assert receipt['closed'] is True and receipt['signal'] is None and receipt['errorCode'] is None
    expected = 128 if receipt['id'].startswith('base-absent-') else 1 if receipt['id'] == 'windows-admission' else 0
    assert receipt['actualExit'] == expected
    streams = []
    for stream in ['stdout', 'stderr']:
        metadata = receipt[stream]
        data = (owner_dir / metadata['file']).read_bytes()
        assert len(data) == metadata['bytes'] and digest(data) == metadata['sha256']
        streams.append({'stream': stream, **metadata, 'matchesRaw': True})
    receipts.append({'id': receipt['id'], 'path': str(receipt_path), 'bytes': len(receipt_raw), 'sha256': digest(receipt_raw), 'closed': True, 'actualExit': receipt['actualExit'], 'expectedExit': expected, 'streams': streams})
assert len(receipts) == 21
unit = (owner_dir / 'final-unit.stdout.log').read_text(encoding='utf-8')
for marker in ['tests 6', 'pass 6', 'fail 0', 'skipped 0']:
    assert marker in unit
assert not (owner_dir / 'never-created-final-runtime').exists()
historical_path = owner_dir / 'format-before.result.json'
historical_raw = historical_path.read_bytes()
historical = json.loads(historical_raw)
assert historical['closed'] is True and historical['actualExit'] != 0

def evidence(path, needle):
    lines = texts[path].splitlines()
    matching = [i + 1 for i, line in enumerate(lines) if needle in line]
    assert matching, (path, needle)
    return {'path': path, 'line': matching[0], 'needle': needle}

runner = 'scripts/verification/web-platform-g7/run-owned-linux.mjs'
wire = 'scripts/verification/web-platform-g7/wire.mjs'
db = 'scripts/verification/web-platform-g7/database.mjs'
cleanup = 'scripts/verification/web-platform-g7/cleanup-owned-linux.mjs'
admission = 'scripts/verification/web-platform-g7/admission.mjs'
workflow = '.github/workflows/web-platform-g7.yml'
report = {
    'schema': 'web-platform-g7-final-package-peer-readonly-review-v1',
    'reviewedAt': datetime.now(timezone.utc).isoformat(),
    'reviewer': '/root/cloudflare_review/boundary_peer',
    'reviewScope': 'Only the new G7 harness and workflow were reviewed; existing core, Admin, Proxy, Web and Docker sources were read as contract references. No repository file was written.',
    'reviewActualExit': 0,
    'ownerPreparationReceipt': {'path': str(owner_path), 'bytes': len(owner_raw), 'sha256': digest(owner_raw), 'actualExit': 0, 'preparedAtHead': owner_report['preparedAtHead'], 'observedCurrentHead': owner_report['observedCurrentHead'], 'historicalHeadIsNotFutureWorkflowSHA': True},
    'sourceFiles': sources,
    'allTenRepoAndFrozenSourceByteComparisonsMatched': True,
    'ownerRawReceiptComparisons': receipts,
    'ownerLocalValidation': {'unitTests': 6, 'passed': 6, 'failed': 0, 'skipped': 0, 'syntaxFiles': 7, 'formatterActualExit': 0, 'expectedBaseAbsenceExit128Count': 10, 'expectedWindowsAdmissionExit': 1, 'WindowsRuntimeOutputNeverCreated': True, 'reviewerReranTests': False},
    'historicalFailurePreservation': {'declaredByOwner': owner_report['historicalFailuresPreserved'], 'formatBefore': {'path': str(historical_path), 'bytes': len(historical_raw), 'sha256': digest(historical_raw), 'actualExit': historical['actualExit'], 'closed': True}, 'originalCoreOperationAndExtractorFailuresRemainTranscriptEvidence': True, 'oldResultsWereNotOverwrittenByReviewer': True},
    'findingsResolvedByOwnerAndReadVerified': [
        {'finding': 'Runtime commands were not clamped to the remaining 720-second budget.', 'resolution': 'Main and fallback use the single-clock boundedCommandTimeout helper; positive integer remaining time is required, so zero timeout cannot disable the bound.', 'evidence': [evidence(admission, 'const remaining = deadline - now'), evidence(admission, 'remaining > 0'), evidence(runner, 'timeout = boundedCommandTimeout(deadline, timeout)'), evidence(cleanup, 'boundedCommandTimeout(deadline, 15_000)')]},
        {'finding': 'A log-capture failure skipped removal of an owned container.', 'resolution': 'Main log collection and owned removal have independent attempt loops; failures remain errors. Separate always-step fallback checks every registered object and final owner-label census.', 'evidence': [evidence(runner, 'for (const name of [...created.containers].reverse())'), evidence(cleanup, 'runtimePassedClaim: false'), evidence(workflow, 'Independently verify or recover owned resource cleanup')]},
        {'finding': 'Default TERM termination bypassed finally, then a handler alone deferred interrupted-state observation through synchronous work.', 'resolution': 'Signal listeners preserve interruption as failure, event-loop drains occur before main success and at both ends of finally, and independent cleanup runs separately. Rapid signal response and forced host/job termination closure were not executed or certified.', 'evidence': [evidence(runner, 'Interrupted runtime cannot pass'), evidence(runner, 'await new Promise((accept) => setImmediate(accept))'), evidence(runner, 'interruptedSignal,')]},
        {'finding': 'PG readiness retry mode tolerated unknown or timed-out process results.', 'resolution': 'Every spawn result requires integer status, null signal and no error; pg_isready permits only explicit 0/1/2 statuses. Expected nonzero readiness is retained distinctly.', 'evidence': [evidence(runner, 'Number.isInteger(result.status) && result.signal === null && !result.error'), evidence(runner, '[0, 1, 2].includes(result.status)'), evidence(runner, 'expectedNumericReadinessNonzero:')]},
        {'finding': 'The fixture test SQL extractor required formatter-sensitive contiguous method calls.', 'resolution': 'The extractor accepts whitespace around the actual seeder transaction chain; owner raw final unit receipt verifies all six tests passed.', 'evidence': [evidence('scripts/verification/web-platform-g7/fixture.test.mjs', 'source.matchAll')]},
        {'finding': 'Registration wire evidence omitted mode and zero-cookie assertions; invalid callback omitted no-store.', 'resolution': 'All nine original cases now enforce zero Set-Cookie; register requires mode=register and callback intent/path, and invalid callback requires no-store.', 'evidence': [evidence(wire, 'location.searchParams.get("mode")'), evidence(wire, 'noCookie(register)'), evidence(wire, 'noStore(invalid)')]},
        {'finding': 'DNS failure alone did not prove direct private-IP TCP isolation.', 'resolution': 'The harness now checks five inaccessible internal aliases and seven actual owner-inspected private IPv4 endpoints. The distinct error/timeout outcomes are retained.', 'evidence': [evidence(runner, 'assert.equal(privateEndpoints.length, 7)'), evidence(runner, 'assert.equal(isIP(connection.IPAddress), 4)'), evidence(wire, 'await rawPortNegative(endpoint.ip, endpoint.port)')]},
    ],
    'actualPGContractReadReview': {
        'mode': 'Source-only; no PostgreSQL process or query was executed by reviewer.',
        'migrationLedger': 'Image SQL filenames are sorted and compared exactly with qualified schema_migrations; migrator runs twice. Seed and Admin/Proxy read-only observations compare migration corpus and schema hashes.',
        'migrationReferences': ['packages/core/migrations-postgres/0016_route_surfaces_pools.sql', 'packages/core/migrations-postgres/0023_admin_access_identity.sql', 'packages/core/migrations-postgres/0027_user_portal_shared_keys.sql', 'packages/core/migrations-postgres/0046_model_endpoints.sql', 'packages/core/migrations-postgres/0047_model_endpoint_route_subject_fingerprint.sql', 'packages/core/migrations-postgres/0048_model_endpoint_audio_capabilities.sql'],
        'actualSeed': 'Six related rows: provider, model, route pool, model surface, model route, verified text endpoint; model_endpoint_routes adds the real subject fingerprint. Both operation values and parser admission use chat. Expiry is future, context/prompt/completion fit 8192, text pricing/capabilities are explicit.',
        'encryptionAndFingerprint': 'The stored provider key is enc:v2 and binds cinatoken:provider-key:g7-provider. Seed computes fingerprint using the decrypted credential. The real Proxy Node runtime wraps its providers repository with the same decryption before public endpoint subject comparison.',
        'contractReferences': [{'path': 'packages/core/src/lib/provider-key-encryption.ts', 'lines': [35, 36, 99, 113]}, {'path': 'packages/proxy/src/runtime/node.ts', 'lines': [32, 34, 42, 43]}, {'path': 'packages/proxy/src/services/public-model-endpoints.ts', 'lines': [331, 334, 363, 380, 420, 421]}, {'path': 'packages/core/src/storage/drizzle/client-postgres.ts', 'lines': [19, 53, 57, 63]}, {'path': 'packages/web/src/cinatoken/public/ssr/public-request-app.ts', 'lines': [150, 158, 168, 175, 193, 209]}],
        'limits': 'Controlled verified endpoint rows attest to local catalog contract only; no real provider validation. All processes use owned PG16 postgres superuser. Restricted ACL and native PG18 remain false.'
    },
    'TLSAndTopologyReadReview': {
        'entry': 'Fresh local CA and app.test SAN leaf; QA trusts only supplied CA, rejects unauthorized certificate, and keeps hostname checking enabled.',
        'canonicalHeaders': 'Ingress validates app.test SNI and Host (optional :443), returns 421 for unknown Host/missing SNI, overwrites Host/XFH/app.test and XFP/https, clears Forwarded, preserves browser Origin and cookies.',
        'ownedNetworks': 'client/app/db are internal bridge networks with no published ports. QA joins only client; ingress joins client+app; Web/SSR join app; Proxy/Admin join app+db; PG/migrator/seed join db.',
        'wireExtraNegatives': 'Untrusted CA, wrong SNI certificate hostname, missing SNI 421, five aliases and seven inspected private IPv4 ports are separate assertions.',
        'nineOriginalCases': [
            {'case': 'same HTTPS Origin', 'method': 'POST', 'path': '/api/auth/login', 'status': 410, 'setCookieCount': 0},
            {'case': 'spoofed forwarding overwritten', 'method': 'POST', 'path': '/api/auth/login', 'status': 410, 'setCookieCount': 0},
            {'case': 'ambiguous forwarding overwritten', 'method': 'POST', 'path': '/api/auth/login', 'status': 410, 'setCookieCount': 0},
            {'case': 'missing Origin', 'method': 'POST', 'path': '/api/auth/login', 'status': 403, 'setCookieCount': 0},
            {'case': 'cross Origin preserved', 'method': 'POST', 'path': '/api/auth/login', 'status': 403, 'setCookieCount': 0},
            {'case': 'explicit cross-site', 'method': 'POST', 'path': '/api/auth/login', 'status': 403, 'setCookieCount': 0},
            {'case': 'unknown Host', 'method': 'POST', 'path': '/api/auth/login', 'status': 421, 'setCookieCount': 0},
            {'case': 'registration redirect', 'method': 'GET', 'status': 302, 'location': 'https://app.test/api/auth/cinaauth/login with mode=register, intent=portal, callbackURL=/account/keys', 'noStore': True, 'setCookieCount': 0},
            {'case': 'invalid callback', 'method': 'GET', 'status': 302, 'locationOrigin': 'https://app.test', 'authError': 'invalid_transaction', 'noStore': True, 'setCookieCount': 0},
        ],
        'sourceEvidenceOnly': True,
    },
    'SSRAndResourceEvidenceBounds': {
        'SSRRequests': 64,
        'matrix': 'en/zh/ja/ko x home/models/detail/providers/compare/chat/rankings/benchmarks x GET/HEAD',
        'SSRAssertions': 'Status200, no-store, no-cookie, COOP same-origin, HEAD empty; GET checks locale, main h1, canonical app.test, five alternates, expected bootstrap records, nonce on each script and manifest-linked assets. Models/providers/detail nonempty; statistics may be empty without inference.',
        'resources': 'Each frozen manifest file GET has exact bytes and SHA256; HEAD has zero body. Count is 2 x manifest files. This does not prove ranges, conditional requests, retained/gray/rollback or authenticated behavior.',
        'countsNeedOverallZero': 'Rows count completed responses, not independent passes. Main first requires actual QA exit0 and matching wire.actualExit0 before accepting 64 and 2N counts.',
        'fullG7Verified': False,
        'fullG8Verified': False,
    },
    'cleanupAndSecretEvidenceBounds': {
        'mainRuntimeBudgetMs': 720000,
        'mainCleanupBudgetMs': 120000,
        'fallbackCleanupBudgetMs': 180000,
        'mainOuterTimeoutSeconds': 1020,
        'mainStepTimeoutMinutes': 18,
        'fallbackStepTimeoutMinutes': 4,
        'ownershipRegistry': 'Written before any Docker command; fixed exact sourceSHA, UUID owner, 9 names, 3 network names and volume. Both removal paths verify exact owner labels and retain errors.',
        'fallbackVerifiedAbsent': 'Success requires 13 explicit absence rows plus empty container/network/volume owner-label scans. Independent cleanup never rewrites or promotes the original runtime result.',
        'secrets': 'Main-generated seven random credentials are not command argument values, are placed in private env files outside output, and exact matches in captured main output are redacted. CA and leaf private keys are not uploaded. Fallback reads only exact-name listings and formatted Labels, never container Env or application logs.',
        'limits': 'Fast interrupt response, independent fallback runtime, Docker isolation and actual absence are still unexecuted. An always-step cannot attest to recovery after termination of the host/job itself.',
    },
    'primarySemanticsReferences': [
        'https://nodejs.org/download/release/latest-v22.x/docs/api/child_process.html#synchronous-process-creation',
        'https://nodejs.org/download/release/latest-v22.x/docs/api/process.html#signal-events',
        'https://www.postgresql.org/docs/16/app-pg-isready.html',
    ],
    'conclusion': {'remainingSourceBlockers': [], 'readyForAuthorizedOwnedLinuxAttempt': True, 'realLinuxDockerExecuted': False, 'actualTLSExecuted': False, 'nativeDatabaseExecuted': False, 'CIExecutedByReviewer': False, 'productionRequests': 0, 'G7OrG8PassClaim': False, 'repositoryWritesByReviewer': 0, 'reviewerRanHarnessOrTests': False},
}

for entry in sources:
    current = (repo / entry['path']).read_bytes()
    assert len(current) == entry['bytes'] and digest(current) == entry['sha256'], 'Source changed during final read review'
output_dir = Path('C:/Users/cina/AppData/Local/Temp') / ('FINAL-cinatoken-g7-peer-readonly-' + uuid.uuid4().hex)
output_dir.mkdir()
output_path = output_dir / 'FINAL-g7-package-peer-readonly-review.json'
output_raw = (json.dumps(report, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
with output_path.open('xb') as stream:
    stream.write(output_raw)
assert output_path.read_bytes() == output_raw
print(json.dumps({'path': str(output_path), 'bytes': len(output_raw), 'sha256': digest(output_raw), 'reviewActualExit': 0, 'allTenByteComparisonsMatched': True, 'ownerRawReceiptsMatched': len(receipts), 'runtimeExecutedByReviewer': False}, ensure_ascii=False))
