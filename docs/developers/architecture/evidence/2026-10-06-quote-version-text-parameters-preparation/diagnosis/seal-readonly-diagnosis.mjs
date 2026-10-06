import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = 'C:/Users/cina/AppData/Local/Temp/cinatoken-quote-version-next-readonly-gn9DdD';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const descriptor = pathname => {
  const bytes = fs.readFileSync(pathname);
  return { path: pathname.replaceAll('\\', '/'), bytes: bytes.length, sha256: sha(bytes) };
};
const file = relative => descriptor(path.join(root, relative));
const json = relative => JSON.parse(fs.readFileSync(path.join(root, relative)));
const sources = json('static-source-chain-audit.json');
const scope = json('proposal-and-active-scope-audit.json');
const queries = json('three-original-query-AST-and-candidate-plan.json');
const closedCommands = ['static-source-chain', 'proposal-scope'].map(label => {
  const receipt = json(`${label}.result.json`);
  assert.equal(receipt.closed, true);
  assert.equal(receipt.actualExit, 0);
  assert.equal(receipt.signal, null);
  assert.equal(receipt.spawnError, null);
  assert.equal(receipt.timedOut, false);
  for (const stream of ['stdout', 'stderr']) {
    const observed = file(`${label}.${stream}.log`);
    assert.equal(observed.bytes, receipt[stream].bytes);
    assert.equal(observed.sha256, receipt[stream].sha256);
  }
  return { receipt: file(`${label}.result.json`), stdout: file(`${label}.stdout.log`), stderr: file(`${label}.stderr.log`), actualReadExit: receipt.actualExit };
});
for (const source of sources.sources) {
  assert.equal(descriptor(source.original.path).sha256, source.original.sha256);
  assert.equal(descriptor(source.snapshot.path).sha256, source.original.sha256);
}
const refs = (relative, lines, fact) => ({ repositoryRelative: relative, lines, fact });
const fixture = 'scripts/db/cutover/postgres-shared-key-quote-versions.native.test.mjs';
const proposal = 'packages/core/migrations-proposals/postgres/shared-key-quote-versions.sql';
const report = {
  schema: 'cinatoken-next-quote-version-499-readonly-candidate-diagnosis-v1',
  at: new Date().toISOString(), closed: true, actualReaderSealExit: 0,
  outputRoot: root, readAtHead: sources.inspectedAtHead,
  targetFailedSourceSHA: sources.targetSourceHead, historicalPassingSourceSHA: sources.historicalSourceHead,
  observedFailure: {
    originalProxyRun: 37416105484, originalNativeJob: 112114951257,
    actualRuntimeExit: 1, stage: 24, line: 499, column: 14, actual: 'quote-a-b1', expected: 'quote-a-b2',
    originalTAP: { tests: 1, pass: 0, fail: 1, cancelled: 0, skipped: 0, todo: 0 },
    authority: sources.runtimeFailureAuthority,
    lowerNativeStepsNotReached: 'Original ee122 financial fixture steps25–113 were skipped after step24. Prepared changed targets55–113 were not runtime validated.',
    oldDcc6PassedSameFixture: 'Historical outcome supplied by parent; current inspection independently verifies ee122/dcc6 fixture and proposal bytes, not a new replay of either outcome.',
  },
  pinnedFixture: sources.sources[0], fixtureGitBlobBothHeads: sources.fixtureGitBlobBothHeads,
  pinnedProposal: scope.proposalSource, proposalGitBlobBothHeads: scope.proposalBothHeadsGitBlob,
  sources: sources.sources, sourceAfterExact: true,
  sourceAudit: file('static-source-chain-audit.json'), scopeAudit: file('proposal-and-active-scope-audit.json'),
  exactOriginalThreeQueryBytesAndAST: file('three-original-query-AST-and-candidate-plan.json'),
  originalFixtureAssertionsRecorded: sources.originalAssertionCount,
  installedDriver: sources.installedDriver,
  establishedStaticFacts: [
    refs(fixture, [22, 26, 105, 119], 'Both migrator and competing clients are independent max1 direct migrator LOGIN connections; prepare:false/fetch_types:false. Runtime/proxy roles are separate. No ambient database URL is used.'),
    refs(fixture, [122, 135, 240], 'The owned PG18.6 fixture applies73 formal migrations and activates the source proposal SQL, whose test/proposal/corpus SHA values are prepared for its report.'),
    refs(proposal, [1, 6, 170, 183, 274, 284], 'Quote contract is an explicitly review-only proposal in a separate economic schema. Insert/transition enforce direct migrator LOGIN and READ COMMITTED; it is not an active production quote producer.'),
    refs(proposal, [199, 201, 296, 326], 'Quote recorded_at and transition effective_at are database clock_timestamp, not fixture-supplied dates. Same-key parent locking, exact predecessor check, unique sequence and strictly advancing database time serialize transitions.'),
    refs(proposal, [395, 443], 'Sequence resolver orders unique transition_seq DESC; time resolver filters effective_at <= cutoff, then takes greatest sequence. After-commit retrospective audit must receive the correct cutoff; dispatch retains exact transition/version ID.'),
    refs(fixture, [451, 475], 'Pending event6 is inserted in firstTx, its effective_at is returned as text; competing captures committed event5, reads clock_timestamp as text, compares supplied times, and precommit lookup expects b1.'),
    refs(fixture, [476, 499], 'The racing second operator waits100ms then loses with stale predecessor after firstTx commits. Sequence6=b2 and retained attempt/fact=b1 assertions precede the failing time-after-commit=b2 assertion.'),
    refs('node_modules/postgres/src/index.js', [119, 124], 'unsafe queries with parameter arrays use extended protocol even when prepare:false. No SQL/data code was executed in this investigation.'),
    refs('node_modules/postgres/src/types.js', [75, 93, 220, 228], 'Plain timestamp text inputs infer unknown type0. Explicit text binding instead can use string OID25.'),
    refs('node_modules/postgres/src/connection.js', [189, 200, 224, 241, 626, 633, 948, 964], 'Parameterized unprepared queries still Describe; ParameterDescription fills inferred OIDs before Bind. Bind selects options.serializers[type]. fetch_types:false does not remove default serializers.'),
    refs('node_modules/postgres/src/types.js', [5, 9, 28, 33, 193, 208], 'Default timestamptz OID1184 serializer converts even a string through new Date(x).toISOString(), losing submillisecond text precision. Default text OID25 serializer preserves the text string.'),
  ],
  supportedCandidate: {
    title: 'Timestamp cutoff parameter precision loss at Postgres.js inferred timestamptz binding',
    confirmedForThisRuntimeFailure: false,
    mechanism: 'The fixture retrieves exact SQL timestamp text, but the server can infer timestamptz1184 for both direct casts and the time resolver argument. The installed default serializer then changes that text to a millisecond JavaScript Date ISO value. The comparison at470 serializes BOTH pending and observed inputs this way and can pass even when the later cutoff has lost the microseconds needed to include committed event6.',
    sufficientCondition: 'If genuine pending effective_at and later observedAt share a millisecond, with pending effective_at strictly after the start of that millisecond, truncating observedAt to its millisecond makes cutoff < event6 effective_at. Resolver correctly returns event5/b1 after event6 committed. This is consistent with sequence6=b2 already having passed and the observed failure at499.',
    illustrativeNotExecuted: { pending: '2030-01-01 00:00:00.123456+00', observed: '2030-01-01 00:00:00.123789+00',
      bothJSDateISO: '2030-01-01T00:00:00.123Z', genuineObservedAfterPending: true,
      truncatedCutoffBeforePending: true, actualRuntimeValues: false },
    missingEvidence: ['The actual pendingEffectiveAt and observedAt texts from the failed run were not printed in step24 raw.',
      'The actual PG ParameterDescription/Bind payload and the failed database transition rows were not retained in the supplied frozen raw.',
      'No DB/driver code was executed here; a source-backed mechanism is not a confirmed runtime cause.'],
    alternativesNotRuntimeExcluded: ['Actual wall-clock regression or other unexpected runtime/driver state cannot be conclusively excluded without timestamps and bound payload.',
      'A changed fixture/proposal source between dcc6 andee122 is excluded for these two exact files by Git blobs and byte comparisons; this does not exclude every possible environment difference.'],
  },
  minimumFutureCandidatePlan: {
    status: 'plan only; no repository source written and no runtime verification performed',
    scope: fixture, threeQueriesOnly: queries.queries.map(row => ({ location: row.location,
      originalCallSHA256: row.originalCallSHA256, originalCallSourceExact: row.originalCallSourceExact,
      proposedCallSource: row.candidateCallSourcePlanOnly })),
    action: 'At470 cast each input parameter through ::text before ::timestamptz. At472/496 cast the resolver cutoff parameter through ::text::timestamptz. This makes PostgreSQL Describe infer text25 at the wire boundary and leaves all timestamp comparisons/filtering at full SQL precision.',
    preserved: ['Original b2 assertion499 and all65 original assert call ASTs', 'Original100ms contention delay/240000ms fixture timeout/cluster budgets',
      'Original transaction/commit/rollback and statement order', 'Original SQL resolver definitions/sequence sorting/time predicate/activation/source pins',
      'Original roles/ACL/schema/production dependencies and product code'],
    nextRealValidation: ['After separate authorization/source commit, run the original complete native PG18.6 quote fixture at its exact new SHA. No skipped fixture counts or prior dcc6 success substitute for that result.',
      'If permitted as a separate controlled diagnostic, capture nonsecret exact database pending/observed timestamp text and original-vs-text-bound cutoff to discriminate serialization truncation from clock/snapshot causes. Use fixed submillisecond values in a read-only SQL parameter roundtrip; do not insert waits to make the existing assertion pass.',
      'Retain original ee122 actual1/raw and new result independently. A new passing result would validate the candidate; it would not prove historical failed values that were never recorded.'],
  },
  scopeLimits: ['Only local source snapshots, Acorn AST parsing, existing frozen peer report/raw reads, and read-only local Git/search commands were performed.',
    'Active Core/Proxy exact selector-name scoped search had no matches; not an exhaustive absence proof for every quote behavior.',
    'Production Web remains outside this task. No real identity, deployment, native runtime, database, test or CI execution was attempted.',
    'This diagnosis belongs to the next batch and must not be retroactively added to the previous frozen archive as runtime evidence.'],
  closedReaderCommands: closedCommands,
  preWrapperReadNegatives: file('pre-wrapper-observed-tool-returns.json'),
  producerSources: ['run-command.mjs', 'inspect-static-quote-chain.mjs', 'inspect-proposal-and-active-scope.mjs', 'seal-readonly-diagnosis.mjs'].map(file),
  candidateCauseConfirmed: false, candidateImplemented: false, testsRerun: 0, nativePGStarted: 0,
  applicationRuns: 0, ciRequests: 0, productionRequests: 0, repoWrites: 0, gitMutations: 0,
  originalRuntimeFailureUpgraded: false, goalCompleteDerived: false, gatePassDerived: false,
  finalWriterReceipt: 'seal-readonly-diagnosis.result.json is produced only when the writer actually closes; its sibling stdout/stderr close this reader seal, not the old native run.',
};
const pathname = path.join(root, 'FINAL-quote-version-499-readonly-diagnosis.json');
fs.writeFileSync(pathname, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ final: descriptor(pathname), closed: true, actualReaderSealExit: 0,
  candidateCauseConfirmed: false, candidateImplemented: false, originalRuntimeExit: 1, testsRerun: 0, repoWrites: 0 }));
