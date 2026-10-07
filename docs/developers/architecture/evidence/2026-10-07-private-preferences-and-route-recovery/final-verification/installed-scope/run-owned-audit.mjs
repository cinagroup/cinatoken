import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const output = dirname(fileURLToPath(import.meta.url));
const label = process.argv[2];
assert.match(label ?? '', /^[a-z0-9][a-z0-9-]{0,63}$/);
const args = [join(output, 'audit-migration-scope.mjs'), ...process.argv.slice(2)];
const startedAt = new Date().toISOString();
const child = spawnSync(process.execPath, args, { cwd: 'C:/cinagroup/cinatoken', encoding: null, windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
const streams = {};
for (const name of ['stdout', 'stderr']) {
  const bytes = child[name] ?? Buffer.alloc(0);
  const path = join(output, label + '.audit.' + name + '.log');
  writeFileSync(path, bytes, { flag: 'wx' });
  streams[name] = { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const receipt = { executable: process.execPath, args, cwd: 'C:/cinagroup/cinatoken', startedAt, endedAt: new Date().toISOString(), actualExitCode: child.status, signal: child.signal, error: child.error ? String(child.error) : null, streams };
const receiptPath = join(output, label + '.audit.result.json');
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ receiptPath, ...receipt }));
if (child.stdout?.length) process.stdout.write(child.stdout);
process.exitCode = child.status === 0 && child.signal === null && !child.error ? 0 : 1;
