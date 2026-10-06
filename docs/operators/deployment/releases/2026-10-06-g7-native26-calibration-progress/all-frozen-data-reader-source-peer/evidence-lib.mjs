import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

import { directSocketClosure, directSocketAggregate, validateDirectSocketFiles } from './direct-socket-dialect.mjs';

import { native59BindingDialect, validateNative59InfoBinding } from './native59-info-binding.mjs';
import { validateFrozenDataBinding, validateTransportedDirectBinding } from './frozen-data-binding.mjs';

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
export function enumerate(root, relative = '', excludedDirectories = new Set()) {
  const files = [];
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    const rel = relative ? `${relative}/${name}` : name;
    assert.ok(relativeSafe(rel), 'Unsafe source relative path');
    if (excludedDirectories.has(rel)) continue;
    const full = path.join(root, rel), stat = fs.lstatSync(full);
    assert.equal(stat.isSymbolicLink(), false, 'Linked source directory or file rejected');
    if (stat.isDirectory()) files.push(...enumerate(root, rel, excludedDirectories));
    else { assert.ok(stat.isFile(), 'Nonregular evidence rejected'); files.push(rel); }
  }
  return files;
}
function closureOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.closed === false || value.terminal === false) return null;
  if (aggregateSchemas.has(value.schema)) return null;
  if (value.schema === 'v364-direct-socket-executor-closed-v1') return directSocketClosure(value);
  const numeric = (key) => Number.isSafeInteger(value[key]);
  const timestamp = (key) => typeof value[key] === 'string' && Number.isFinite(Date.parse(value[key]));
  const endedAbnormally = typeof value.signal === 'string' && value.signal !== '' || value.spawnError != null;
  const executorSchema = ['v364-owned-linux-executor-closed-v1', 'v364-owned-linux-boundary-executor-closed-v1'].includes(value.schema);
  if (value.schema === 'g7-owner-exact-terminal-spawnSync-status-v1') {
    if (value.closed !== true || !numeric('actualExit') || value.actualExit < 0 ||
        value.signal !== null || value.spawnError !== null || value.productionRequests !== 0 ||
        typeof value.id !== 'string' || !/^[a-z0-9-]+$/u.test(value.id) ||
        typeof value.program !== 'string' || !path.isAbsolute(value.program) ||
        typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) ||
        !Array.isArray(value.args) || !value.args.every(x => typeof x === 'string') ||
        !timestamp('startedAt') || !timestamp('endedAt') || Date.parse(value.endedAt) < Date.parse(value.startedAt) ||
        !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 ||
        value.source !== 'Exact spawnSync status; not inferred from wrapper success' ||
        !Array.isArray(value.outputs) || value.outputs.length !== 2 ||
        !value.outputs.every((x, i) => x && !Array.isArray(x) &&
          x.file === value.id + (i === 0 ? '.stdout.log' : '.stderr.log') &&
          relativeSafe(x.file) && !Object.hasOwn(x, 'path') &&
          Number.isSafeInteger(x.bytes) && x.bytes >= 0 && /^[0-9a-f]{64}$/u.test(x.sha256))) return null;
    return { dialect: value.schema, actualExit: value.actualExit, signal: null, spawnError: null,
      startedAt: value.startedAt, endedAt: value.endedAt, timeoutMs: value.timeoutMs,
      actualChildExitProven: true, separateOuterToolReceiptClaimed: false };
  }
  if (value.source === 'actual synchronous spawnSync return, not aggregate report') {
    if (value.terminal !== true || !numeric('status') || typeof value.id !== 'string' || !value.id ||
        typeof value.program !== 'string' || !value.program || typeof value.cwd !== 'string' || !value.cwd ||
        !Array.isArray(value.args) || !value.args.every(x => typeof x === 'string') ||
        !Number.isSafeInteger(value.timeout) || value.timeout < 1 ||
        !(value.signal === null || typeof value.signal === 'string' && value.signal !== '') ||
        !(value.error === null || value.error && typeof value.error === 'object' && !Array.isArray(value.error)) ||
        !Array.isArray(value.outputs) || value.outputs.length !== 2) return null;
    return { dialect: 'exact-terminal-spawnSync-status', actualExit: value.status,
      signal: value.signal, spawnError: value.error, actualChildExitProven: true,
      separateOuterToolReceiptClaimed: false };
  }
  if (value.schema === 'web-platform-g7-child-command-closed-v1') {
    if (value.closed !== true || typeof value.program !== 'string' || !value.program ||
        !Array.isArray(value.args) || !value.args.every(x => typeof x === 'string') ||
        !timestamp('begin') || !timestamp('endedAt') || Date.parse(value.endedAt) < Date.parse(value.begin) ||
        !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 ||
        !(value.signal === null || typeof value.signal === 'string' && value.signal !== '') ||
        !(value.errorCode === null || typeof value.errorCode === 'string' && value.errorCode !== '') ||
        !(numeric('actualExit') || value.signal !== null || value.errorCode !== null) ||
        !['stdout', 'stderr'].every(key => value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) ||
        value.timedOut != null && typeof value.timedOut !== 'boolean') return null;
    return { dialect: value.schema, actualExit: numeric('actualExit') ? value.actualExit : null,
      signal: value.signal, spawnError: value.errorCode === null ? null : { code: value.errorCode },
      timedOut: value.timedOut ?? value.errorCode === 'ETIMEDOUT', actualChildExitProven: numeric('actualExit') };
  }
  if (executorSchema && value.actualExit === 1 &&
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
  if (value.schema === 'v364-owned-linux-boundary-executor-closed-v1') {
    if (!numeric('actualExit') || !numeric('actualProcessExit') || !numeric('runnerOutcomeCode') ||
        !Number.isFinite(value.startedEpoch) || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 ||
        typeof value.timedOut !== 'boolean' || typeof value.interrupted !== 'boolean' ||
        value.closure?.authority !== 'this executor' || value.closure.subreaperEnabled !== true ||
        value.closure.groupGone !== true || value.closure.directChildReaped !== true ||
        typeof value.closure.leftoverGroupKilled !== 'boolean' || !Array.isArray(value.closure.reapedDescendants) ||
        !Array.isArray(value.closure.processCensus) || !Array.isArray(value.closure.errors) || !Array.isArray(value.files)) return null;
    return { dialect: value.schema, actualExit: value.actualExit, actualProcessExit: value.actualProcessExit,
      runnerOutcomeCode: value.runnerOutcomeCode, signal: null, spawnError: null,
      timedOut: value.timedOut, interrupted: value.interrupted, groupGone: true, directChildReaped: true,
      leftoverGroupKilled: value.closure.leftoverGroupKilled, apiDisposalReported: value.closure.apiDisposalReported,
      outerUnforcedGroupCloseReported: value.closure.outerUnforcedGroupClose,
      gracefulWorkerdExitProven: false, fullCooperativeCleanupProven: false };
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
const hasLogReference = value => ['stdout', 'stderr', 'stdoutPath', 'stderrPath'].some(key =>
  typeof value?.[key] === 'string' || value?.[key] && typeof value[key] === 'object' &&
  !Array.isArray(value[key]) && (typeof value[key].file === 'string' || typeof value[key].path === 'string'));
const aggregateSchemas = new Set(['v364-direct-socket-closed-v1', 'web-platform-g7-owned-linux-tls-pg-closed-v1', 'web-platform-g7-independent-cleanup-closed-v1', 'web-platform-g7-tls-pg-wire-v1']);
function aggregateOf(value) {
  if (value.schema === 'v364-direct-socket-closed-v1') return directSocketAggregate(value);
  const timestamp = key => typeof value[key] === 'string' && Number.isFinite(Date.parse(value[key]));
  if (!aggregateSchemas.has(value.schema) || !timestamp('startedAt') || !timestamp('endedAt') ||
      Date.parse(value.endedAt) < Date.parse(value.startedAt) || ![0, 1].includes(value.actualExit) ||
      !/^[0-9a-f]{40}$/u.test(value.sourceSHA)) return null;
  if (value.schema === 'web-platform-g7-tls-pg-wire-v1') {
    if (!Array.isArray(value.rows) || !['expectedOriginalNineWireCases', 'expectedPublicSSRRequests', 'expectedResourceFiles', 'completedPublicSSRRequests', 'completedResourceRequests'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) || value.fullG7Verified !== false) return null;
  } else {
    if (!/^g7-[0-9a-f]{32}$/u.test(value.owner)) return null;
    if (value.schema === 'web-platform-g7-owned-linux-tls-pg-closed-v1') {
      if (!value.cleanup || typeof value.cleanup.verifiedAbsent !== 'boolean' || !['containers', 'networks', 'volumes', 'errors'].every(key => Array.isArray(value.cleanup[key])) || value.fullG7Verified !== false || value.fullG8Verified !== false) return null;
    } else if (typeof value.verifiedAbsent !== 'boolean' || !Array.isArray(value.rows) || !Array.isArray(value.errors)) return null;
  }
  return { dialect: value.schema, actualExit: value.actualExit, sourceSHA: value.sourceSHA,
    aggregateOnly: true, childLogAuthority: false, gatePassDerived: false,
    ...(value.owner ? { owner: value.owner } : {}),
    ...(value.cleanup ? { cleanupVerifiedAbsentReported: value.cleanup.verifiedAbsent } : {}),
    ...(typeof value.verifiedAbsent === 'boolean' ? { cleanupVerifiedAbsentReported: value.verifiedAbsent } : {}) };
}
export function prepare(config) {
  assert.equal(config.schemaVersion, 1);
  assert.ok(/^[a-z0-9][a-z0-9-]+$/u.test(config.releaseSlug));
  assert.notEqual(config.releaseSlug, '2026-10-06-web-cutover-followup', 'Previous immutable release cannot be reused');
  assert.ok(Array.isArray(config.roots) && config.roots.length > 0);
  const prefixes = new Set(), roots = new Set(), entries = [], exclusions = [], blockers = [], receipts = [], contexts = [], historicalNonterminal = [], aggregateReports = [], reportOnlyDataBindings = [], closedExecutorTransportBindings = [];
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
    const excludedDirectories = new Map();
    for (const item of input.excludeDirectories ?? []) {
      assert.ok(relativeSafe(item.directory) && typeof item.reason === 'string' && item.reason.length > 3, 'Directory exclusions need an explicit safe path and reason');
      assert.ok(['isolated-before', 'isolated-after'].includes(item.directory), 'Only the two explicitly authorized Release CLI mirror trees may be excluded');
      assert.equal(root.toLowerCase(), fs.realpathSync('C:/Users/cina/AppData/Local/Temp/cinatoken-changesets-prettier-repair-ebc93278d4d847c7ae00b3cd29ba4ff2').toLowerCase(), 'Directory exclusion authority is limited to the actual authorized Release owner root');
      assert.equal(excludedDirectories.has(item.directory), false, 'Duplicate directory exclusion');
      const full = path.join(root, item.directory), stat = fs.lstatSync(full);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && within(root, fs.realpathSync(full)), 'Excluded directory must exist and resolve inside the input root');
      for (const previous of excludedDirectories.keys()) assert.ok(!item.directory.startsWith(previous + '/') && !previous.startsWith(item.directory + '/'), 'Overlapping directory exclusions rejected');
      excludedDirectories.set(item.directory, item.reason);
      exclusions.push({ root: input.id, directory: item.directory, scope: 'entire-explicit-directory-tree', reason: item.reason, descendantsEnumerated: false });
    }
    const names = enumerate(root, '', new Set(excludedDirectories.keys())), excluded = new Map();
    for (const item of input.exclude ?? []) {
      assert.ok(relativeSafe(item.file) && typeof item.reason === 'string' && item.reason.length > 3);
      assert.ok(names.includes(item.file) || item.allowMissing === true, 'Explicit exclusion does not match a source file');
      assert.equal(excluded.has(item.file), false); excluded.set(item.file, item.reason);
    }
    const data = new Map(names.filter((name) => !excluded.has(name)).map((name) => [name, stableRead(path.join(root, name))]));
    contexts.push({ input, root, names, excluded, data, json: new Map(), receiptByName: new Map(), aggregateByName: new Map(), logs: new Map(), dataBindings: new Map(), nonterminal: new Set() });
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
    assert.ok(declared.partialLogCopy == null || typeof declared.partialLogCopy === 'boolean');
    assert.ok(declared.includedLogCopies == null || Array.isArray(declared.includedLogCopies));
    if (declared.includedLogCopies != null) assert.equal(declared.partialLogCopy, true, 'Partial log copies need an explicit partialLogCopy declaration');
    schemaCopies.set(`${context.input.id}/${declared.file}`, { context, name: declared.file, originalContext, originalName: declared.originalFile, declared });
  }
  for (const context of contexts) for (const [name, item] of context.data) {
    if (!name.endsWith('.json')) continue;
    let value; try { value = JSON.parse(item.bytes.toString('utf8')); } catch { if (/\.(?:result|receipt)\.json$/u.test(name)) problem(context, name, 'Invalid command receipt JSON'); continue; }
    context.json.set(name, value);
    if (schemaCopies.has(`${context.input.id}/${name}`)) continue;
    if (aggregateSchemas.has(value?.schema)) {
      const aggregate = aggregateOf(value);
      if (!aggregate || value.closed === false || value.terminal === false) problem(context, name, 'Invalid explicit aggregate report; never use it as child-log authority');
      else { const report = { root: context.input.id, file: name, sha256: item.sha256, ...aggregate }; context.aggregateByName.set(name, report); aggregateReports.push(report); }
      continue;
    }
    const claimedReceipt = /\.(?:result|receipt)\.json$/u.test(name) || ['v364-direct-socket-executor-closed-v1', 'v364-owned-linux-executor-closed-v1', 'v364-owned-linux-boundary-executor-closed-v1', 'web-platform-g7-child-command-closed-v1'].includes(value?.schema) || value?.source === 'actual synchronous spawnSync return, not aggregate report';
    if (value?.closed === false || value?.terminal === false) {
      context.nonterminal.add(name); historicalNonterminal.push({ root: context.input.id, file: name, sha256: item.sha256, usedAsClosedCommand: false });
      if (!hasLogReference(value)) continue;
    }
    const closure = closureOf(value);
    if (!closure) { if (claimedReceipt) problem(context, name, 'No explicit supported terminal receipt; never guess an exit'); continue; }
    // Aggregate proof reports with closed:true are preserved but cannot bind logs without command fields.
    if (!claimedReceipt && !hasLogReference(value)) continue;
    const receipt = { root: context.input.id, file: name, sha256: item.sha256, ...closure };
    context.receiptByName.set(name, receipt); receipts.push(receipt);
  }
  for (const context of contexts) for (const [name, receipt] of context.receiptByName) {
    const item = context.data.get(name), value = context.json.get(name);
    if (['v364-direct-socket-executor-closed-v1', 'v364-direct-socket-no-child-preflight-rejection-v1'].includes(receipt.dialect)) {
      try { const binding=(config.transportedDirectExecutorBindings??[]).find(b=>b.rootId===context.input.id&&b.executorFile===name); const transport=binding?validateTransportedDirectBinding(binding,contexts):null; for (const rel of validateDirectSocketFiles({ receiptName: name, value, data: context.data, json: context.json, receiptMtime: item.mtimeMs, transportBindingVerified:transport?.transportBindingVerified===true })) associate(context, rel, transport?{...receipt,transportBinding:transport}:receipt); if(transport)closedExecutorTransportBindings.push(transport); }
      catch (error) { problem(context, name, `Direct-socket executor binding rejected: ${error.message}`); }
      continue;
    }
    if (receipt.dialect === 'exact-terminal-spawnSync-status') {
      const listed = new Set();
      for (const descriptor of value.outputs) {
        if (!descriptor || typeof descriptor.path !== 'string' || !path.isAbsolute(descriptor.path) ||
            listed.has(path.resolve(descriptor.path).toLowerCase()) || !Number.isSafeInteger(descriptor.bytes) ||
            descriptor.bytes < 0 || !/^[0-9a-f]{64}$/u.test(descriptor.sha256)) { problem(context, name, 'Invalid or duplicate terminal spawnSync output descriptor'); continue; }
        listed.add(path.resolve(descriptor.path).toLowerCase());
        const target = locate(path.resolve(descriptor.path));
        if (!target || target.context !== context || target.item.bytes.length !== descriptor.bytes || target.item.sha256 !== descriptor.sha256) { problem(context, name, 'Terminal spawnSync output outside its included root or bytes/SHA mismatch'); continue; }
        associate(target.context, target.name, receipt);
      }
      continue;
    }
    if (['v364-owned-linux-executor-closed-v1', 'v364-owned-linux-boundary-executor-closed-v1', 'v364-historical-preflight-rejection'].includes(receipt.dialect)) {
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
      if (value[field] == null) continue;
      let reference = value[field], descriptor = null;
      if (typeof reference === 'object' && !Array.isArray(reference)) {
        descriptor = reference;
        const isFile = typeof descriptor.file === 'string', isPath = typeof descriptor.path === 'string';
        if (isFile === isPath || isFile && !relativeSafe(descriptor.file)) { problem(context, name, `Invalid ${field} nested descriptor path`); continue; }
        reference = isFile ? path.posix.join(path.posix.dirname(name), descriptor.file) : descriptor.path;
      }
      if (typeof reference !== 'string' || reference === '') { problem(context, name, `Invalid ${field} log reference`); continue; }
      const byteDescriptor = value[byteField];
      let secondaryDescriptor = null;
      if (byteDescriptor != null && typeof byteDescriptor === 'object' && !Array.isArray(byteDescriptor)) secondaryDescriptor = byteDescriptor;
      if (descriptor === null && byteDescriptor != null && typeof byteDescriptor === 'object' && !Array.isArray(byteDescriptor)) descriptor = byteDescriptor;
      if (descriptor !== null && (!Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0 || !/^[0-9a-f]{64}$/u.test(descriptor.sha256))) { problem(context, name, `Invalid ${field} terminal bytes/SHA descriptor`); continue; }
      if (secondaryDescriptor !== null && (!Number.isSafeInteger(secondaryDescriptor.bytes) || secondaryDescriptor.bytes < 0 || !/^[0-9a-f]{64}$/u.test(secondaryDescriptor.sha256))) { problem(context, name, `Invalid ${field} secondary terminal bytes/SHA descriptor`); continue; }
      if (byteDescriptor != null && secondaryDescriptor === null && (!Number.isSafeInteger(byteDescriptor) || byteDescriptor < 0)) { problem(context, name, `Invalid ${field} terminal byte count`); continue; }
      const full = path.isAbsolute(reference) ? path.resolve(reference) : path.resolve(context.root, reference);
      const target = locate(full);
      if (!target) { problem(context, name, `Receipt ${field} points outside configured roots or file missing/excluded`); continue; }
      let authoritativeReceipt = receipt, receiptTime = item.mtimeMs;
      if (target.context !== context) {
        const original = [...target.context.receiptByName].find(([, candidate]) => candidate.sha256 === receipt.sha256);
        if (!original) { problem(context, name, `Receipt ${field} crosses roots without byte-exact included original receipt`); continue; }
        authoritativeReceipt = original[1]; receiptTime = target.context.data.get(original[0]).mtimeMs;
      }
      if (descriptor !== null) {
        if (descriptor.bytes !== target.item.bytes.length || descriptor.sha256 !== target.item.sha256) { problem(target.context, target.name, 'Terminal receipt bytes/SHA mismatch'); continue; }
      } else {
        if (target.item.mtimeMs > receiptTime) { problem(target.context, target.name, 'Log newer than terminal receipt; may be active or reused'); continue; }
      }
      if (secondaryDescriptor !== null && (secondaryDescriptor.bytes !== target.item.bytes.length || secondaryDescriptor.sha256 !== target.item.sha256)) { problem(target.context, target.name, 'Secondary terminal receipt bytes/SHA mismatch'); continue; }
      if (byteDescriptor != null && secondaryDescriptor === null && byteDescriptor !== target.item.bytes.length) { problem(target.context, target.name, 'Terminal receipt byte count no longer matches log'); continue; }
      associate(target.context, target.name, authoritativeReceipt);
    }
  }
  for (const binding of config.explicitCommandOutputBindings ?? []) {
    const context = contexts.find(x => x.input.id === binding.rootId);
    assert.ok(context && relativeSafe(binding.receiptFile), 'Explicit command-output binding must name an included root/receipt');
    if (binding.dialect === native59BindingDialect) {
      try {
        const item = context.data.get(binding.receiptFile), value = context.json.get(binding.receiptFile);
        const exact = validateNative59InfoBinding({ contextRoot: context.root, receiptName: binding.receiptFile, item, value, binding, data: context.data });
        const receipt = { root: context.input.id, file: binding.receiptFile, sha256: item.sha256, ...exact.receipt };
        assert.equal(context.receiptByName.has(binding.receiptFile), false, 'Original Info-only receipt must not duplicate command authority');
        context.receiptByName.set(binding.receiptFile, receipt); receipts.push(receipt);
        for (const output of exact.outputs) associate(context, output.file, { ...receipt, explicitCommandOutputBinding: true });
      } catch (error) { problem(context, binding.receiptFile, `Native59 exact Info binding rejected: ${error.message}`); }
      continue;
    }
    try {
      assert.ok(/^[0-9a-f]{64}$/u.test(binding.expectedReceiptSha256));
      const item = context.data.get(binding.receiptFile), value = context.json.get(binding.receiptFile), receipt = context.receiptByName.get(binding.receiptFile);
      assert.equal(item?.sha256, binding.expectedReceiptSha256);
      const exactG7Owner = receipt?.dialect === 'g7-owner-exact-terminal-spawnSync-status-v1';
      const begin = exactG7Owner ? value.startedAt : value?.begin;
      assert.ok(receipt && value?.closed === true && typeof value.program === 'string' && value.program !== '' &&
        Array.isArray(value.args) && value.args.every(x => typeof x === 'string') &&
        Number.isSafeInteger(value.actualExit) && typeof begin === 'string' && typeof value.endedAt === 'string' &&
        Number.isFinite(Date.parse(begin)) && Number.isFinite(Date.parse(value.endedAt)) && Date.parse(value.endedAt) >= Date.parse(begin),
        'Explicit output binding requires its own numeric closed command with ordered timestamps');
      if (exactG7Owner) assert.deepEqual(binding.outputs, value.outputs, 'G7 owner binding must exactly match both original stream descriptors');
      assert.ok(Array.isArray(binding.outputs) && binding.outputs.length > 0);
      const listed = new Set();
      for (const descriptor of binding.outputs) {
        assert.ok(descriptor && relativeSafe(descriptor.file) && !listed.has(descriptor.file) &&
          Number.isSafeInteger(descriptor.bytes) && descriptor.bytes >= 0 && /^[0-9a-f]{64}$/u.test(descriptor.sha256));
        listed.add(descriptor.file);
        const output = context.data.get(descriptor.file);
        assert.ok(output, 'Explicit command output missing or excluded');
        assert.equal(output.bytes.length, descriptor.bytes); assert.equal(output.sha256, descriptor.sha256);
        assert.ok(output.mtimeMs <= item.mtimeMs, 'Explicit command output newer than pinned receipt');
        associate(context, descriptor.file, { ...receipt, explicitCommandOutputBinding: true, receiptPinnedSha256: binding.expectedReceiptSha256 });
      }
    } catch (error) { problem(context, binding.receiptFile, `Explicit command-output binding rejected: ${error.message}`); }
  }
  for (const binding of config.explicitByteCopyBindings ?? []) {
    const context = contexts.find(x => x.input.id === binding.rootId);
    assert.ok(context && relativeSafe(binding.provenanceFile), 'Explicit byte-copy provenance must name an included root/file');
    try {
      const provenanceFile = context.data.get(binding.provenanceFile), provenance = context.json.get(binding.provenanceFile);
      assert.ok(/^[0-9a-f]{64}$/u.test(binding.expectedProvenanceSha256));
      assert.equal(provenanceFile?.sha256, binding.expectedProvenanceSha256);
      assert.equal(provenance?.closed, true); assert.equal(provenance.actualArchiveOutcome, 0);
      assert.equal(provenance.noWorkflowRerun, true); assert.ok(Number.isSafeInteger(provenance.originalDownloadActualExit));
      assert.ok(Array.isArray(provenance.entries) && provenance.entries.length > 0);
      const copiedNames = new Set();
      for (const descriptor of provenance.entries) {
        assert.equal(descriptor.exact, true);
        assert.ok(typeof descriptor.source === 'string' && path.isAbsolute(descriptor.source) && typeof descriptor.copy === 'string' && path.isAbsolute(descriptor.copy));
        assert.ok(Number.isSafeInteger(descriptor.bytes) && descriptor.bytes >= 0 && /^[0-9a-f]{64}$/u.test(descriptor.sha256));
        const source = locate(path.resolve(descriptor.source)), copy = locate(path.resolve(descriptor.copy));
        assert.ok(source && copy && copy.context === context && path.resolve(descriptor.source) !== path.resolve(descriptor.copy));
        assert.equal(copiedNames.has(copy.name), false); copiedNames.add(copy.name);
        for (const target of [source, copy]) { assert.equal(target.item.bytes.length, descriptor.bytes); assert.equal(target.item.sha256, descriptor.sha256); }
        assert.deepEqual(source.item.bytes, copy.item.bytes);
        const authority = source.context.receiptByName.get(source.name), logAuthorities = source.context.logs.get(source.name) ?? [];
        const authorities = authority ? [authority] : logAuthorities;
        assert.ok(authorities.length > 0, 'Byte-exact original has no independently verified terminal authority');
        for (const original of authorities) {
          assert.equal(original.actualExit, provenance.originalDownloadActualExit, 'Copy metadata differs from original closed download receipt');
          associate(copy.context, copy.name, { ...original, immutableExplicitByteCopy: true,
            copyProvenance: { root: context.input.id, file: binding.provenanceFile, sha256: provenanceFile.sha256 }, ciTerminalClaim: false });
        }
      }
    } catch (error) { problem(context, binding.provenanceFile, `Explicit byte-copy binding rejected: ${error.message}`); }
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
    else {
      const copiedAuthority = { ...original, immutableSchemaCopy: true, partialLogCopy: copy.declared.partialLogCopy === true, ciTerminalClaim: false,
        originalReceipt: { root: copy.originalContext.input.id, file: copy.originalName, sha256: original.sha256 } };
      associate(copy.context, copy.name, copiedAuthority);
      try {
        const listed = new Set();
        for (const descriptor of copy.declared.includedLogCopies ?? []) {
          assert.ok(descriptor && relativeSafe(descriptor.file) && relativeSafe(descriptor.originalFile) && !listed.has(descriptor.file) &&
            Number.isSafeInteger(descriptor.bytes) && descriptor.bytes >= 0 && /^[0-9a-f]{64}$/u.test(descriptor.sha256));
          listed.add(descriptor.file);
          const from = copy.originalContext.data.get(descriptor.originalFile), to = copy.context.data.get(descriptor.file);
          assert.ok(from && to, 'Partial log source/copy missing or excluded');
          for (const target of [from, to]) { assert.equal(target.bytes.length, descriptor.bytes); assert.equal(target.sha256, descriptor.sha256); }
          assert.deepEqual(from.bytes, to.bytes);
          assert.ok((copy.originalContext.logs.get(descriptor.originalFile) ?? []).some(x => x.file === copy.originalName && x.sha256 === original.sha256),
            'Partial copied output was not closed by the declared original receipt');
          associate(copy.context, descriptor.file, { ...copiedAuthority, includedPartialLogCopy: true,
            originalOutput: { root: copy.originalContext.input.id, file: descriptor.originalFile, bytes: descriptor.bytes, sha256: descriptor.sha256 } });
        }
      } catch (error) { problem(copy.context, copy.name, `Explicit partial schema-log copy rejected: ${error.message}`); }
    }
  }
  const seenDataBindings=new Set();
  for(const binding of config.frozenInputDataBindings??[]){
    const key=binding.rootId+'/'+(binding.reportFile??binding.file),context=contexts.find(c=>c.input.id===binding.rootId);assert.ok(context,'Data-binding source root not configured');
    try{assert.equal(seenDataBindings.has(key),false,'Duplicate frozen input data binding');seenDataBindings.add(key);const result=validateFrozenDataBinding(binding,contexts);reportOnlyDataBindings.push(result.report);for(const name of result.names){if(!result.context.dataBindings.has(name))result.context.dataBindings.set(name,[]);result.context.dataBindings.get(name).push(result.report);}}
    catch(error){problem(context,binding.reportFile??binding.file,'Frozen input report-only data binding rejected: '+error.message);}
  }
  for(const binding of config.transportedDirectExecutorBindings??[]){const context=contexts.find(c=>c.input.id===binding.rootId);assert.ok(context,'Transport binding source root not configured');if(!closedExecutorTransportBindings.some(t=>t.root===binding.rootId&&t.file===binding.executorFile))problem(context,binding.executorFile,'Declared transported executor binding was not validated');}
  for (const context of contexts) for (const name of context.names) {
    const { input, root, excluded, data, logs, receiptByName } = context;
    if (excluded.has(name)) { exclusions.push({ root: input.id, file: name, reason: excluded.get(name) }); continue; }
    const item = data.get(name), dataBindings = context.dataBindings.get(name) ?? [], logClosures = logs.get(name) ?? [], closure = receiptByName.get(name), aggregate = context.aggregateByName.get(name);
    if (logLike(name) && logClosures.length === 0 && dataBindings.length === 0) { problem(context, name, 'Log has no verified terminal command receipt; declare an explicit reasoned exclusion if active'); continue; }
    entries.push({ sourceRootId: input.id, sourceRoot: root, sourceRelative: name, sourcePath: path.join(root, name), relative: `${input.id}/${name}`, phase: input.phase, materialKind: closure ? 'closed-command-receipt' : aggregate ? 'closed-aggregate-report' : logClosures.length ? 'closed-command-output' : dataBindings.length ? 'report-only-data-bound-material' : context.nonterminal.has(name) ? 'historical-nonterminal-report' : 'immutable-source-or-report', closures: closure ? [closure] : logClosures, ...(dataBindings.length ? {dataBindings} : {}), ...(aggregate ? { aggregateReport: aggregate } : {}), originalBytes: item.bytes.length, originalSha256: item.sha256, mtimeMs: item.mtimeMs });
  }
  entries.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
  assert.equal(new Set(entries.map((entry) => entry.relative)).size, entries.length, 'Stable relative prefixes must not collide');
  return { entries, exclusions, blockers, receipts, aggregateReports, historicalNonterminal, reportOnlyDataBindings, closedExecutorTransportBindings, sourceRootIds: [...prefixes] };
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
  const report = { schemaVersion: 1, releaseSlug: config.releaseSlug, sourceCommit: config.sourceCommit, createdAt: new Date().toISOString(), collectionOnly: true, gatePassDerived: false, productionRequests: 0, evidenceDirectory: config.releaseSlug, entries, exclusions: plan.exclusions, closedReceipts: plan.receipts, closedAggregateReports: plan.aggregateReports, reportOnlyDataBindings: plan.reportOnlyDataBindings, closedExecutorTransportBindings: plan.closedExecutorTransportBindings, frozenInputDataBindings: config.frozenInputDataBindings ?? [], transportedDirectExecutorBindings: config.transportedDirectExecutorBindings ?? [], historicalNonterminalReports: plan.historicalNonterminal, immutableCopyBindings: config.immutableCopyBindings ?? [], explicitByteCopyBindings: config.explicitByteCopyBindings ?? [], explicitCommandOutputBindings: config.explicitCommandOutputBindings ?? [], immutableSchemaCopies: config.immutableSchemaCopies ?? [], roots: config.roots.map(({ id, path, phase, excludeDirectories }) => ({ id, path, phase, ...(excludeDirectories?.length ? { excludeDirectories } : {}) })), totals: { files: entries.length, originalBytes: entries.reduce((n, x) => n + x.originalBytes, 0), storedBytes: entries.reduce((n, x) => n + x.storedBytes, 0), gzipFiles: entries.filter((x) => x.encoding === 'gzip').length, nonzeroOrAbnormalReceipts: plan.receipts.filter((x) => x.actualExit !== 0 || x.signal != null || x.spawnError != null).length }, semantics: config.semantics ?? { scope: 'Evidence collection; no complete G7/G8 claim' } };
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
