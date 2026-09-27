// Synthetic, local-only, same harness before/after source edits. Not a Workers,
// gateway, network-receipt, continuous-peak or concurrency acceptance test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';

const shapes = ['ascii', 'mixed', 'replacement', 'mixed-replacement', 'unicode', 'escaped-surrogates'];
const modes = shapes.flatMap(shape => ['cancel', 'drain'].map(terminal => `${shape}/${terminal}`));
const mode = process.argv[2];
if (!mode) {
	for (const candidate of modes) {
		const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=768', '--import', 'tsx', fileURLToPath(import.meta.url), candidate],
			{ encoding: 'utf8', timeout: 60000, windowsHide: true });
		assert.equal(child.status, 0, child.stderr || child.error?.message);
		console.log(JSON.stringify(JSON.parse(child.stdout)));
	}
} else {
	assert.ok(modes.includes(mode));
	globalThis.fetch = async () => { throw new Error('Network forbidden'); };
	const { readImageJsonRequest } = await import('../src/services/image-json-request.ts');
	const { applyOpenAiImageGenerationExtras } = await import('../src/services/image-generation-extras.ts');
	const { createJsonUploadBody } = await import('../src/services/egress/json-upload-body.ts');
	const { MAX_REQUEST_BODY_BYTES } = await import('../src/services/bounded-request-body.ts');
	const [shape, terminal] = mode.split('/'), encoder = new TextEncoder(), decoder = new TextDecoder();
	const prefix = encoder.encode('{"model":"synthetic","prompt":"synthetic","image":"');
	const suffix = encoder.encode(shape === 'mixed' ? 'Ā"}' : '"}');
	const wireSuffix = encoder.encode(shape === 'mixed' ? 'Ā  "}' : '  "}');
	const unit = shape === 'replacement' ? new Uint8Array([255]) : shape === 'mixed-replacement' ? new Uint8Array([65, 255])
		: encoder.encode(shape === 'unicode' ? 'Ā图💡' : shape === 'escaped-surrogates' ? '\\ud800X\\udc00' : 'A');
	const page = new Uint8Array(Math.floor(65536 / unit.length) * unit.length);
	for (let i = 0; i < page.length; i += unit.length) page.set(unit, i);
	const expectedHash = createHash('sha256'), actualHash = createHash('sha256');
	// Both edge pages require trimming. Source bytes include four padding spaces.
	let remaining = MAX_REQUEST_BODY_BYTES - prefix.length - suffix.length - 4, phase = 0, readBytes = 0, expectedBytes = 0;
	const memory = () => { const m = process.memoryUsage(); return { ...m, heapPlusExternal: m.heapUsed + m.external }; };
	global.gc(); const baseline = memory(), observedMaximum = { ...baseline }, stages = { baseline };
	let samples = 0;
	const sample = name => {
		const m = memory(); samples++;
		for (const key of Object.keys(m)) observedMaximum[key] = Math.max(observedMaximum[key], m[key]);
		if (name) stages[name] = m;
	};
	const source = new ReadableStream({ pull(c) {
		sample(); let bytes, expected, last = false;
		if (phase++ === 0) { bytes = new Uint8Array([...prefix, 32, 32]); expected = prefix; }
		else if (remaining) {
			const count = Math.min(page.length, remaining);
			if (count % unit.length) {
				bytes = new Uint8Array(count).fill(65); bytes.set(page.subarray(0, count - count % unit.length));
			} else bytes = page.subarray(0, count);
			remaining -= count; expected = encoder.encode(decoder.decode(bytes, { stream: true }));
		} else { bytes = wireSuffix; expected = suffix; last = true; assert.equal(decoder.decode(), ''); }
		expectedHash.update(expected); expectedBytes += expected.length; readBytes += bytes.length;
		c.enqueue(bytes); if (last) c.close();
	} }, { highWaterMark: 0 });
	const started = performance.now();
	let parsed = await readImageJsonRequest(new Request('https://synthetic.invalid', { method: 'POST', body: source, duplex: 'half' }));
	const parseMs = performance.now() - started;
	sample('afterParse'); global.gc(); sample('parsedHeldAfterGc');
	let upstream = { model: parsed.model, prompt: parsed.prompt };
	applyOpenAiImageGenerationExtras(upstream, parsed);
	sample('afterNormalize'); global.gc(); sample('bothValuesHeldAfterGc');
	parsed = undefined;
	let upload = createJsonUploadBody(upstream, new AbortController().signal, () => {});
	upstream = undefined; assert.equal(upload.contentLength, expectedBytes);
	sample('afterPrepare'); global.gc(); sample('unreadUploadHeldAfterGc');
	let outputBytes = 0, largestChunk = 0;
	if (terminal === 'cancel') upload.dispose();
	else {
		const reader = upload.body.getReader();
		while (true) { const next = await reader.read(); if (next.done) break;
			outputBytes += next.value.length; largestChunk = Math.max(largestChunk, next.value.length); actualHash.update(next.value); sample(); }
		reader.releaseLock(); assert.equal(outputBytes, expectedBytes); assert.equal(actualHash.digest('hex'), expectedHash.digest('hex'));
		assert.ok(largestChunk <= 65536);
	}
	assert.equal(source.locked, false); assert.equal(readBytes, MAX_REQUEST_BODY_BYTES);
	sample('afterTerminal'); upload = undefined;
	await nextTurn(); global.gc(); sample('releasedAfterGc');
	console.log(JSON.stringify({ mode, runtime: process.version, platform: process.platform, readBytes, outputBytes, expectedBytes, largestChunk,
		parseMs, elapsedMs: performance.now() - started, samples, stages, observedMaximum }));
}
