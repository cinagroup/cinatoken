// Synthetic local JSON pipeline only. No network, credentials, gateway account or DB.
// Stage samples in fresh Node children, NOT a continuous peak or Workers/HTTP proof.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const modes = ['dense-unchecked', 'dense-guarded', 'max-ascii', 'max-unicode-metadata'];
const mode = process.argv[2];
if (!mode) {
	const runs = modes.map(candidate => {
		const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=512', '--import', 'tsx', fileURLToPath(import.meta.url), candidate],
			{ encoding: 'utf8', timeout: 30000, windowsHide: true });
		assert.equal(child.status, 0, child.stderr || child.error?.message);
		return JSON.parse(child.stdout);
	});
	console.log(JSON.stringify({ runtime: process.version, platform: process.platform,
		scope: 'synthetic bounded read, native parse, actual Images normalization, single encoding and unread-body release; discrete observations only', runs }, null, 2));
} else {
	assert.ok(modes.includes(mode));
	globalThis.fetch = async () => { throw new Error('Network is forbidden in this measurement'); };
	const { responseTextWithinLimit } = await import('../src/services/egress/bounded-response-body.ts');
	const { IMAGE_MAX_RESPONSE_BYTES, normalizeOpenRouterImageResponse } = await import('../src/services/egress/openai-images-driver.ts');
	const { IMAGE_JSON_STRUCTURE_LIMITS, JsonStructureBudget, JsonStructureLimitError } = await import('../src/services/json-structure-budget.ts');
	const encode = value => new TextEncoder().encode(value);
	const dense = mode.startsWith('dense-');
	const prefix = encode(dense ? '{"data":[{"b64_json":"AQID"}],"opaque":[' : '{"data":[{"b64_json":"');
	const suffix = encode(dense ? '{}]}' : mode === 'max-unicode-metadata' ? '"}],"label":"Ā"}' : '"}]}');
	const unit = dense ? '{},' : 'A';
	const requestedBytes = dense ? 2 * 1024 * 1024 : IMAGE_MAX_RESPONSE_BYTES;
	const repeats = Math.floor((requestedBytes - prefix.length - suffix.length) / unit.length);
	const block = encode(unit.repeat(Math.floor(65536 / unit.length)));
	const wireBytes = prefix.length + repeats * unit.length + suffix.length;
	let remaining = repeats * unit.length, phase = 0, readBytes = 0, cancels = 0;
	const budget = mode === 'dense-unchecked' ? undefined : new JsonStructureBudget(IMAGE_JSON_STRUCTURE_LIMITS);
	global.gc();
	const baseline = process.memoryUsage(), observedMaximum = { ...baseline }, stages = { baseline };
	const sample = name => {
		const value = process.memoryUsage();
		for (const key of Object.keys(value)) observedMaximum[key] = Math.max(observedMaximum[key], value[key]);
		if (name) stages[name] = value;
	};
	const source = new ReadableStream({ pull(c) {
		sample();
		let chunk, done = false;
		if (phase++ === 0) chunk = prefix;
		else if (remaining) { const size = Math.min(block.length, remaining); remaining -= size; chunk = block.subarray(0, size); }
		else { chunk = suffix; done = true; }
		readBytes += chunk.length; c.enqueue(chunk);
		if (done) c.close();
	}, cancel() { cancels++; } }, { highWaterMark: 0 });
	let text, parsed, normalized, serialized, output, parsedGraph = false, rejected = false;
	const started = performance.now();
	try {
		text = await responseTextWithinLimit(new Response(source), IMAGE_MAX_RESPONSE_BYTES, undefined,
			budget ? chunk => budget.write(chunk) : undefined);
		sample('afterRead');
		parsed = JSON.parse(text); parsedGraph = true; sample('afterParse'); text = undefined;
		normalized = normalizeOpenRouterImageResponse(parsed); sample('afterNormalize'); parsed = undefined;
		serialized = JSON.stringify(normalized); sample('afterEncode');
		output = new Response(serialized); sample('afterResponseCreated');
		assert.equal(readBytes, wireBytes);
	} catch (error) {
		if (mode !== 'dense-guarded' || !(error instanceof JsonStructureLimitError)) throw error;
		rejected = true; sample('rejectedBeforeParse');
	}
	assert.equal(parsedGraph, mode !== 'dense-guarded');
	assert.equal(rejected, mode === 'dense-guarded');
	text = undefined; parsed = undefined; normalized = undefined; serialized = undefined;
	global.gc(); sample('unreadBodyHeldAfterGc');
	await output?.body?.cancel(); output = undefined;
	global.gc(); sample('bodyReleasedAfterGc');
	assert.equal(source.locked, false);
	console.log(JSON.stringify({ mode, wireBytes, readBytes, parsedGraph, rejected, cancels,
		nodeCount: budget?.nodeCount ?? null, elapsedMs: performance.now() - started,
		stages, observedMaximum }));
}
