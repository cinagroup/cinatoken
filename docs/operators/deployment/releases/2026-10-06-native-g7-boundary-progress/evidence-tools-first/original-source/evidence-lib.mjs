import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const relativeSafe = (name) => typeof name === 'string' && name !== '' &&
  !path.isAbsolute(name) && !name.includes('\\') && !name.split('/').some((part) =>
    part === '' || part === '.' || part === '..' || /[:\x00-\x1f]/u.test(part));
export function within(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
export function tempDestination(target, { mustBeNew = false } = {}) {
  const absolute = path.resolve(target);
  const temp = fs.realpathSync(os.tmpdir());
  assert.ok(within(temp, absolute) && absolute !== temp, 'Output must stay inside a dedicated Temp path');
  let parent = path.dirname(absolute);
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  assert.ok(within(temp, fs.realpathSync(parent)), 'Output parent resolves outside Temp');
  if (mustBeNew) assert.equal(fs.existsSync(absolute), false, 'wx output directory already exists');
  return absolute;
}
export function stableRead(file) {
  const before = fs.lstatSync(file);
  assert.ok(before.isFile() && !before.isSymbolicLink(), 'Evidence must be a regular unlinked file');
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  assert.equal(before.size, after.size, 'Source size changed while reading');
  assert.equal(before.mtimeMs, after.mtimeMs, 'Source timestamp changed while reading');
  assert.deepEqual(fs.readFileSync(file), bytes, 'Source bytes changed while reading');
  return { bytes, sha256: sha256(bytes), mtimeMs: after.mtimeMs };
}
export function enumerate(root, relative = '') {
  const files = [];
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    const rel = relative ? `${relative}/${name}` : name;
    assert.ok(relativeSafe(rel), 'Unsafe source relative path');
    const full = path.join(root, rel), stat = fs.lstatSync(full);
    assert.equal(stat.isSymbolicLink(), false, 'Linked source directory or file rejected');
    if (stat.isDirectory()) files.push(...enumerate(root, rel));
    else { assert.ok(stat.isFile(), 'Nonregular evidence rejected'); files.push(rel); }
  }
  return files;
}
function closureOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.closed === false || value.terminal === false) return null;
  const numeric = (key) => Number.isSafeInteger(value[key]);
  const timestamp = (key) => typeof value[key] === 'string' && Number.isFinite(Date.parse(value[key]));
  const endedAbnormally = typeof value.signal === 'string' && value.signal !== '' || value.spawnError != null;
  if (value.schema === 'v364-owned-linux-executor-closed-v1' && value.actualExit === 1 &&
      value.fatal?.name === 'RuntimeError' && value.fatal?.message === 'Requires explicit --execute-linux on an owned Linux runner' &&
      value.packageSHA256 === null && value.closedReportPresent === false && value.reportedActualExit === null &&
      value.closure?.subreaperEnabled === false && value.closure?.groupGone === true && value.closure?.directChildReaped === false &&
      value.closure?.leftoverGroupKilled === false && Array.isArray(value.closure?.reapedDescendants) && value.closure.reapedDescendants.length === 0 &&
      value.run && Object.values(value.run).every(x => x === null) && Array.isArray(value.files) && value.files.length === 2 &&
      value.files.map(x => x.path).sort().join('|') === 'executor.stderr.txt|executor.stdout.txt') {
    return { dialect: 'v364-historical-preflight-rejection', actualExit: 1,
      observedHistoricalActualProcessExitField: value.actualProcessExit, actualChildExitProven: false,
      signal: null, spawnError: null, linuxRuntimeExecuted: false, fullCooperativeCleanupProven: false };
  }
  if (value.schema === 'v364-owned-linux-executor-closed-v1' && numeric('actualExit') && numeric('actualProcessExit') &&
      value.closure?.groupGone === true && value.closure?.directChildReaped === true && Array.isArray(value.files)) {
    return { dialect: 'v364-owned-linux-executor-closed-v1', actualExit: value.actualExit,
      actualProcessExit: value.actualProcessExit, runnerOutcomeCode: value.runnerOutcomeCode ?? null,
      signal: null, spawnError: null, groupGone: true, directChildReaped: true,
      leftoverGroupKilled: value.closure.leftoverGroupKilled, cooperativeNativeFinallyReported: value.closure.cooperativeNativeFinallyVerified,
      fullCooperativeCleanupProven: false };
  }
  if (value.closed === true && (numeric('actualExitCode') || numeric('actualExit') || numeric('exitCode') || endedAbnormally)) {
    return { dialect: 'explicit-closed', actualExit: numeric('actualExitCode') ? value.actualExitCode : numeric('actualExit') ? value.actualExit : numeric('exitCode') ? value.exitCode : null, signal: value.signal ?? null, spawnError: value.spawnError ?? null };
  }
  if (timestamp('finishedAt') && typeof value.executable === 'string' && Array.isArray(value.args) && (numeric('actualExit') || endedAbnormally)) {
    return { dialect: 'root-finishedAt-actualExit', actualExit: numeric('actualExit') ? value.actualExit : null, signal: value.signal ?? null, spawnError: value.spawnError ?? null };
  }
  if (timestamp('completedAt') && typeof value.program === 'string' && Array.isArray(value.arguments) && (numeric('actualExitCode') || endedAbnormally)) {
    return { dialect: 'peer-completedAt-actualExitCode', actualExit: numeric('actualExitCode') ? value.actualExitCode : null, signal: value.signal ?? null, spawnError: value.spawnError ?? null };
  }
  return null;
}
function logLike(relative) {
  return /(?:^|[./_-])(?:stdout|stderr)(?:[._-]|$)/iu.test(relative) || /\.(?:log|out|err)$/iu.test(relative);
}
export function prepare(config) {
  assert.equal(config.schemaVersion, 1);
  assert.ok(/^[a-z0-9][a-z0-9-]+$/u.test(config.releaseSlug));
  assert.notEqual(config.releaseSlug, '2026-10-06-web-cutover-followup', 'Previous immutable release cannot be reused');
  assert.ok(Array.isArray(config.roots) && config.roots.length > 0);
  const prefixes = new Set(), roots = new Set(), entries = [], exclusions = [], blockers = [], receipts = [], contexts = [], historicalNonterminal = [];
  for (const input of config.roots) {
    assert.ok(/^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.id) && !prefixes.has(input.id), 'Unique stable root prefix required');
    prefixes.add(input.id);
    assert.ok(['historical-and-current', 'local-validation', 'prepared-only', 'closed-ci-evidence', 'source-peer-review'].includes(input.phase));
    const root = fs.realpathSync(input.path);
    assert.ok(fs.lstatSync(root).isDirectory());
    assert.ok(within(fs.realpathSync(os.tmpdir()), root), 'Only explicitly owned Temp input roots are supported');
    const rootKey = root.toLowerCase();
    assert.equal(roots.has(rootKey), false, 'Duplicate resolved source root'); roots.add(rootKey);
    for (const previous of roots) if (previous !== rootKey) assert.ok(!within(previous, rootKey) && !within(rootKey, previous), 'Overlapping source roots would duplicate evidence; split them explicitly');
    const names = enumerate(root), excluded = new Map();
    for (const item of input.exclude ?? []) {
      assert.ok(relativeSafe(item.file) && typeof item.reason === 'string' && item.reason.length > 3);
      assert.ok(names.includes(item.file) || item.allowMissing === true, 'Explicit exclusion does not match a source file');
      assert.equal(excluded.has(item.file), false); excluded.set(item.file, item.reason);
    }
    const data = new Map(names.filter((name) => !excluded.has(name)).map((name) => [name, stableRead(path.join(root, name))]));
    contexts.push({ input, root, names, excluded, data, json: new Map(), receiptByName: new Map(), logs: new Map(), nonterminal: new Set() });
  }
  const pointer = (object, keys) => { assert.ok(Array.isArray(keys) && keys.every(x => typeof x === 'string' && !['__proto__', 'prototype', 'constructor'].includes(x))); return keys.reduce((value, key) => value?.[key], object); };
  const locate = full => { const context = contexts.find(x => within(x.root, full)); if (!context) return null; const name = path.relative(context.root, full).split(path.sep).join('/'); const item = context.data.get(name); return item ? { context, name, item } : null; };
  const associate = (context, name, receipt) => { if (!context.logs.has(name)) context.logs.set(name, []); const array = context.logs.get(name); if (!array.some(x => x.root === receipt.root && x.file === receipt.file && x.sha256 === receipt.sha256)) array.push(receipt); };
  const problem = (context, file, reason) => blockers.push({ root: context.input.id, file, reason });
  const schemaCopies = new Map();
  for (const declared of config.immutableSchemaCopies ?? []) {
    const context = contexts.find(x => x.input.id === declared.rootId), originalContext = contexts.find(x => x.input.id === declared.originalRootId);
    assert.ok(context && originalContext && relativeSafe(declared.file) && relativeSafe(declared.originalFile));
    const copy = context.data.get(declared.file), original = originalContext.data.get(declared.originalFile);
    if (!copy || !original || copy.sha256 !== declared.sha256 || original.sha256 !== declared.sha256 || !copy.bytes.equals(original.bytes)) { problem(context, declared.file, 'Explicit schema-copy original/copy bytes or pinned SHA mismatch'); continue; }
    schemaCopies.set(`${context.input.id}/${declared.file}`, { context, name: declared.file, originalContext, originalName: declared.originalFile });
  }
  for (const context of contexts) for (const [name, item] of context.data) {
    if (!name.endsWith('.json')) continue;
    let value; try { value = JSON.parse(item.bytes.toString('utf8')); } catch { if (/\.(?:result|receipt)\.json$/u.test(name)) problem(context, name, 'Invalid command receipt JSON'); continue; }
    context.json.set(name, value);
    if (schemaCopies.has(`${context.input.id}/${name}`)) continue;
    const claimedReceipt = /\.(?:result|receipt)\.json$/u.test(name) || value?.schema === 'v364-owned-linux-executor-closed-v1';
    if (value?.closed === false || value?.terminal === false) {
      context.nonterminal.add(name); historicalNonterminal.push({ root: context.input.id, file: name, sha256: item.sha256, usedAsClosedCommand: false });
      if (!['stdout', 'stderr', 'stdoutPath', 'stderrPath'].some(key => typeof value[key] === 'string')) continue;
    }
    const closure = closureOf(value);
    if (!closure) { if (claimedReceipt) problem(context, name, 'No explicit supported terminal receipt; never guess an exit'); continue; }
    // Aggregate proof reports with closed:true are preserved but cannot bind logs without command fields.
    if (!claimedReceipt && !['stdout', 'stderr', 'stdoutPath', 'stderrPath'].some(key => typeof value[key] === 'string')) continue;
    const receipt = { root: context.input.id, file: name, sha256: item.sha256, ...closure };
    context.receiptByName.set(name, receipt); receipts.push(receipt);
  }
  for (const context of contexts) for (const [name, receipt] of context.receiptByName) {
    const item = context.data.get(name), value = context.json.get(name);
    if (receipt.dialect === 'v364-owned-linux-executor-closed-v1' || receipt.dialect === 'v364-historical-preflight-rejection') {
      const listed = new Set();
      for (const descriptor of value.files) {
        if (!descriptor || !relativeSafe(descriptor.path) || listed.has(descriptor.path) || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0 || !/^[0-9a-f]{64}$/u.test(descriptor.sha256)) { problem(context, name, 'Invalid or duplicate executor file descriptor'); continue; }
        listed.add(descriptor.path);
        const rel = path.posix.join(path.posix.dirname(name), descriptor.path), file = context.data.get(rel);
        if (!file || file.bytes.length !== descriptor.bytes || file.sha256 !== descriptor.sha256) { problem(context, rel, 'Executor manifest file bytes/SHA mismatch or excluded'); continue; }
        associate(context, rel, receipt);
      }
      const nodeName = path.posix.join(path.posix.dirname(name), 'closed-result.json'), node = context.json.get(nodeName);
      if (node) for (const stream of ['stdout', 'stderr']) {
        const descriptor = node.baseline?.[stream], rel = path.posix.join(path.posix.dirname(name), `original-strict.${stream}.txt`), file = context.data.get(rel);
        if (!descriptor || !file || descriptor.bytes !== file.bytes.length || descriptor.sha256 !== file.sha256 || !listed.has(`original-strict.${stream}.txt`)) problem(context, nodeName, 'Node baseline raw descriptor differs from authoritative executor manifest');
      }
      continue;
    }
    for (const [field, byteField] of [['stdout', 'stdoutBytes'], ['stderr', 'stderrBytes'], ['stdoutPath', 'stdoutBytes'], ['stderrPath', 'stderrBytes']]) {
      if (typeof value[field] !== 'string' || value[field] === '') continue;
      const full = path.isAbsolute(value[field]) ? path.resolve(value[field]) : path.resolve(context.root, value[field]);
      const target = locate(full);
      if (!target) { problem(context, name, `Receipt ${field} points outside configured roots or file missing/excluded`); continue; }
      let authoritativeReceipt = receipt, receiptTime = item.mtimeMs;
      if (target.context !== context) {
        const original = [...target.context.receiptByName].find(([, candidate]) => candidate.sha256 === receipt.sha256);
        if (!original) { problem(context, name, `Receipt ${field} crosses roots without byte-exact included original receipt`); continue; }
        authoritativeReceipt = original[1]; receiptTime = target.context.data.get(original[0]).mtimeMs;
      }
      if (target.item.mtimeMs > receiptTime) { problem(target.context, target.name, 'Log newer than terminal receipt; may be active or reused'); continue; }
      if (value[byteField] != null && value[byteField] !== target.item.bytes.length) { problem(target.context, target.name, 'Terminal receipt byte count no longer matches log'); continue; }
      associate(target.context, target.name, authoritativeReceipt);
    }
  }
  for (const binding of config.immutableCopyBindings ?? []) {
    const context = contexts.find(x => x.input.id === binding.provenanceRootId), terminalContext = contexts.find(x => x.input.id === binding.terminalRootId);
    assert.ok(context && terminalContext && relativeSafe(binding.provenanceFile) && relativeSafe(binding.terminalFile), 'Copy binding roots/files must be explicitly configured');
    try {
      const provenance = context.json.get(binding.provenanceFile), terminal = terminalContext.json.get(binding.terminalFile);
      assert.equal(provenance?.schema, 'cinatoken.immutable-raw-copy-provenance.v1');
      assert.equal(provenance.byteExactCopy, true); assert.equal(provenance.copyDidNotExecuteGh, true);
      assert.equal(pointer(terminal, binding.statusPointer), 'completed');
      assert.ok(['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'skipped', 'neutral', 'stale'].includes(pointer(terminal, binding.conclusionPointer)));
      assert.equal(pointer(terminal, binding.jobIdPointer), binding.expectedJobId); assert.equal(pointer(terminal, binding.runIdPointer), binding.expectedRunId);
      assert.ok(/^[0-9a-f]{40}$/u.test(binding.expectedHeadSha)); assert.equal(pointer(terminal, binding.headShaPointer), binding.expectedHeadSha);
      const descriptor = key => { const value = provenance[key]; assert.ok(value && typeof value.path === 'string'); const target = locate(path.resolve(value.path)); assert.ok(target, 'Copy provenance points outside configured included sources'); assert.equal(target.item.bytes.length, value.bytes); assert.equal(target.item.sha256, value.sha256); return target; };
      const original = descriptor('originalCommandReceipt'), copied = descriptor('copiedReceipt');
      assert.deepEqual(original.item.bytes, copied.item.bytes); assert.equal(copied.context, context);
      const receipt = original.context.receiptByName.get(original.name); assert.ok(receipt, 'Copy original lacks recognized authoritative closure');
      const command = original.context.json.get(original.name); assert.ok(command.args?.some(x => typeof x === 'string' && x.endsWith(`/actions/jobs/${binding.expectedJobId}/logs`)), 'Copy provenance command does not bind exact terminal CI job');
      assert.equal(provenance.originalActualExit, receipt.actualExit); assert.equal(provenance.originalSignal, receipt.signal);
      for (const stream of ['Stdout', 'Stderr']) {
        const from = descriptor(`original${stream}`), to = descriptor(`copied${stream}`);
        assert.deepEqual(from.item.bytes, to.item.bytes); assert.equal(to.context, context);
        assert.ok((from.context.logs.get(from.name) ?? []).some(x => x.sha256 === receipt.sha256), 'Original output was not closed by its own receipt');
        associate(to.context, to.name, { ...receipt, immutableCopy: true, copyProvenance: { root: context.input.id, file: binding.provenanceFile, sha256: context.data.get(binding.provenanceFile).sha256 }, terminalCi: { jobId: binding.expectedJobId, runId: binding.expectedRunId, headSha: binding.expectedHeadSha, conclusion: pointer(terminal, binding.conclusionPointer), evidenceRoot: terminalContext.input.id, evidenceFile: binding.terminalFile, sha256: terminalContext.data.get(binding.terminalFile).sha256 } });
      }
    } catch (error) { problem(context, binding.provenanceFile, `Explicit immutable-copy binding rejected: ${error.message}`); }
  }
  for (const binding of config.historicalProducerBindings ?? []) {
    const context = contexts.find(x => x.input.id === binding.provenanceRootId);
    assert.ok(context && relativeSafe(binding.provenanceFile), 'Historical producer provenance must be explicitly configured');
    try {
      const file = context.data.get(binding.provenanceFile), value = context.json.get(binding.provenanceFile);
      assert.equal(file.sha256, binding.expectedProvenanceSha256); assert.equal(value?.schema, 'v364-historical-preparation-log-terminal-provenance-v1');
      assert.equal(value.originalOuterCommandActuallyClosed, true); assert.equal(value.originalOuterToolExitCode, 0);
      const checked = (full, bytes, hash) => { const result = locate(path.resolve(full)); assert.ok(result, 'Historical source missing/outside explicit roots'); assert.equal(result.item.bytes.length, bytes); assert.equal(result.item.sha256, hash); return result; };
      const outer = checked(value.originalOuterToolReceipt.path, value.originalOuterToolReceipt.bytes, value.originalOuterToolReceipt.sha256);
      assert.equal(outer.item.sha256, binding.expectedOuterToolReceiptSha256);
      const tool = JSON.parse(outer.item.bytes.toString('utf8')); assert.equal(tool.schema, 'historical-exact-tool-return-copy-v1');
      assert.equal(tool.commandWasRerun, false); assert.equal(tool.individualInnerToolReceiptsExisted, false); assert.equal(tool.originalResult.exit_code, 0); assert.equal(tool.originalResult.session_id, undefined);
      const originalAndCopy = descriptor => { assert.equal(descriptor.copiedBytesExactly, true); const original = checked(descriptor.originalPath, descriptor.bytes, descriptor.sha256), copied = checked(descriptor.copiedPath, descriptor.bytes, descriptor.sha256); assert.deepEqual(original.item.bytes, copied.item.bytes); assert.equal(copied.context, context); return { original, copied }; };
      const producer = originalAndCopy(value.originalProducer), final = originalAndCopy(value.originalFinal);
      assert.equal(producer.original.item.sha256, binding.expectedProducerSha256); assert.equal(final.original.item.sha256, binding.expectedFinalSha256);
      assert.ok(tool.originalRequest.cmd.replaceAll('\\', '/').includes(value.originalProducer.originalPath.replaceAll('\\', '/')));
      const toolSummary = JSON.parse(tool.originalResult.output.trim()), finalReport = JSON.parse(final.original.item.bytes.toString('utf8'));
      assert.equal(toolSummary.sha256, final.original.item.sha256); assert.equal(toolSummary.bytes, final.original.item.bytes.length); assert.equal(path.resolve(toolSummary.report), path.resolve(value.originalFinal.originalPath));
      const sourceLines = producer.original.item.bytes.toString('utf8').split(/\r?\n/u);
      assert.equal(value.commands.length, binding.expectedCommands.length);
      for (const expectedCommand of binding.expectedCommands) {
        const command = value.commands.find(x => x.id === expectedCommand.id); assert.ok(command);
        assert.equal(command.actualProgramExit, expectedCommand.actualExit); assert.ok(Number.isSafeInteger(command.actualProgramExit));
        assert.equal(command.assertion, expectedCommand.assertion); assert.equal(command.originalProducerAssertionLine, expectedCommand.assertionLine);
        assert.ok(sourceLines[command.originalProducerAssertionLine - 1]?.includes(command.assertion), 'Pinned producer exact assertion line differs');
        assert.equal(command.originalProducerWasClosed, true); assert.equal(command.spawnedLocalPreparationProcessWasWaited, true); assert.equal(command.separateToolReceiptForThisCommand, false);
        assert.equal(command.noNativeRuntime, true); assert.equal(command.nativeTerminalClaim, false); assert.equal(command.provesLinuxProcessGroupClosure, false);
        assert.equal(finalReport.checks.find(x => x.name === command.checkName)?.actualExit, command.actualProgramExit);
        assert.ok(typeof command.program === 'string' && Array.isArray(command.args)); assert.equal(command.outputs.length, 2);
        const receipt = { root: context.input.id, file: binding.provenanceFile, sha256: file.sha256,
          dialect: 'historical-producer-observed-local-preparation', commandId: command.id, actualExit: command.actualProgramExit,
          signal: null, spawnError: null, separatePerCommandToolReceipt: false, originalProducerToolReceiptSha256: outer.item.sha256,
          originalProducerSha256: producer.original.item.sha256, linuxRuntimeExecuted: false, nativeProcessGroupClosureProven: false };
        receipts.push(receipt);
        for (const output of command.outputs) { const pair = originalAndCopy(output); associate(pair.original.context, pair.original.name, receipt); associate(pair.copied.context, pair.copied.name, { ...receipt, immutableCopy: true }); }
      }
      for (const artifact of value.windowsExecutorHistoricalArtifacts) {
        const pair = originalAndCopy(artifact);
        const originalClosure = pair.original.context.receiptByName.get(pair.original.name) ?? pair.original.context.logs.get(pair.original.name)?.[0];
        assert.ok(originalClosure && originalClosure.actualExit === 1 && originalClosure.linuxRuntimeExecuted === false, 'Historical Windows artifact must bind original negative preflight authority');
        associate(pair.copied.context, pair.copied.name, { ...originalClosure, immutableCopy: true, producerProvenanceSha256: file.sha256 });
      }
    } catch (error) { problem(context, binding.provenanceFile, `Explicit historical producer binding rejected: ${error.message}`); }
  }
  for (const copy of schemaCopies.values()) {
    const original = copy.originalContext.receiptByName.get(copy.originalName);
    if (!original) problem(copy.context, copy.name, 'Schema copy has no recognized original terminal/negative receipt');
    else associate(copy.context, copy.name, { ...original, immutableSchemaCopy: true });
  }
  for (const context of contexts) for (const name of context.names) {
    const { input, root, excluded, data, logs, receiptByName } = context;
    if (excluded.has(name)) { exclusions.push({ root: input.id, file: name, reason: excluded.get(name) }); continue; }
    const item = data.get(name), logClosures = logs.get(name) ?? [], closure = receiptByName.get(name);
    if (logLike(name) && logClosures.length === 0) { problem(context, name, 'Log has no verified terminal command receipt; declare an explicit reasoned exclusion if active'); continue; }
    entries.push({ sourceRootId: input.id, sourceRoot: root, sourceRelative: name, sourcePath: path.join(root, name), relative: `${input.id}/${name}`, phase: input.phase, materialKind: closure ? 'closed-command-receipt' : logClosures.length ? 'closed-command-output' : context.nonterminal.has(name) ? 'historical-nonterminal-report' : 'immutable-source-or-report', closures: closure ? [closure] : logClosures, originalBytes: item.bytes.length, originalSha256: item.sha256, mtimeMs: item.mtimeMs });
  }
  entries.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
  assert.equal(new Set(entries.map((entry) => entry.relative)).size, entries.length, 'Stable relative prefixes must not collide');
  return { entries, exclusions, blockers, receipts, historicalNonterminal, sourceRootIds: [...prefixes] };
}
export function collect(config) {
  assert.ok(/^[0-9a-f]{40}$/u.test(config.sourceCommit), 'Final full SHA must be supplied before collection');
  for (const id of config.requiredRootIds ?? []) assert.ok(config.roots.some((root) => root.id === id), `Final required input root ${id} is still missing`);
  const plan = prepare(config);
  assert.equal(plan.blockers.length, 0, JSON.stringify(plan.blockers));
  const output = tempDestination(config.outputDirectory, { mustBeNew: true });
  for (const entry of plan.entries) assert.ok(!within(entry.sourceRoot, output) && !within(output, entry.sourceRoot), 'Collector output cannot overlap a source root');
  const threshold = config.gzipThresholdBytes ?? 100_000;
  assert.ok(Number.isSafeInteger(threshold) && threshold >= 100_000);
  assert.equal(new Set(plan.entries.map((entry) => `${entry.relative}${entry.originalBytes > threshold ? '.gz' : ''}`)).size, plan.entries.length, 'Compression suffix collides with another source path');
  fs.mkdirSync(output);
  const evidenceDir = path.join(output, config.releaseSlug); fs.mkdirSync(evidenceDir);
  const entries = [];
  for (const original of plan.entries) {
    const read = stableRead(original.sourcePath);
    assert.equal(read.sha256, original.originalSha256, 'Source changed after preparation');
    assert.equal(read.bytes.length, original.originalBytes);
    const gzip = read.bytes.length > threshold;
    const stored = gzip ? gzipSync(read.bytes, { level: 9, mtime: 0 }) : read.bytes;
    const storedRelative = `${original.relative}${gzip ? '.gz' : ''}`;
    assert.ok(relativeSafe(storedRelative));
    const file = path.join(evidenceDir, storedRelative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, stored, { flag: 'wx' });
    const reread = fs.readFileSync(file), restored = gzip ? gunzipSync(reread) : reread;
    assert.deepEqual(reread, stored); assert.deepEqual(restored, read.bytes);
    assert.equal(sha256(restored), original.originalSha256);
    assert.equal(stableRead(original.sourcePath).sha256, original.originalSha256, 'Source changed after storing');
    const { mtimeMs, ...descriptor } = original;
    entries.push({ ...descriptor, storedRelative, encoding: gzip ? 'gzip' : 'identity', storedBytes: reread.length, storedSha256: sha256(reread), originalRoundtripExact: true, sourceBytesExact: true });
  }
  const report = { schemaVersion: 1, releaseSlug: config.releaseSlug, sourceCommit: config.sourceCommit, createdAt: new Date().toISOString(), collectionOnly: true, gatePassDerived: false, productionRequests: 0, evidenceDirectory: config.releaseSlug, entries, exclusions: plan.exclusions, closedReceipts: plan.receipts, historicalNonterminalReports: plan.historicalNonterminal, immutableCopyBindings: config.immutableCopyBindings ?? [], roots: config.roots.map(({ id, path, phase }) => ({ id, path, phase })), totals: { files: entries.length, originalBytes: entries.reduce((n, x) => n + x.originalBytes, 0), storedBytes: entries.reduce((n, x) => n + x.storedBytes, 0), gzipFiles: entries.filter((x) => x.encoding === 'gzip').length, nonzeroOrAbnormalReceipts: plan.receipts.filter((x) => x.actualExit !== 0 || x.signal != null || x.spawnError != null).length }, semantics: config.semantics ?? { scope: 'Evidence collection; no complete G7/G8 claim' } };
  const reportPath = path.join(output, `${config.releaseSlug}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return { reportPath, report, sha256: sha256(fs.readFileSync(reportPath)), bytes: fs.statSync(reportPath).size };
}
export function verify(reportPath, { verifySource = true } = {}) {
  const file = path.resolve(reportPath), bytes = fs.readFileSync(file), report = JSON.parse(bytes.toString('utf8'));
  assert.equal(report.schemaVersion, 1); assert.equal(report.collectionOnly, true); assert.equal(report.gatePassDerived, false);
  assert.ok(relativeSafe(report.evidenceDirectory));
  const root = path.join(path.dirname(file), report.evidenceDirectory), expected = [];
  assert.ok(fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink());
  assert.ok(within(path.dirname(file), fs.realpathSync(root)));
  const storedNames = enumerate(root).sort();
  const originals = new Set();
  for (const item of report.entries) {
    assert.ok(relativeSafe(item.storedRelative)); assert.equal(originals.has(item.relative), false); originals.add(item.relative);
    expected.push(item.storedRelative);
    const stored = fs.readFileSync(path.join(root, item.storedRelative));
    assert.equal(stored.length, item.storedBytes); assert.equal(sha256(stored), item.storedSha256);
    assert.ok(['gzip', 'identity'].includes(item.encoding));
    const restored = item.encoding === 'gzip' ? gunzipSync(stored) : stored;
    assert.equal(restored.length, item.originalBytes); assert.equal(sha256(restored), item.originalSha256);
    if (verifySource) {
      assert.ok(within(fs.realpathSync(os.tmpdir()), fs.realpathSync(item.sourceRoot)));
      assert.ok(within(item.sourceRoot, item.sourcePath));
      assert.equal(path.relative(item.sourceRoot, item.sourcePath).split(path.sep).join('/'), item.sourceRelative);
      const source = stableRead(item.sourcePath).bytes; assert.equal(source.length, item.originalBytes); assert.deepEqual(source, restored);
    }
    for (const closure of item.closures) { assert.ok(Number.isSafeInteger(closure.actualExit) || closure.signal != null || closure.spawnError != null, 'No inferred zero exits'); }
  }
  assert.deepEqual(storedNames, expected.sort(), 'Stored directory files differ from the complete report index');
  assert.equal(report.totals.files, report.entries.length);
  assert.equal(report.totals.originalBytes, report.entries.reduce((n, x) => n + x.originalBytes, 0));
  assert.equal(report.totals.storedBytes, report.entries.reduce((n, x) => n + x.storedBytes, 0));
  return { closed: true, actualExitCode: 0, report: file, reportBytes: bytes.length, reportSha256: sha256(bytes), verifiedFiles: report.entries.length, storedBytesAndShaExact: true, decodedOriginalBytesAndShaExact: true, sourceBytesExact: verifySource, directorySetExact: true, gatePassDerived: false };
}
