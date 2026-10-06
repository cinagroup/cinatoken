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
  const prefixes = new Set(), roots = new Set(), entries = [], exclusions = [], blockers = [], receipts = [];
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
    const receiptByName = new Map(), logs = new Map();
    for (const [name, item] of data) {
      if (name.endsWith('.json')) {
        try {
          const snapshot = JSON.parse(item.bytes.toString('utf8'));
          if (snapshot?.closed === false || snapshot?.terminal === false) blockers.push({ root: input.id, file: name, reason: 'Explicit nonterminal JSON must be excluded with a reason; it cannot prove a closed command' });
        } catch { /* Nonreceipt raw JSON/text is retained verbatim without interpretation. */ }
      }
      if (!/\.(?:result|receipt)\.json$/u.test(name)) continue;
      let value; try { value = JSON.parse(item.bytes.toString('utf8')); } catch { blockers.push({ root: input.id, file: name, reason: 'Invalid command receipt JSON' }); continue; }
      const closure = closureOf(value);
      if (!closure) { blockers.push({ root: input.id, file: name, reason: 'No explicit supported terminal receipt; never guess an exit' }); continue; }
      receiptByName.set(name, closure);
      const receipt = { root: input.id, file: name, sha256: item.sha256, ...closure };
      receipts.push(receipt);
      for (const [field, byteField] of [['stdout', 'stdoutBytes'], ['stderr', 'stderrBytes'], ['stdoutPath', 'stdoutBytes'], ['stderrPath', 'stderrBytes']]) {
        if (typeof value[field] !== 'string' || value[field] === '') continue;
        const full = path.isAbsolute(value[field]) ? path.resolve(value[field]) : path.resolve(root, value[field]);
        if (!within(root, full)) { blockers.push({ root: input.id, file: name, reason: `Receipt ${field} points outside its exact source root` }); continue; }
        const rel = path.relative(root, full).split(path.sep).join('/');
        const log = data.get(rel);
        if (!log) { blockers.push({ root: input.id, file: name, reason: `Receipt ${field} file missing or explicitly excluded` }); continue; }
        if (log.mtimeMs > item.mtimeMs) { blockers.push({ root: input.id, file: rel, reason: 'Log newer than terminal receipt; may be active or reused' }); continue; }
        if (value[byteField] != null && value[byteField] !== log.bytes.length) { blockers.push({ root: input.id, file: rel, reason: 'Terminal receipt byte count no longer matches log' }); continue; }
        if (!logs.has(rel)) logs.set(rel, []); logs.get(rel).push(receipt);
      }
      // Older G7 Git patch receipts use a generic stdout name rather than a .log suffix.
    }
    for (const name of names) {
      if (excluded.has(name)) { exclusions.push({ root: input.id, file: name, reason: excluded.get(name) }); continue; }
      const item = data.get(name), logClosures = logs.get(name) ?? [], closure = receiptByName.get(name);
      if (logLike(name) && logClosures.length === 0) { blockers.push({ root: input.id, file: name, reason: 'Log has no verified terminal command receipt; declare an explicit reasoned exclusion if active' }); continue; }
      entries.push({ sourceRootId: input.id, sourceRoot: root, sourceRelative: name, sourcePath: path.join(root, name), relative: `${input.id}/${name}`, phase: input.phase, materialKind: closure ? 'closed-command-receipt' : logClosures.length ? 'closed-command-output' : 'immutable-source-or-report', closures: closure ? [{ root: input.id, file: name, sha256: item.sha256, ...closure }] : logClosures, originalBytes: item.bytes.length, originalSha256: item.sha256, mtimeMs: item.mtimeMs });
    }
  }
  entries.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
  assert.equal(new Set(entries.map((entry) => entry.relative)).size, entries.length, 'Stable relative prefixes must not collide');
  return { entries, exclusions, blockers, receipts, sourceRootIds: [...prefixes] };
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
  const report = { schemaVersion: 1, releaseSlug: config.releaseSlug, sourceCommit: config.sourceCommit, createdAt: new Date().toISOString(), collectionOnly: true, gatePassDerived: false, productionRequests: 0, evidenceDirectory: config.releaseSlug, entries, exclusions: plan.exclusions, closedReceipts: plan.receipts, roots: config.roots.map(({ id, path, phase }) => ({ id, path, phase })), totals: { files: entries.length, originalBytes: entries.reduce((n, x) => n + x.originalBytes, 0), storedBytes: entries.reduce((n, x) => n + x.storedBytes, 0), gzipFiles: entries.filter((x) => x.encoding === 'gzip').length, nonzeroOrAbnormalReceipts: plan.receipts.filter((x) => x.actualExit !== 0 || x.signal != null || x.spawnError != null).length }, semantics: config.semantics ?? { scope: 'Evidence collection; no complete G7/G8 claim' } };
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
