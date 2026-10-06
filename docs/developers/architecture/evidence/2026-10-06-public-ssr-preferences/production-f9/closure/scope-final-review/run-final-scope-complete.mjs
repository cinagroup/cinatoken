import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const executable = 'C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const args = [join(directory, 'complete-final-scope-review.py')];
const startedAt = new Date().toISOString();
const child = spawnSync(executable, args, { cwd: 'C:/cinagroup/cinatoken', encoding: null, windowsHide: true, timeout: 60000 });
const streams = {};
for (const name of ['stdout', 'stderr']) {
 const data = child[name] ?? Buffer.alloc(0);
 const path = join(directory, 'final-scope-complete.' + name + '.log');
 writeFileSync(path, data, { flag: 'wx' });
 streams[name] = { path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}
const receipt = { executable, args, cwd: 'C:/cinagroup/cinatoken', startedAt, finishedAt: new Date().toISOString(), actualExitCode: child.status, signal: child.signal, error: child.error ? String(child.error) : null, streams };
const receiptPath = join(directory, 'final-scope-complete.result.json');
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ receiptPath, ...receipt }));
if(child.stdout?.length) process.stdout.write(child.stdout);
process.exitCode = child.status === 0 && child.signal === null && !child.error ? 0 : 1;
