import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const root = "C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-next-eight-repair-0511920406eb4b37baca7e103b9080d5";
const [label, command, ...args] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/u.test(label ?? '')) throw new Error('safe label required');
const executable = command === 'node' ? process.execPath : command;
const startedAt = new Date().toISOString();
const child = spawn(executable, args, { cwd: 'C:/cinagroup/cinatoken', windowsHide: true, shell: false });
const chunks = { stdout: [], stderr: [] };
child.stdout.on('data', chunk => chunks.stdout.push(chunk));
child.stderr.on('data', chunk => chunks.stderr.push(chunk));
let spawnError = null;
child.once('error', error => { spawnError = String(error); });
const outcome = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
const finishedAt = new Date().toISOString();
await writeFile(join(root, `${label}.stdout.log`), Buffer.concat(chunks.stdout), { flag: 'wx' });
await writeFile(join(root, `${label}.stderr.log`), Buffer.concat(chunks.stderr), { flag: 'wx' });
const receipt = { label, executable, args, cwd: 'C:/cinagroup/cinatoken', startedAt, finishedAt,
  actualExit: outcome.code, signal: outcome.signal, spawnError, childClosed: true,
  stdout: `${label}.stdout.log`, stderr: `${label}.stderr.log` };
await writeFile(join(root, `${label}.closed.json`), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ ...receipt, stdoutTail: Buffer.concat(chunks.stdout).toString('utf8').split('\n').slice(-30).join('\n'), stderrTail: Buffer.concat(chunks.stderr).toString('utf8').slice(-2000) }) + '\n');
process.exitCode = outcome.code ?? 1;
