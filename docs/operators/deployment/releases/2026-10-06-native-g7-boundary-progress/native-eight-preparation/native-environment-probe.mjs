import { spawnSync } from 'node:child_process';
const names = ['postgres', 'initdb', 'pg_ctl', 'docker'];
const results = names.map(name => { const child = spawnSync('C:/Windows/System32/where.exe', [name], { encoding: 'utf8', windowsHide: true }); return { name, actualExit: child.status, signal: child.signal, error: child.error ? String(child.error) : null, stdout: child.stdout ?? '', stderr: child.stderr ?? '' }; });
process.stdout.write(JSON.stringify({ platform: process.platform, GATEWAY_NATIVE_PG_BIN_present: Boolean(process.env.GATEWAY_NATIVE_PG_BIN), availableCommands: results, nativeFixtureExecuted: false, skipNeverCountedAsPass: true }) + '\n');
