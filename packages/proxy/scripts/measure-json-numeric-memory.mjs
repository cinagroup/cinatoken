// Synthetic 50 MiB scalar parsing only: no gateway, DB, provider or network.
// Whole-text control is deliberately NOT a historical checkout or peak proof.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';

const modes = ['whole-text-control', 'bounded-scalar'].flatMap(mode =>
	['integer', 'balanced', 'exponent', 'invalid-tail'].map(shape => `${mode}/${shape}`));
const mode = process.argv[2];
if (!mode) {
	const runs = modes.map(candidate => {
		const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=768', '--import', 'tsx', fileURLToPath(import.meta.url), candidate],
			{ encoding: 'utf8', timeout: 45000, windowsHide: true });
		assert.equal(child.status, 0, child.stderr || child.error?.message); return JSON.parse(child.stdout);
	});
	console.log(JSON.stringify({ runtime: process.version, platform: process.platform,
		scope: 'Eight fresh-process 50 MiB numeric parsing cases. Whole text + native JSON is an allocation control, not the v1.32 parser. Current segmented parsing owns bounded numeric state. Discrete memory/explicit GC, not continuous peaks, full gateway or Workers capacity.', runs }, null, 2));
} else {
	assert.ok(modes.includes(mode)); globalThis.fetch = async () => { throw new Error('Network forbidden'); };
	const { segmentedJsonResponseWithinLimit } = await import('../src/services/egress/segmented-json-response.ts');
	const { responseTextWithinLimit } = await import('../src/services/egress/bounded-response-body.ts');
	const { IMAGE_JSON_STRUCTURE_LIMITS } = await import('../src/services/json-structure-budget.ts');
	const [implementation, shape] = mode.split('/'), maximum = 50 * 1024 * 1024;
	const encode = text => new TextEncoder().encode(text);
	const head = encode('{"value":' + (shape === 'exponent' ? '-0e' : '1'));
	const end = shape === 'invalid-tail' ? 'x}' : '}';
	let remaining = maximum - head.length - end.length, tail = encode(end);
	if (shape === 'balanced') {
		for (let i = 0; i < 4; i++) { tail = encode('e-' + remaining + end); remaining = maximum - head.length - tail.length; }
		tail = encode('e-' + remaining + end);
	}
	const page = new Uint8Array(65536).fill(shape === 'exponent' ? 57 : 48);
	global.gc(); const baseline = process.memoryUsage(), stages = { baseline }, observedMaximum = { ...baseline };
	const sample = name => { const value = process.memoryUsage();
		for (const key of Object.keys(value)) observedMaximum[key] = Math.max(observedMaximum[key], value[key]);
		if (name) stages[name] = value;
	};
	let phase = 0, bytes = 0;
	const source = new ReadableStream({ pull(c) {
		sample(); let chunk, last = false;
		if (phase++ === 0) chunk = head;
		else if (remaining) { const size = Math.min(remaining, page.length); remaining -= size; chunk = page.subarray(0, size); }
		else { chunk = tail; last = true; }
		bytes += chunk.length; c.enqueue(chunk); if (last) c.close();
	} }, { highWaterMark: 0 });
	let response = new Response(source), result, raw, largestParse = 0, largestNumber = 0;
	const parse = JSON.parse, nativeNumber = Number;
	JSON.parse = (...args) => { largestParse = Math.max(largestParse, args[0].length); return parse(...args); };
	globalThis.Number = new Proxy(nativeNumber, { apply(target, receiver, args) {
		if (typeof args[0] === 'string') largestNumber = Math.max(largestNumber, args[0].length);
		return Reflect.apply(target, receiver, args);
	} });
	const started = performance.now();
	if (implementation === 'whole-text-control') {
		raw = await responseTextWithinLimit(response, maximum); sample('textHeld');
		try { result = { jsonValid: true, body: JSON.parse(raw) }; }
		catch (error) { assert.ok(error instanceof SyntaxError); result = { jsonValid: false }; }
	} else result = await segmentedJsonResponseWithinLimit(response, maximum, IMAGE_JSON_STRUCTURE_LIMITS, undefined, { retainStringPages: true });
	sample('afterParse'); global.gc(); sample('heldAfterGc');
	assert.equal(bytes, maximum); assert.equal(source.locked, false); assert.equal(result.jsonValid, shape !== 'invalid-tail');
	if (result.jsonValid) assert.ok(Object.is(result.body.value, shape === 'integer' ? Infinity : shape === 'balanced' ? 1 : -0));
	if (implementation === 'bounded-scalar') { assert.ok(largestParse < 100); assert.ok(largestNumber < 1100); }
	const value = result.jsonValid ? Object.is(result.body.value, -0) ? '-0' : String(result.body.value) : 'invalid JSON';
	raw = undefined; result = undefined; response = undefined; global.gc(); sample('releasedSameJobAfterGc');
	await nextTurn(); global.gc(); sample('releasedAfterGc');
	console.log(JSON.stringify({ mode, bytes, value, largestParse, largestNumber, elapsedMs: performance.now() - started, stages, observedMaximum }));
}
