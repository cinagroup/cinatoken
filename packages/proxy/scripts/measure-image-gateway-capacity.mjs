/** Local full Images gateway probe, NOT Workers/financial DB acceptance or production weights.
 * Client and synthetic upstream run in this parent; only the bundled gateway is measured.
 * Bounded wire generators, native HTTP backpressure, no body-argument mock history.
 */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const smoke = process.argv.includes('--smoke');
assert.ok(process.argv.slice(2).every(arg => arg === '--smoke'));
const MiB = 1024 ** 2, inputBytes = smoke ? 128 * 1024 : 50 * MiB, upstreamBytes = smoke ? 128 * 1024 : 32 * MiB;
mkdirSync(join(root, 'dist'), { recursive: true });
const generated = mkdtempSync(join(root, 'dist', 'capacity-probe-'));
const entry = join(generated, 'gateway.mjs');
await build({ entryPoints: [join(root, 'src/test-support/image-capacity-process.ts')], bundle: true, platform: 'node', format: 'esm',
	outfile: entry, logLevel: 'warning', plugins: [{ name: 'workspace-bundling', setup(builder) {
		builder.onResolve({ filter: /^[^./]/ }, args => args.kind === 'entry-point' || args.path.startsWith('@octafuse/') ? undefined : { path: args.path, external: true });
	} }] });

function* filled(bytes, value = 65) {
	const page = Buffer.alloc(64 * 1024, value);
	while (bytes > 0) { const count = Math.min(page.length, bytes); yield page.subarray(0, count); bytes -= count; }
}
function* jsonInput() {
	const start = '{"model":"image-model","prompt":"test","image":"data:image/png;base64,', end = '"}';
	yield Buffer.from(start); yield* filled(inputBytes - Buffer.byteLength(start + end)); yield Buffer.from(end);
}
const boundary = 'cinatoken-capacity-synthetic-boundary';
function* multipartInput() {
	const fields = `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nimage-model\r\n--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\ntest\r\n`;
	const headers = [0, 1, 2].map(i => `--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="${i}.png"\r\nContent-Type: image/png\r\n\r\n`);
	const end = `--${boundary}--\r\n`;
	let remaining = inputBytes - Buffer.byteLength(fields + headers.join('') + '\r\n'.repeat(3) + end);
	yield Buffer.from(fields);
	for (let i = 0; i < 3; i++) {
		const count = Math.min(20 * MiB, inputBytes > 40 * MiB ? remaining : Math.ceil(remaining / (3 - i))); remaining -= count;
		yield Buffer.from(headers[i]); yield* filled(count); yield Buffer.from('\r\n');
	}
	assert.equal(remaining, 0); yield Buffer.from(end);
}
const usage = { input_tokens: 3, output_tokens: 7, detail: 'U'.repeat(60 * 1024) };
function responseShape(replacement, normalized) {
	const measuredUsage = normalized ? { ...usage, prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 } : usage;
	return replacement
		? { start: '{"data":[{"b64_json":"AQID"}],"metadata":"', end: '","usage":' + JSON.stringify(measuredUsage) + '}' }
		: { start: '{"data":[{"b64_json":"', end: '"}],"usage":' + JSON.stringify(measuredUsage) + '}' };
}
function* upstreamBody(replacement) {
	const { start, end } = responseShape(replacement, false);
	yield Buffer.from(start); yield* filled(upstreamBytes - Buffer.byteLength(start + end), replacement ? 255 : 65); yield Buffer.from(end);
}
function expectedBody(replacement) {
	const original = responseShape(replacement, false), normalized = responseShape(replacement, true);
	const count = upstreamBytes - Buffer.byteLength(original.start + original.end), hash = createHash('sha256');
	hash.update(normalized.start);
	if (!replacement) for (const chunk of filled(count)) hash.update(chunk);
	else {
		const page = Buffer.from('\ufffd'.repeat(16 * 1024));
		for (let remaining = count; remaining > 0; remaining -= 16 * 1024) hash.update(page.subarray(0, Math.min(remaining, 16 * 1024) * 3));
	}
	hash.update(normalized.end);
	return { bytes: Buffer.byteLength(normalized.start + normalized.end) + count * (replacement ? 3 : 1), sha256: hash.digest('hex') };
}
async function writeChunks(stream, chunks) {
	for (const chunk of chunks) if (!stream.write(chunk)) await once(stream, 'drain');
	stream.end();
}
function startClient(port, operation, unread) {
	let resolveHeaders, rejectHeaders;
	const headers = new Promise((resolve, reject) => { resolveHeaders = resolve; rejectHeaders = reject; });
	const req = request({ hostname: '127.0.0.1', port, path: `/v1/images/${operation}`, method: 'POST', agent: false, headers: {
		Authorization: 'Bearer synthetic-client-key', 'Content-Length': inputBytes,
		'Content-Type': operation === 'edits' ? `multipart/form-data; boundary=${boundary}` : 'application/json',
	} });
	req.on('error', rejectHeaders);
	const done = new Promise((resolve, reject) => {
		req.on('error', reject);
		req.on('response', res => {
			resolveHeaders(res);
			if (unread) { res.pause(); resolve(null); return; }
			const hash = createHash('sha256'); let bytes = 0;
			res.on('data', chunk => { bytes += chunk.length; hash.update(chunk); });
			res.on('error', reject); res.on('end', () => resolve({ bytes, sha256: hash.digest('hex') }));
		});
	});
	void done.catch(() => {}); void headers.catch(() => {});
	const sent = writeChunks(req, operation === 'edits' ? multipartInput() : jsonInput()); void sent.catch(() => {});
	return { req, headers, done, sent };
}

