// Synthetic local read/parse/normalization/encoding only; no gateway/Workers/DB/network proof.
// Fresh child per mode, discrete allocation samples, not a continuous peak measurement.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const modes = ['whole', 'bounded'].flatMap(encoder => ['ascii', 'unicode'].flatMap(shape =>
	['cancel', 'drain'].map(terminal => `${encoder}/${shape}/${terminal}`)));
const mode = process.argv[2];
if (!mode) {
	const runs = modes.map(candidate => {
		const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=512', '--import', 'tsx', fileURLToPath(import.meta.url), candidate],
			{ encoding: 'utf8', timeout: 30000, windowsHide: true });
		assert.equal(child.status, 0, child.stderr || child.error?.message);
		return JSON.parse(child.stdout);
	});
	console.log(JSON.stringify({ runtime: process.version, platform: process.platform,
		scope: '32 MiB synthetic guarded read, native parse, actual Images normalization; whole vs bounded output, unread/terminal GC samples; no network or continuous peak', runs }, null, 2));
} else {
	assert.ok(modes.includes(mode));
	globalThis.fetch = async () => { throw new Error('Network is forbidden in this measurement'); };
	const { responseTextWithinLimit } = await import('../src/services/egress/bounded-response-body.ts');
	const { IMAGE_MAX_RESPONSE_BYTES, normalizeOpenRouterImageResponse } = await import('../src/services/egress/openai-images-driver.ts');
	const { streamJsonResponse, JSON_OUTPUT_PAGE_BYTES } = await import('../src/services/egress/stream-json-body.ts');
	const { IMAGE_JSON_STRUCTURE_LIMITS, JsonStructureBudget } = await import('../src/services/json-structure-budget.ts');
	const [encoder, shape, terminal] = mode.split('/'), encode = value => new TextEncoder().encode(value);
	const prefix = encode('{"data":[{"b64_json":"'), suffix = encode(shape === 'unicode' ? '"}],"label":"Ā"}' : '"}]}');
	const page = new Uint8Array(JSON_OUTPUT_PAGE_BYTES).fill(65), inputHash = createHash('sha256'), outputHash = createHash('sha256');
	let remaining = IMAGE_MAX_RESPONSE_BYTES - prefix.length - suffix.length, phase = 0, readBytes = 0;
	const budget = new JsonStructureBudget(IMAGE_JSON_STRUCTURE_LIMITS);
	global.gc();
	const baseline = process.memoryUsage(), observedMaximum = { ...baseline }, stages = { baseline };
	const sample = name => {
		const value = process.memoryUsage();
		for (const key of Object.keys(value)) observedMaximum[key] = Math.max(observedMaximum[key], value[key]);
		if (name) stages[name] = value;
	};
	const source = new ReadableStream({ pull(c) {
		sample(); let chunk, done = false;
		if (phase++ === 0) chunk = prefix;
		else if (remaining) { const size = Math.min(page.length, remaining); remaining -= size; chunk = page.subarray(0, size); }
		else { chunk = suffix; done = true; }
		inputHash.update(chunk); readBytes += chunk.length; c.enqueue(chunk); if (done) c.close();
	} }, { highWaterMark: 0 });
	let text, parsed, normalized, serialized, output, outputBytes = 0, maxOutputChunk = 0, finished = 0;
	const started = performance.now();
	text = await responseTextWithinLimit(new Response(source), IMAGE_MAX_RESPONSE_BYTES, undefined, text => budget.write(text));
	sample('afterRead'); parsed = JSON.parse(text); sample('afterParse'); text = undefined;
	normalized = normalizeOpenRouterImageResponse(parsed); sample('afterNormalize'); parsed = undefined;
	if (encoder === 'whole') {
		serialized = JSON.stringify(normalized); sample('afterWholeString'); output = new Response(serialized);
	} else output = streamJsonResponse(normalized, { maxDepth: 64, maxNodes: 3 * IMAGE_JSON_STRUCTURE_LIMITS.maxNodes + 16 }, {}, { onFinished: () => { finished++; } });
	sample('afterResponseCreated'); normalized = undefined; serialized = undefined;
	global.gc(); sample('unreadBodyHeldAfterGc');
	if (terminal === 'cancel') await output.body.cancel();
	else {
		const reader = output.body.getReader();
		while (true) {
			const next = await reader.read(); if (next.done) break;
			outputBytes += next.value.length; maxOutputChunk = Math.max(maxOutputChunk, next.value.length);
			outputHash.update(next.value); sample();
		}
		reader.releaseLock(); assert.equal(outputBytes, IMAGE_MAX_RESPONSE_BYTES);
		assert.equal(outputHash.digest('hex'), inputHash.digest('hex'));
		if (encoder === 'bounded') assert.ok(maxOutputChunk <= JSON_OUTPUT_PAGE_BYTES);
	}
	assert.equal(readBytes, IMAGE_MAX_RESPONSE_BYTES); assert.equal(source.locked, false);
	if (encoder === 'bounded') assert.equal(finished, 1);
	sample('afterTerminal'); output = undefined; global.gc(); sample('bodyReleasedAfterGc');
	console.log(JSON.stringify({ mode, readBytes, outputBytes, maxOutputChunk, finished,
		elapsedMs: performance.now() - started, stages, observedMaximum }));
}
