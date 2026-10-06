import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepare } from './evidence-lib.mjs';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const clone = () => structuredClone(config);
const cases = [];
const baseline = prepare(config);
assert.equal(baseline.blockers.length, 0);
const observed = baseline.receipts.filter(x => x.dialect === 'historical-producer-observed-local-preparation');
assert.deepEqual(observed.map(x => x.actualExit), [0, 0, 1, 1]);
assert.ok(observed.every(x => x.separatePerCommandToolReceipt === false && x.linuxRuntimeExecuted === false && x.nativeProcessGroupClosureProven === false));
cases.push('all-real-closed-source-roots-admitted-with-historical-zero-zero-one-one-not-native');
const wrongSource = clone(); wrongSource.historicalProducerBindings[0].expectedProducerSha256 = '0'.repeat(64);
assert.ok(prepare(wrongSource).blockers.some(x => x.reason.includes('historical producer binding rejected'))); cases.push('wrong-original-producer-sha-blocks');
const wrongStatus = clone(); wrongStatus.historicalProducerBindings[0].expectedCommands[2].actualExit = 0;
assert.ok(prepare(wrongStatus).blockers.some(x => x.reason.includes('historical producer binding rejected'))); cases.push('historical-expected-rejection-cannot-be-upgraded-to-zero');
const wrongOuter = clone(); wrongOuter.historicalProducerBindings[0].expectedOuterToolReceiptSha256 = '0'.repeat(64);
assert.ok(prepare(wrongOuter).blockers.some(x => x.reason.includes('historical producer binding rejected'))); cases.push('wrong-original-closed-tool-receipt-sha-blocks');
const wrongCopy = clone(); wrongCopy.immutableSchemaCopies[0].sha256 = '0'.repeat(64);
assert.ok(prepare(wrongCopy).blockers.some(x => x.reason.includes('schema-copy'))); cases.push('wrong-copied-schema-sha-blocks');
console.log(JSON.stringify({ closed: true, actualExitCode: 0, pass: cases.length, fail: 0, skipped: 0, cases,
  sourceRootsReadOnly: config.roots.length, admittedFiles: baseline.entries.length, actualHistoricalStatuses: observed.map(x => x.actualExit),
  originalSourceFilesModified: false, realSourceCollectionPerformed: false, ciInvocations: 0, productionRequests: 0,
  historicalCommandsExecuted: false, databaseRequests: 0, nativeExecution: false }));
