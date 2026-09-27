// Synthetic 50 MiB entry/semantic boundary and owned upload only. No gateway,
// real model, DB, Workers or continuous peak evidence; no external network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';

const validShapes = ['padded', 'format', 'legacy-size'];
const accepts = (implementation, shape) => validShapes.includes(shape) && !(implementation === 'deferred-controls' && shape === 'legacy-size');
const modes = ['native-controls', 'deferred-controls'].flatMap(implementation =>
	[...validShapes, 'overflow', 'replacement', 'nested'].flatMap(shape =>
		(accepts(implementation, shape) ? ['cancel', 'drain'] : ['reject']).map(terminal => `${implementation}/${shape}/${terminal}`)));
const mode = process.argv[2];
if (!mode) {
	const runs = modes.map(candidate => {
		const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=768', '--import', 'tsx', fileURLToPath(import.meta.url), candidate],
			{ encoding: 'utf8', timeout: 45000, windowsHide: true });
		assert.equal(child.status, 0, child.stderr || child.error?.message); return JSON.parse(child.stdout);
	});
	console.log(JSON.stringify({ runtime: process.version, platform: process.platform,
		scope: '50 MiB entry+prompt validation+owned upload helpers. Same current parser with the former 15 native controls (reference, NOT a historical checkout) vs current bounded controls; six shapes, 17 fresh processes. Current oversized size must be rejected before materialization. Discrete samples and explicit GC, not gateway/Workers/aggregate capacity evidence.', runs }, null, 2));
} else {
	assert.ok(modes.includes(mode)); globalThis.fetch = async () => { throw new Error('Network forbidden'); };
	const { segmentedJsonResponseWithinLimit } = await import('../src/services/egress/segmented-json-response.ts');
	const { readImageJsonRequest } = await import('../src/services/image-json-request.ts');
	const { ImageControlLimitError } = await import('../src/services/image-control-limits.ts');
	const { normalizeImageGenerationParams } = await import('../src/services/image-generation-params.ts');
	const { normalizeImageCommonParams } = await import('../src/services/egress/openai-images-driver.ts');
	const { createJsonUploadBody } = await import('../src/services/egress/json-upload-body.ts');
	const { JsonStringPages, trimJsonString } = await import('../src/services/egress/json-string-pages.ts');
	const { MAX_REQUEST_BODY_BYTES } = await import('../src/services/bounded-request-body.ts');
	const { IMAGE_JSON_STRUCTURE_LIMITS } = await import('../src/services/json-structure-budget.ts');
	const nativeFields = ['model', 'prompt', 'n', 'size', 'quality', 'background', 'response_format', 'output_format', 'sequential_image_generation', 'stream', 'watermark', 'provider', 'service_tier', 'speed', 'session_id'];
	const [implementation, shape, terminal] = mode.split('/'), encode = value => new TextEncoder().encode(value);
	const largeField = shape === 'format' ? 'response_format' : shape === 'legacy-size' ? 'size' : 'prompt';
	const head = encode('{"model":"synthetic",' + (largeField === 'prompt' ? '' : '"prompt":"synthetic",') + `"${largeField}":` + (shape === 'nested' ? '{"text":"' : '"'));
	const tail = encode(shape === 'nested' ? '"}}' : shape === 'replacement' ? '"}' : (shape === 'padded' ? 'syntheticĀ' : 'Ā') + '"}');
	const page = new Uint8Array(65536).fill(shape === 'padded' ? 32 : shape === 'replacement' ? 255 : 65);
	const retainedField = shape === 'format' || shape === 'legacy-size';
	const expectedHash = createHash('sha256'), actualHash = createHash('sha256');
	let expectedBytes = 0;
	const expect = bytes => { expectedHash.update(bytes); expectedBytes += Buffer.byteLength(bytes); };
	if (retainedField) expect(`{"model":"synthetic","prompt":"synthetic","n":1,"${largeField}":"`);
	else if (shape === 'padded') expect('{"model":"synthetic","prompt":"syntheticĀ","n":1}');
	let materializedChars = 0;
	const materialize = JsonStringPages.prototype.materialize;
	JsonStringPages.prototype.materialize = function() { materializedChars = Math.max(materializedChars, this.length); return materialize.call(this); };
	global.gc(); const baseline = process.memoryUsage(), observedMaximum = { ...baseline }, stages = { baseline };
	const sample = name => { const memory = process.memoryUsage();
		for (const key of Object.keys(memory)) observedMaximum[key] = Math.max(observedMaximum[key], memory[key]);
		if (name) stages[name] = memory;
	};
	let remaining = MAX_REQUEST_BODY_BYTES - head.length - tail.length, phase = 0, readBytes = 0;
	const source = new ReadableStream({ pull(c) {
		sample(); let bytes, last = false;
		if (phase++ === 0) bytes = head;
		else if (remaining) { const size = Math.min(page.length, remaining); remaining -= size; bytes = page.subarray(0, size); if (retainedField) expect(bytes); }
		else { bytes = tail; last = true; if (retainedField) expect('Ā"}'); }
		readBytes += bytes.length; c.enqueue(bytes); if (last) c.close();
	} }, { highWaterMark: 0 });
	let request = new Request('https://synthetic.example.invalid', { method: 'POST', body: source, duplex: 'half' });
	let parsed, common, wireBody, upload, output, outputBytes = 0, largestChunk = 0, validationError = null;
	const started = performance.now();
	try {
		parsed = implementation === 'native-controls'
			? (await segmentedJsonResponseWithinLimit(new Response(request.body), MAX_REQUEST_BODY_BYTES, IMAGE_JSON_STRUCTURE_LIMITS, request.signal, { retainStringPages: true, nativeStringFields: nativeFields })).body
			: await readImageJsonRequest(request);
	} catch (error) {
		assert.equal(implementation, 'deferred-controls'); assert.equal(shape, 'legacy-size');
		assert.ok(error instanceof ImageControlLimitError); assert.equal(error.message, 'size must be at most 64 characters');
		validationError = error.message;
	}
	sample('afterParse'); global.gc(); sample('parsedAfterGc');
	common = validationError ? { ok: false, error: validationError }
		: implementation === 'native-controls' ? normalizeImageCommonParams(parsed) : normalizeImageGenerationParams(parsed);
	assert.equal(common.ok, accepts(implementation, shape));
	if (common.ok) {
		assert.equal(common.prompt, shape === 'padded' ? 'syntheticĀ' : 'synthetic');
		parsed.prompt = common.prompt; // Mirror the public route before awaiting Guardrails.
		wireBody = { model: parsed.model, prompt: common.prompt, n: common.n,
			...(shape === 'legacy-size' ? { size: common.size } : {}),
			...(shape === 'format' ? { response_format: trimJsonString(parsed.response_format) } : {}) };
	} else {
		validationError = common.error;
		assert.equal(common.error, shape === 'legacy-size' ? 'size must be at most 64 characters'
			: shape === 'nested' ? 'prompt is required' : 'prompt must be at most 4000 characters');
	}
	sample('afterSemanticBoundary'); global.gc(); sample('semanticHeldAfterGc');
	if (common.ok) {
		upload = createJsonUploadBody(wireBody, request.signal, () => {});
		assert.equal(upload.contentLength, expectedBytes);
		output = new Request('https://synthetic.example.invalid', { method: 'POST', body: upload.body, duplex: 'half' });
		sample('afterUploadPrepared'); global.gc(); sample('unreadUploadAfterGc');
		if (terminal === 'cancel') upload.dispose();
		else {
			const reader = output.body.getReader();
			while (true) { const next = await reader.read(); if (next.done) break;
				outputBytes += next.value.length; largestChunk = Math.max(largestChunk, next.value.length); actualHash.update(next.value); sample();
			}
			reader.releaseLock(); assert.equal(outputBytes, expectedBytes); assert.equal(actualHash.digest('hex'), expectedHash.digest('hex')); assert.ok(largestChunk <= 65536);
		}
	}
	assert.equal(readBytes, MAX_REQUEST_BODY_BYTES); assert.equal(source.locked, false);
	if (implementation === 'deferred-controls') assert.ok(materializedChars <= 4000);
	sample('afterTerminal'); parsed = undefined; common = undefined; wireBody = undefined; upload = undefined; output = undefined; request = undefined;
	global.gc(); sample('releasedSameJobAfterGc'); await nextTurn(); global.gc(); sample('releasedAfterGc');
	console.log(JSON.stringify({ mode, readBytes, outputBytes, expectedBytes, largestChunk, materializedChars, validationError,
		ingressReaderLocked: source.locked, elapsedMs: performance.now() - started, stages, observedMaximum }));
}
