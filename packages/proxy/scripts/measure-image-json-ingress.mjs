// Local synthetic ingress+upload helpers only; no gateway/DB/Workers/network proof.
// Fresh child for each mode; explicit GC stages and discrete samples, not continuous peaks.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';

const modes = ['native-cache', 'joined-segmented', 'paged-values'].flatMap(implementation =>
	['ascii', 'mixed-string', 'replacement', 'control-mixed'].flatMap(shape => ['cancel', 'drain'].map(terminal => `${implementation}/${shape}/${terminal}`)));
const mode = process.argv[2];
if (!mode) {
	const runs = modes.map(candidate => {
		const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=768', '--import', 'tsx', fileURLToPath(import.meta.url), candidate],
			{ encoding: 'utf8', timeout: 45000, windowsHide: true });
		assert.equal(child.status, 0, child.stderr || child.error?.message); return JSON.parse(child.stdout);
	});
	console.log(JSON.stringify({ runtime: process.version, platform: process.platform,
		scope: '50 MiB synthetic Hono cached json+native outgoing Request vs joined segmented strings+owned JSON upload vs current paged Images values+owned JSON upload. Serialization only, including a prompt now paged before semantic validation; this does not run the public prompt precheck. Discrete/GC observations, not a complete gateway, continuous peak or Workers capacity gate', runs }, null, 2));
} else {
	assert.ok(modes.includes(mode)); globalThis.fetch = async () => { throw new Error('Network forbidden in this measurement'); };
	const { HonoRequest } = await import('hono/request');
	const { readImageJsonRequest } = await import('../src/services/image-json-request.ts');
	const { segmentedJsonResponseWithinLimit } = await import('../src/services/egress/segmented-json-response.ts');
	const { JsonStringPages } = await import('../src/services/egress/json-string-pages.ts');
	const { createJsonUploadBody } = await import('../src/services/egress/json-upload-body.ts');
	const { MAX_REQUEST_BODY_BYTES } = await import('../src/services/bounded-request-body.ts');
	const { createJsonStructureBodyInspector, IMAGE_JSON_STRUCTURE_LIMITS } = await import('../src/services/json-structure-budget.ts');
	const [implementation, shape, terminal] = mode.split('/'), encode = text => new TextEncoder().encode(text);
	const prefix = encode(shape === 'control-mixed' ? '{"model":"synthetic","image":"synthetic","prompt":"' : '{"model":"synthetic","prompt":"synthetic","image":"');
	const suffix = encode(shape === 'mixed-string' || shape === 'control-mixed' ? 'Ā"}' : '"}');
	const page = new Uint8Array(65536).fill(shape === 'replacement' ? 255 : 65);
	const replacement = shape === 'replacement' ? encode('�'.repeat(page.length)) : null;
	const inputHash = createHash('sha256'), outputHash = createHash('sha256');
	const inspector = implementation === 'native-cache' ? createJsonStructureBodyInspector(IMAGE_JSON_STRUCTURE_LIMITS) : null;
	let remaining = MAX_REQUEST_BODY_BYTES - prefix.length - suffix.length, phase = 0, readBytes = 0, expectedBytes = 0;
	global.gc(); const baseline = process.memoryUsage(), observedMaximum = { ...baseline }, stages = { baseline };
	const sample = name => {
		const value = process.memoryUsage();
		for (const key of Object.keys(value)) observedMaximum[key] = Math.max(observedMaximum[key], value[key]);
		if (name) stages[name] = value;
	};
	const source = new ReadableStream({ pull(c) {
		sample(); let bytes, last = false, payload = false;
		if (phase++ === 0) bytes = prefix;
		else if (remaining) { const size = Math.min(page.length, remaining); remaining -= size; bytes = page.subarray(0, size); payload = true; }
		else { bytes = suffix; last = true; }
		const expected = payload && replacement ? replacement.subarray(0, bytes.length * 3) : bytes;
		inputHash.update(expected); expectedBytes += expected.length; readBytes += bytes.length;
		inspector?.write(bytes); c.enqueue(bytes); if (last) { inspector?.end(); inspector?.dispose(); c.close(); }
	} }, { highWaterMark: 0 });
	let hono = new HonoRequest(new Request('https://synthetic.example.invalid', { method: 'POST', body: source, duplex: 'half' }));
	let parsed, upload, output, outputBytes = 0, largestChunk = 0;
	const started = performance.now();
	if (implementation === 'native-cache') parsed = await hono.json();
	else if (implementation === 'joined-segmented') {
		// Do not retain a second wrapper containing body across the release samples.
		parsed = (await segmentedJsonResponseWithinLimit(new Response(hono.raw.body), MAX_REQUEST_BODY_BYTES, IMAGE_JSON_STRUCTURE_LIMITS)).body;
	} else parsed = await readImageJsonRequest(hono.raw);
	assert.equal(parsed.image instanceof JsonStringPages, implementation === 'paged-values' && shape !== 'control-mixed');
	assert.equal(parsed.prompt instanceof JsonStringPages, implementation === 'paged-values' && shape === 'control-mixed');
	sample('afterParse'); global.gc(); sample('parsedAndContextHeldAfterGc');
	if (implementation === 'native-cache') {
		output = new Request('https://synthetic.example.invalid', { method: 'POST', body: JSON.stringify(parsed) });
	} else {
		upload = createJsonUploadBody(parsed, new AbortController().signal, () => {});
		output = new Request('https://synthetic.example.invalid', { method: 'POST', body: upload.body, duplex: 'half' });
		assert.equal(upload.contentLength, expectedBytes);
	}
	sample('afterUploadPrepared'); global.gc(); sample('contextAndUnreadUploadHeldAfterGc');
	const cacheKeys = Object.keys(hono.bodyCache);
	if (implementation !== 'native-cache') assert.deepEqual(cacheKeys, []);
	if (terminal === 'cancel') { if (upload) upload.dispose(); else await output.body.cancel(); }
	else {
		const reader = output.body.getReader();
		while (true) { const next = await reader.read(); if (next.done) break;
			outputBytes += next.value.length; largestChunk = Math.max(largestChunk, next.value.length); outputHash.update(next.value); sample();
		}
		reader.releaseLock(); assert.equal(outputBytes, expectedBytes); assert.equal(outputHash.digest('hex'), inputHash.digest('hex'));
		if (upload) assert.ok(largestChunk <= 65536);
	}
	assert.equal(readBytes, MAX_REQUEST_BODY_BYTES); if (upload) assert.equal(source.locked, false);
	sample('afterTerminal'); parsed = undefined; upload = undefined; output = undefined; hono = undefined;
	global.gc(); sample('releasedSameJobAfterGc');
	await nextTurn(); global.gc(); sample('releasedAfterGc');
	console.log(JSON.stringify({ mode, readBytes, outputBytes, expectedBytes, largestChunk, cacheKeys, ingressReaderLocked: source.locked, elapsedMs: performance.now() - started, stages, observedMaximum }));
}
