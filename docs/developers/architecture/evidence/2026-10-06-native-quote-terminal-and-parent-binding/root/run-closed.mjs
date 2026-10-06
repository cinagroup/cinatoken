import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const directory = path.dirname(fileURLToPath(import.meta.url));
const [name, key, ...args] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(name ?? '')) throw new Error('Invalid command record name');
const commands = {
  git: ['C:/Program Files/Git/cmd/git.exe'],
  gh: ['C:/Program Files/GitHub CLI/gh.exe'],
  node: ['C:/Program Files/nodejs/node.exe'],
  npm: ['C:/Program Files/nodejs/node.exe', 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js'],
};
if (!commands[key]) throw new Error('Unknown executable');
const stdout = path.join(directory, name + '.stdout.log');
const stderr = path.join(directory, name + '.stderr.log');
const resultPath = path.join(directory, name + '.result.json');
const out = fs.openSync(stdout, 'wx');
const err = fs.openSync(stderr, 'wx');
const at = new Date().toISOString();
const [executable, ...prefix] = commands[key];
const child = spawn(executable, [...prefix, ...args], {
  cwd: 'C:/cinagroup/cinatoken', windowsHide: true,
  env: { ...process.env, WRANGLER_LOG_PATH: path.join(directory, name + '.wrangler.log'), WRANGLER_SEND_METRICS: 'false' },
  stdio: ['ignore', out, err],
});
let spawnError;
child.once('error', error => { spawnError = error.code ?? 'spawn_error'; });
const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ actualExit: code, signal })));
fs.closeSync(out); fs.closeSync(err);
const describe = filename => {
  const bytes = fs.readFileSync(filename);
  return { path: filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};
const record = { at, finishedAt: new Date().toISOString(), executable, args: [...prefix, ...args], cwd: 'C:/cinagroup/cinatoken', ...result, ...(spawnError ? { spawnError } : {}), stdout: describe(stdout), stderr: describe(stderr) };
fs.writeFileSync(resultPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ ...record, resultPath, stdoutLastLines: fs.readFileSync(stdout, 'utf8').split(/\r?\n/).slice(-15), stderrLastLines: fs.readFileSync(stderr, 'utf8').split(/\r?\n/).slice(-10) }));
process.exitCode = result.actualExit ?? 1;
