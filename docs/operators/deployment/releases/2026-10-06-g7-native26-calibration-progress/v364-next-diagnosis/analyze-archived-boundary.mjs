import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const relative = 'docs/operators/deployment/releases/2026-10-06-native-g7-boundary-progress/root-progress/boundary-artifact/_temp/v364-boundary-once-37402302570-1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const bytesFor = name => fs.readFileSync(path.join(relative, name));
const nodeBytes = bytesFor('closed-result.json'), executorBytes = bytesFor('executor.closed.json');
const node = JSON.parse(nodeBytes), executor = JSON.parse(executorBytes);
const compressed = bytesFor('events.json.gz'), decoded = gunzipSync(compressed), events = JSON.parse(decoded);
assert.equal(decoded.length, node.events.bytes); assert.equal(digest(decoded), node.events.sha256); assert.equal(events.length, node.events.count);
const workers = events.filter(x => x.kind === 'workerd-log' && x.message.includes('V364_DIAG ')).map(row => {
  const start = row.message.indexOf('V364_DIAG ') + 'V364_DIAG '.length;
  return { ...row, diagnostic: JSON.parse(row.message.slice(start)) };
});
const results = node.results.map(result => {
  const all = events.filter(row => row.caseId === result.caseId), worker = workers.filter(row => row.caseId === result.caseId);
  const counts = rows => rows.reduce((value, row) => { const key = row.diagnostic?.event ?? row.kind; value[key] = (value[key] ?? 0) + 1; return value; }, {});
  return { caseId: result.caseId, actualExit: result.actualExit, closed: result.closed, originalWindow: result.originalWindow, tail: result.tail,
    finalPreDisposeSnapshot: result.finalPreDisposeSnapshot, hostKinds: counts(all), workerKinds: counts(worker),
    cancellationRelevantWorkerRows: worker.filter(row => ['signal-initial', 'signal-abort', 'waitUntil-register', 'waitUntil-fulfilled', 'waitUntil-rejected'].includes(row.diagnostic.event) || row.diagnostic.category === 'cancel'),
    releaseReadObservations: worker.filter(row => row.diagnostic.category === 'release'),
    closeEvents: all.filter(row => ['client-rst-api-invoke', 'client-cancel-invoke', 'client-cancel-settled', 'request-close', 'response-close', 'socket-close', 'server-response-close', 'server-socket-close', 'dispose-invoke', 'dispose-fulfilled'].includes(row.kind)),
  };
});
process.stdout.write(JSON.stringify({ closed: true, actualReadAnalysisOutcome: 0, runtimeOutcome: node.actualExit, originalStrictOutcome: node.baseline.code, actualExecutorOutcome: executor.actualExit, actualProcessExit: executor.actualProcessExit, runnerOutcomeCode: executor.runnerOutcomeCode,
  files: [ ['closed-result.json', nodeBytes], ['executor.closed.json', executorBytes], ['events.json.gz', compressed] ].map(([file, bytes]) => ({ file, bytes: bytes.length, sha256: digest(bytes) })),
  eventDecoded: { bytes: decoded.length, sha256: digest(decoded), count: events.length },
  originalStreamAndCommandNotReexecuted: true, sourceModified: false, productionRequests: 0, closure: executor.closure, results }, null, 2) + '\n');
