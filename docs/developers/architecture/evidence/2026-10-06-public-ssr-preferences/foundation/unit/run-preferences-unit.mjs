import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const output = 'C:/Users/cina/AppData/Local/Temp/cinatoken-public-early-controls-review-8316d33a4c54478ba04118ab45d0560e/unit-verification';
const root = 'C:/cinagroup/cinatoken';
const commands = [
  { label: 'format', args: [join(root, 'packages/web/node_modules/prettier/bin/prettier.cjs'), '--write', 'src/cinatoken/public/ssr/public-preferences.test.ts'], cwd: join(root, 'packages/web') },
  { label: 'unit', args: ['--import', 'tsx', '--test', 'packages/web/src/cinatoken/public/ssr/public-preferences.test.ts'], cwd: root, env: { TSX_TSCONFIG_PATH: join(root, 'packages/web/tsconfig.test.json') } },
];
for (const command of commands) {
  const startedAt = new Date().toISOString();
  const child = spawnSync(process.execPath, command.args, { cwd: command.cwd, env: { ...process.env, ...command.env }, encoding: null, windowsHide: true, timeout: 90000 });
  const endedAt = new Date().toISOString();
  const streams = {};
  for (const stream of ['stdout', 'stderr']) {
    const data = child[stream] ?? Buffer.alloc(0);
    const file = join(output, command.label + '.' + stream + '.log');
    writeFileSync(file, data, { flag: 'wx' });
    streams[stream] = { path: file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  }
  const receipt = { command: { executable: process.execPath, args: command.args, cwd: command.cwd, environmentKeys: Object.keys(command.env ?? {}) }, startedAt, endedAt, actualExitCode: child.status, signal: child.signal, error: child.error ? String(child.error) : null, streams };
  writeFileSync(join(output, command.label + '.result.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(receipt));
  if (child.status !== 0 || child.signal || child.error) process.exitCode = 1;
}
