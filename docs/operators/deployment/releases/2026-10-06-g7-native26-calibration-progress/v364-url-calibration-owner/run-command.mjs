import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = path.dirname(fileURLToPath(import.meta.url));
const [label, program, ...args] = process.argv.slice(2);
assert.ok(/^[a-z0-9-]+$/u.test(label));
assert.ok(['rg', 'C:/Users/cina/AppData/Local/OpenAI/Codex/bin/f1e5e36960c35938/rg.exe', 'git', process.execPath, 'node', 'C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'].includes(program));
const startedAt = new Date().toISOString();
const child = spawnSync(program, args, { cwd: 'C:/cinagroup/cinatoken', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
const finishedAt = new Date().toISOString();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const streams = {};
for (const stream of ['stdout', 'stderr']) {
  const bytes = child[stream] ?? Buffer.alloc(0), full = path.join(root, `${label}.${stream}.txt`);
  fs.writeFileSync(full, bytes, { flag: 'wx' }); streams[stream] = { path: full, bytes: bytes.length, sha256: digest(bytes) };
}
const receipt = { closed: true, actualExit: child.status, signal: child.signal,
  spawnError: child.error ? { code: child.error.code, name: child.error.name } : null,
  executable: program, args, cwd: 'C:/cinagroup/cinatoken', startedAt, finishedAt, ...streams,
  operation: 'local-source-preparation', realServiceOrCiExecution: false, productionRequests: 0 };
fs.writeFileSync(path.join(root, `${label}.result.json`), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(receipt) + '\n');
process.stdout.write(child.stdout ?? Buffer.alloc(0)); process.stderr.write(child.stderr ?? Buffer.alloc(0));
assert.ok(Number.isSafeInteger(child.status), 'No inferred child exit');
assert.equal(child.signal, null); assert.equal(child.error, undefined);
assert.ok([0, 1].includes(child.status), 'Unexpected read command error');
