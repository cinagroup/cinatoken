import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = 'C:/cinagroup/cinatoken';
const relative = 'docs/developers/architecture/web-frontend-migration.md';
const baselineSha = 'f9b9140f7fdc35b4bddcd27e13df14cb2e444a34';
const priorSha = 'f77b97de76d0d838f2f03c173055b0c38c9f1785';
const output = dirname(fileURLToPath(import.meta.url));
const label = process.argv[2];
assert.match(label ?? '', /^[a-z0-9][a-z0-9-]{0,63}$/);
const requireFinal = process.argv.slice(3).includes('--require-final-evidence');
assert.ok(process.argv.slice(3).every((arg) => arg === '--require-final-evidence'));
const reportPath = join(output, label + '.report.json');
assert.equal(existsSync(reportPath), false, 'Reports are immutable; select a fresh label');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const captures = [];

function gitBlob(sha, short) {
  const args = ['-c', 'core.longpaths=true', 'show', sha + ':' + relative];
  const startedAt = new Date().toISOString();
  const child = spawnSync('git', args, { cwd: root, windowsHide: true, encoding: null, maxBuffer: 8 * 1024 * 1024 });
  const stdout = child.stdout ?? Buffer.alloc(0);
  const stderr = child.stderr ?? Buffer.alloc(0);
  const receipt = { executable: 'git', args, cwd: root, startedAt, endedAt: new Date().toISOString(), actualExitCode: child.status, signal: child.signal, error: child.error ? String(child.error) : null, stdout: { bytes: stdout.length, sha256: hash(stdout) }, stderr: { bytes: stderr.length, sha256: hash(stderr) } };
  writeFileSync(join(output, label + '.' + short + '.git-show.stdout.log'), stdout, { flag: 'wx' });
  writeFileSync(join(output, label + '.' + short + '.git-show.stderr.log'), stderr, { flag: 'wx' });
  writeFileSync(join(output, label + '.' + short + '.git-show.result.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  captures.push(receipt);
  assert.equal(child.status, 0, 'git show must actually close with exit 0');
  assert.equal(child.signal, null);
  assert.equal(child.error, undefined);
  return stdout;
}

function readDocument(bytes) {
  const text = bytes.toString('utf8');
  assert.deepEqual(Buffer.from(text, 'utf8'), bytes, 'Document must be byte-preserving UTF-8');
  const rawLines = text.match(/[^\n]*(?:\n|$)/g)?.filter((raw) => raw.length) ?? [];
  assert.equal(rawLines.join(''), text);
  const lines = rawLines.map((raw, index) => ({ raw, content: raw.replace(/\r?\n$/, ''), lineNumber: index + 1 }));
  const section = (start, end) => {
    const starts = lines.flatMap((line, index) => line.content.startsWith(start) ? [index] : []);
    const ends = lines.flatMap((line, index) => line.content.startsWith(end) ? [index] : []);
    assert.equal(starts.length, 1, 'Unique heading required: ' + start);
    assert.equal(ends.length, 1, 'Unique heading required: ' + end);
    assert.ok(ends[0] > starts[0]);
    return lines.slice(starts[0], ends[0]);
  };
  const matrixSection = section('## 3. ', '## 4. ');
  const tasksSection = section('## 4. ', '## 5. ');
  const phaseSection = section('### 0.1 ', '### 0.2 ');
  const rawCheckboxes = lines.filter((line) => /\[[ xX]\]/.test(line.content));
  const tasks = lines.filter((line) => /^\s*- \[[ xX]\]/.test(line.content));
  const main = lines.filter((line) => /^- \[[ xX]\] (?:P[0-8]-\d{2}|SRC-\d{2})[：:]/.test(line.content));
  const matrix = matrixSection.filter((line) => /^\| (?:PUB|AUTH|ACC|ADM)-\d{2} \|/.test(line.content));
  const gates = tasksSection.filter((line) => /^验收门槛 G[0-8]：/.test(line.content));
  const evidence = lines.filter((line) => /^\| E0[0-8] \|/.test(line.content));
  const phases = phaseSection.filter((line) => /^\| P[0-8] /.test(line.content));
  const stateCounts = (rows) => ({ total: rows.length, done: rows.filter((line) => /^\s*- \[[xX]\]/.test(line.content)).length, pending: rows.filter((line) => /^\s*- \[ \]/.test(line.content)).length });
  const ids = (rows, pattern) => rows.map((line) => pattern.exec(line.content)?.[1]);
  return { bytes, text, lines, section, rawCheckboxes, tasks, main, matrix, matrixSection, tasksSection, gates, evidence, phases, counts: { rawCheckboxLines: rawCheckboxes.length, actual: stateCounts(tasks), main: stateCounts(main), matrix: matrix.length, gates: gates.length, evidence: evidence.length, phases: phases.length }, ids: { main: ids(main, /^- \[[ xX]\] ((?:P[0-8]|SRC)-\d{2})/), matrix: ids(matrix, /^\| ([A-Z]+-\d{2}) \|/), gates: ids(gates, /^验收门槛 (G[0-8])：/), evidence: ids(evidence, /^\| (E0[0-8]) \|/), phases: ids(phases, /^\| (P[0-8]) /) } };
}

const expected = { rawCheckboxLines: 213, actual: { total: 211, done: 55, pending: 156 }, main: { total: 102, done: 8, pending: 94 }, matrix: 54, gates: 9, evidence: 9, phases: 9 };
const expectedMatrix = [['PUB', 8], ['AUTH', 4], ['ACC', 15], ['ADM', 27]].flatMap(([prefix, count]) => Array.from({ length: count }, (_, index) => prefix + '-' + String(index + 1).padStart(2, '0')));
const collectionBytes = (rows) => Buffer.from(rows.map((line) => line.raw).join(''), 'utf8');
const summarizeRows = (rows) => ({ count: rows.length, bytes: collectionBytes(rows).length, sha256: hash(collectionBytes(rows)), lines: rows.map((line) => ({ lineNumber: line.lineNumber, bytes: Buffer.byteLength(line.raw), sha256: hash(Buffer.from(line.raw)) })) });

function compareDocuments(before, after, name) {
  const checks = [];
  const check = (item, passed, details = {}) => checks.push({ item, passed, ...details });
  for (const [side, document] of [['before', before], ['after', after]]) {
    check(side + ' exact counts', JSON.stringify(document.counts) === JSON.stringify(expected), { actual: document.counts, expected });
    check(side + ' unique 102 main IDs', new Set(document.ids.main).size === 102);
    check(side + ' 54 ordered matrix IDs including AUTH', JSON.stringify(document.ids.matrix) === JSON.stringify(expectedMatrix));
    check(side + ' ordered G0-G8', JSON.stringify(document.ids.gates) === JSON.stringify(Array.from({ length: 9 }, (_, i) => 'G' + i)));
    check(side + ' ordered E00-E08', JSON.stringify(document.ids.evidence) === JSON.stringify(Array.from({ length: 9 }, (_, i) => 'E0' + i)));
    check(side + ' ordered P0-P8 phase rows', JSON.stringify(document.ids.phases) === JSON.stringify(Array.from({ length: 9 }, (_, i) => 'P' + i)));
  }
  for (const item of ['rawCheckboxes', 'tasks', 'main', 'matrix', 'matrixSection', 'tasksSection', 'gates', 'evidence']) {
    const oldBytes = collectionBytes(before[item]);
    const newBytes = collectionBytes(after[item]);
    const mismatch = Array.from({ length: Math.max(before[item].length, after[item].length) }, (_, index) => {
      const a = before[item][index], b = after[item][index];
      if (a?.raw === b?.raw) return null;
      return { index, beforeLine: a?.lineNumber ?? null, afterLine: b?.lineNumber ?? null, before: a?.content ?? null, after: b?.content ?? null };
    }).filter(Boolean);
    check(item + ' original UTF-8 bytes/order', oldBytes.equals(newBytes), { before: { count: before[item].length, bytes: oldBytes.length, sha256: hash(oldBytes) }, after: { count: after[item].length, bytes: newBytes.length, sha256: hash(newBytes) }, mismatches: mismatch });
  }
  const mutablePhaseEvidence = new Set(['P1', 'P6', 'P7', 'P8']);
  const phaseRows = [];
  for (let index = 0; index < before.phases.length; index++) {
    const a = before.phases[index], b = after.phases[index];
    const oldCells = a.content.split('|'), newCells = b?.content.split('|') ?? [];
    const phaseId = before.ids.phases[index];
    const shape = oldCells.length === 6 && newCells.length === 6;
    const frontTwoEqual = shape && oldCells.slice(0, 3).join('|') === newCells.slice(0, 3).join('|');
    const fullRowRequired = !mutablePhaseEvidence.has(phaseId);
    const passed = frontTwoEqual && (!fullRowRequired || a.raw === b.raw);
    check(phaseId + ' protected phase columns', passed, { beforeLine: a.lineNumber, afterLine: b?.lineNumber ?? null, frontTwoEqual, fullRowRequired, mutableColumns: fullRowRequired ? [] : [3, 4], beforeFrontTwoSha256: hash(Buffer.from(oldCells.slice(0, 3).join('|'))), afterFrontTwoSha256: hash(Buffer.from(newCells.slice(0, 3).join('|'))) });
    phaseRows.push({ phaseId, changed: a.raw !== b?.raw, before: oldCells.slice(1, 5), after: newCells.slice(1, 5) });
  }
  return { name, passed: checks.every((item) => item.passed), checks, phaseRows };
}

function negativeControls(baseline) {
  const replaceLine = (line, changed) => baseline.text.replace(line.raw, changed + (line.raw.endsWith('\r\n') ? '\r\n' : line.raw.endsWith('\n') ? '\n' : ''));
  const firstMain = baseline.main[0], firstGate = baseline.gates[0], firstEvidence = baseline.evidence[0], firstMatrix = baseline.matrix[0];
  const phaseP1 = baseline.phases[1], phaseP2 = baseline.phases[2];
  const alterCell = (line, index, value) => { const cells = line.content.split('|'); cells[index] += value; return cells.join('|'); };
  const cases = [
    { name: 'flipped checkbox', text: replaceLine(firstMain, firstMain.content.replace('[ ]', '[x]')), expected: false },
    { name: 'deleted task', text: baseline.text.replace(firstMain.raw, ''), expected: false },
    { name: 'changed main requirement with same state', text: replaceLine(firstMain, firstMain.content + ' altered requirement'), expected: false },
    { name: 'changed route permission', text: replaceLine(firstMatrix, alterCell(firstMatrix, 4, ' altered permission')), expected: false },
    { name: 'changed gate text', text: replaceLine(firstGate, firstGate.content + ' altered gate'), expected: false },
    { name: 'changed E evidence text', text: replaceLine(firstEvidence, alterCell(firstEvidence, 3, ' altered evidence')), expected: false },
    { name: 'changed P1 status', text: replaceLine(phaseP1, alterCell(phaseP1, 2, ' altered status')), expected: false },
    { name: 'changed P2 evidence outside allowed phases', text: replaceLine(phaseP2, alterCell(phaseP2, 3, ' altered evidence')), expected: false },
    { name: 'added unchecked task', text: baseline.text + '\n- [ ] Unauthorized extra task\n', expected: false },
    { name: 'allowed P1 evidence update', text: replaceLine(phaseP1, alterCell(phaseP1, 3, ' new direct evidence')), expected: true },
  ];
  return cases.map((scenario) => {
    const comparison = compareDocuments(baseline, readDocument(Buffer.from(scenario.text)), scenario.name);
    assert.equal(comparison.passed, scenario.expected, 'Audit negative control: ' + scenario.name);
    return { name: scenario.name, expectedPass: scenario.expected, actualPass: comparison.passed, caught: comparison.passed === scenario.expected };
  });
}

const startedAt = new Date().toISOString();
const priorBytes = gitBlob(priorSha, 'f77');
const baselineBytes = gitBlob(baselineSha, 'f9');
const currentBytes = readFileSync(join(root, relative));
writeFileSync(join(output, label + '.working.md'), currentBytes, { flag: 'wx' });
const prior = readDocument(priorBytes), baseline = readDocument(baselineBytes), current = readDocument(currentBytes);
const history = compareDocuments(prior, baseline, 'f77-to-f9 frozen original scope');
const comparison = compareDocuments(baseline, current, 'f9-to-working current update');
const controls = negativeControls(baseline);
const finalChecks = [];
if (requireFinal) {
  const published = current.lines.filter((line) => line.content.startsWith('当前发布（2026-10-06）：'));
  finalChecks.push({ item: 'one current publication paragraph', passed: published.length === 1 });
  for (const value of [baselineSha, '218e2b8c-6153-4163-8b9f-cffc34445e27', 'b1fc86e3-a392-488c-9eca-6b5a99f8c713']) finalChecks.push({ item: 'current publication contains exact ' + value, passed: published.length === 1 && published[0].content.includes(value) });
  finalChecks.push({ item: 'one appended 5.94 evidence section', passed: current.lines.filter((line) => line.content.startsWith('### 5.94 ')).length === 1 });
}
const report = { schemaVersion: 1, startedAt, endedAt: new Date().toISOString(), readOnly: true, noProductionActions: true, baselineSha, priorSha, requireFinal, scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))), captures, documentBytes: { prior: { bytes: priorBytes.length, sha256: hash(priorBytes) }, baseline: { bytes: baselineBytes.length, sha256: hash(baselineBytes) }, workingSnapshot: { path: join(output, label + '.working.md'), bytes: currentBytes.length, sha256: hash(currentBytes) } }, history, comparison, negativeControls: controls, finalChecks, protectedCollections: Object.fromEntries(['rawCheckboxes', 'tasks', 'main', 'matrix', 'gates', 'evidence', 'phases'].map((item) => [item, { baseline: summarizeRows(baseline[item]), working: summarizeRows(current[item]) }])), manualReviewStillRequired: ['New evidence claims must match actual browser/HTTP/deployment receipts', 'A passing scope audit does not prove real CinaAuth login, existing dedicated workspace or Key acceptance', 'Production OAuth client-resource association write remains explicitly unapproved after auto-review rejection'], passed: history.passed && comparison.passed && controls.every((item) => item.caught) && finalChecks.every((item) => item.passed) };
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ reportPath, reportBytes: readFileSync(reportPath).length, reportSha256: hash(readFileSync(reportPath)), scriptPath: fileURLToPath(import.meta.url), scriptSha256: report.scriptSha256, passed: report.passed, currentCounts: current.counts, failedChecks: [...history.checks, ...comparison.checks, ...finalChecks].filter((item) => !item.passed), negativeControls: controls.length }));
process.exitCode = report.passed ? 0 : 1;