const cases = [
	{ name: 'json-ascii-drain-1', operation: 'generations', concurrency: 1, replacement: false, unread: false },
	{ name: 'json-replacement-drain-1', operation: 'generations', concurrency: 1, replacement: true, unread: false },
	{ name: 'multipart-ascii-drain-1', operation: 'edits', concurrency: 1, replacement: false, unread: false },
	{ name: 'json-ascii-unread-1', operation: 'generations', concurrency: 1, replacement: false, unread: true },
	{ name: 'json-ascii-drain-2', operation: 'generations', concurrency: 2, replacement: false, unread: false },
	{ name: 'json-replacement-unread-2', operation: 'generations', concurrency: 2, replacement: true, unread: true },
];
console.log(JSON.stringify({ kind: 'configuration', node: process.version, platform: process.platform, arch: process.arch, smoke,
	inputBytes, upstreamBytes, cases: cases.length, note: 'Synthetic SQL acknowledgement; no real DB/Workers. Sampled peaks can miss synchronous peaks; OS maxRSS includes startup. arrayBuffers is part of external. --expose-gc only used after terminal.' }));
for (const scenario of cases) {
	const upstreamStats = { requests: 0, requestBytes: [], responseBytes: 0, errors: 0 };
	const upstream = createServer(async (req, res) => {
		try {
			assert.equal(req.url, `/v1/images/${scenario.operation}`); assert.equal(req.headers.authorization, 'Bearer synthetic-provider-key');
			upstreamStats.requests++; let bytes = 0;
			for await (const chunk of req) bytes += chunk.length;
			assert.equal(bytes, Number(req.headers['content-length'])); assert.ok(Math.abs(bytes - inputBytes) < 2048);
			upstreamStats.requestBytes.push(bytes);
			res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': upstreamBytes });
			await writeChunks(res, upstreamBody(scenario.replacement)); upstreamStats.responseBytes += upstreamBytes;
		} catch { upstreamStats.errors++; res.destroy(); }
	});
	await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
	const config = { upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, concurrency: scenario.concurrency, operation: scenario.operation };
	const child = fork(entry, [JSON.stringify(config)], { windowsHide: true, execArgv: ['--expose-gc', '--max-old-space-size=768'],
		env: Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
		stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
	let stderrBytes = 0; child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
	let sequence = 0; const pending = new Map();
	const ready = new Promise((resolve, reject) => {
		child.on('message', message => {
			if (message.event === 'ready') resolve(message);
			else if (pending.has(message.id)) { const item = pending.get(message.id); pending.delete(message.id); message.error ? item.reject(new Error(message.error)) : item.resolve(message); }
		});
		child.once('error', reject);
		child.once('exit', code => { const error = new Error(`Gateway child exited (${code})`); reject(error); for (const item of pending.values()) item.reject(error); pending.clear(); });
	});
	const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
	const rpc = command => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ id, command }); });
	const deadline = setTimeout(() => child.kill(), 90000); deadline.unref();
	const clients = [];
	try {
		const boot = await ready, baseline = await rpc('reset'), stages = {};
		for (let i = 0; i < scenario.concurrency; i++) clients.push(startClient(boot.port, scenario.operation, scenario.unread));
		const responses = await Promise.all(clients.map(client => client.headers));
		for (const response of responses) assert.equal(response.statusCode, 200);
		await Promise.all(clients.map(client => client.sent));
		const until = async predicate => {
			const end = Date.now() + 15000;
			for (;;) { const state = await rpc('status'); if (predicate(state)) return state; assert.ok(Date.now() < end, 'Gateway state did not settle'); await delay(25); }
		};
		stages.responseAndAccounting = await until(state => state.stats.batchesStarted === scenario.concurrency);
		assert.equal(stages.responseAndAccounting.pool.requests, scenario.concurrency);
		const beforeDenials = stages.responseAndAccounting.stats;
		await Promise.all(Array.from({ length: 20 }, async () => {
			const res = await fetch(`http://127.0.0.1:${boot.port}/health`);
			assert.equal(res.status, 503); assert.equal(res.headers.get('X-OctaFuse-Error-Code'), 'gateway.capacity_unavailable'); await res.arrayBuffer();
		}));
		stages.denials = await rpc('status'); assert.deepEqual(stages.denials.stats, beforeDenials);
		let delivered = null;
		if (scenario.unread) { for (const response of responses) response.destroy(); for (const client of clients) client.req.destroy(); }
		else {
			delivered = await Promise.all(clients.map(client => client.done));
			for (const body of delivered) assert.deepEqual(body, expectedBody(scenario.replacement));
		}
		stages.deliveryEndedAccountingHeld = await rpc('status');
		assert.equal(stages.deliveryEndedAccountingHeld.pool.requests, scenario.concurrency);
		assert.equal(stages.deliveryEndedAccountingHeld.stats.batchesCompleted, 0);
		await rpc('release'); stages.terminal = await until(state => state.pool.requests === 0 && state.pendingBackground === 0);
		assert.equal(stages.terminal.stats.batchesCompleted, scenario.concurrency); assert.equal(stages.terminal.sends, scenario.concurrency);
		assert.equal(stages.terminal.errors, 0); assert.equal(upstreamStats.errors, 0); assert.equal(upstreamStats.requests, scenario.concurrency);
		stages.afterForcedGc = await rpc('gc');
		await rpc('close'); const exit = await exited; assert.equal(exit.code, 0); assert.equal(stderrBytes, 0);
		console.log(JSON.stringify({ kind: 'case', ...scenario, baseline, stages, delivered, upstreamStats, exit }));
	} finally {
		clearTimeout(deadline); for (const client of clients) client.req.destroy();
		if (child.exitCode === null && child.signalCode === null) child.kill(); await exited;
		upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
	}
}
