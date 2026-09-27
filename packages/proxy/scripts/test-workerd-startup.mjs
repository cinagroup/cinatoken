// Direct native-runtime diagnostic, NOT an application/production capacity test.
// Two bounded child runs, no Miniflare, sockets, downloads, credentials or external I/O.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

assert.equal(process.argv.length, 2, 'No runtime flags or external configuration are accepted');
const require = createRequire(import.meta.url);
const workerd = require('workerd');
const binary = workerd.default;
assert.equal(typeof binary, 'string');
const report = { schemaVersion: 1, node: process.version, platform: process.platform, arch: process.arch,
	workerdVersion: workerd.version, binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
	network: 'disabled; no listening sockets; empty network allow list', cases: [] };
for (const name of ['plain', 'compatible']) {
	const config = fileURLToPath(new URL(`./fixtures/workerd-startup/${name}.capnp`, import.meta.url));
	const start = performance.now();
	const run = spawnSync(binary, ['test', config], { windowsHide: true, timeout: 15000, maxBuffer: 32 * 1024, encoding: 'utf8',
		env: Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) });
	const output = (run.stdout ?? '') + (run.stderr ?? '');
	const moduleEntered = output.includes('CINATOKEN_RUNTIME_MODULE_ENTERED');
	const testEntered = output.includes('CINATOKEN_RUNTIME_TEST_ENTERED');
	const passed = run.status === 0 && output.includes('CINATOKEN_RUNTIME_TEST_PASSED');
	const status = passed ? 'LOCAL_RUNTIME_SMOKE_PASS' : run.error ? 'PROCESS_ERROR'
		: !moduleEntered ? 'FAILED_BEFORE_MODULE_MARKER' : !testEntered ? 'FAILED_BEFORE_TEST_MARKER' : 'TEST_FAILED';
	report.cases.push({ name, status, moduleEntered, testEntered, passed, exitCode: run.status, signal: run.signal,
		errorCode: run.error?.code ?? null, elapsedMs: Math.round(performance.now() - start), output });
}
console.log(JSON.stringify(report, null, 2));
if (report.cases.some(result => !result.passed)) process.exitCode = 1;
