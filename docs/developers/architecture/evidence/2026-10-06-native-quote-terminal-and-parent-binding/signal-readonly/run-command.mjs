import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const root = 'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-request-signal-readonly-yCKd6V';
const commands = {
  python: 'C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',
  node: 'C:/Program Files/nodejs/node.exe',
};
const [label, command, ...args] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(label ?? '') || !commands[command]) throw new Error('Invalid owned command');
if (!args.length || path.dirname(path.resolve(args[0])) !== path.resolve(root)) throw new Error('Only new owned scripts may execute');
const stdoutFile = path.join(root, `${label}.stdout.log`);
const stderrFile = path.join(root, `${label}.stderr.log`);
const resultFile = path.join(root, `${label}.result.json`);
for (const file of [stdoutFile, stderrFile, resultFile]) if (fs.existsSync(file)) throw new Error('Refusing overwrite');
const stdoutFd = fs.openSync(stdoutFile, 'wx');
const stderrFd = fs.openSync(stderrFile, 'wx');
const beganAt = new Date().toISOString();
let timedOut = false;
let spawnError = null;
const child = spawn(commands[command], args, { cwd: root, windowsHide: true, stdio: ['ignore', stdoutFd, stderrFd] });
const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 180000);
child.on('error', error => { spawnError = { name: error.name, code: error.code ?? null }; });
child.on('close', (code, signal) => {
  clearTimeout(timer);
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  const descriptor = file => {
    const bytes = fs.readFileSync(file);
    return { path: file.replaceAll('\\', '/'), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  };
  const result = {
    schema: 'cinatoken-owned-opaque-snapshot-command-closed-v1',
    closed: true, beganAt, endedAt: new Date().toISOString(), program: commands[command], args, cwd: root,
    actualExit: code, signal, spawnError, timedOut,
    stdout: descriptor(stdoutFile), stderr: descriptor(stderrFile),
    collectionOnly: true, applicationExecution: false, ciExecution: false, gatePassDerived: false,
  };
  fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ receipt: resultFile, closed: true, actualExit: code, signal, timedOut, collectionOnly: true }));
  process.exitCode = Number.isInteger(code) && !signal && !spawnError && !timedOut ? code : 1;
});
