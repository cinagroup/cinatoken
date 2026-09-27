// Local synthetic parser/encoder comparison. No model, database or network.
// natural = allocation samples only; gc-probe = forced GC at restoration hooks,
// deliberately diagnostic, never a throughput or continuous peak measurement.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';

const shapes = ['unique-ascii', 'unique-replacement', 'duplicate-ascii', 'discarded-replacement'];
const modes = shapes.flatMap(shape => ['natural', 'gc-probe'].map(probe => `${shape}/${probe}`));
const mode = process.argv[2];
if (!mode) {
	for (const candidate of modes) {
		const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=768', '--import', 'tsx', fileURLToPath(import.meta.url), candidate],
			{ encoding: 'utf8', timeout: 60000, windowsHide: true });
		assert.equal(child.status, 0, child.stderr || child.error?.message); console.log(JSON.stringify(JSON.parse(child.stdout)));
	}
} else {
	assert.ok(modes.includes(mode)); globalThis.fetch = async () => { throw new Error('Network forbidden'); };
	const { segmentedJsonResponseWithinLimit } = await import('../src/services/egress/segmented-json-response.ts');
	const { streamJsonBody } = await import('../src/services/egress/stream-json-body.ts');
	const { IMAGE_JSON_STRUCTURE_LIMITS } = await import('../src/services/json-structure-budget.ts');
	const [shape, probe] = mode.split('/'), replacement = shape.endsWith('replacement'), duplicate = shape.startsWith('duplicate'), discarded = shape.startsWith('discarded');
	const limit = 50 * 1024 * 1024, encoder = new TextEncoder(), encode = text => encoder.encode(text);
	const rows = Array.from({ length: 16 }, (_, index) => ({ id: duplicate ? 0 : index, value: index, fill: 0 }));
	const rowParts = list => list.flatMap((row, index) => [index ? ',"k' : '"k', { fill: row.fill }, `-${String(row.id).padStart(4, '0')}":${row.value}`]);
	const assemble = () => discarded ? ['{"dead":{', ...rowParts(rows.slice(0, 12)), '},"dead":0,"kept":{', ...rowParts(rows.slice(12)), '}}'] : ['{', ...rowParts(rows), '}'];
	const framingBytes = assemble().reduce((n, part) => n + (typeof part === 'string' ? encode(part).length : 0), 0);
	const fill = Math.floor((limit - framingBytes) / rows.length); rows.forEach(row => { row.fill = fill; });
	const inputParts = [...assemble(), ' '.repeat(limit - framingBytes - fill * rows.length)];
	const expectedParts = discarded ? ['{"dead":0,"kept":{', ...rowParts(rows.slice(12)), '}}']
		: ['{', ...rowParts(duplicate ? rows.slice(-1) : rows), '}'];
	const inputPage = new Uint8Array(65536).fill(replacement ? 255 : 65);
	const expectedPage = replacement ? encode('�'.repeat(16384)) : inputPage;
	function* fragments(parts, expected = false) {
		for (const part of parts) {
			if (typeof part === 'string') { if (part) yield encode(part); continue; }
			const page = expected ? expectedPage : inputPage, unitBytes = expected && replacement ? 3 : 1;
			for (let count = part.fill; count > 0;) { const take = Math.min(count, page.length / unitBytes); yield page.subarray(0, take * unitBytes); count -= take; }
		}
	}
	const expectedHash = createHash('sha256'); let expectedBytes = 0;
	for (const bytes of fragments(expectedParts, true)) { expectedHash.update(bytes); expectedBytes += bytes.length; }
	const expectedDigest = expectedHash.digest('hex'), actualHash = createHash('sha256');
	const memory = () => { const m = process.memoryUsage(); return { ...m, heapPlusExternal: m.heapUsed + m.external }; };
	global.gc(); const baseline = memory(), observedMaximum = { ...baseline }, stages = { baseline }, restoration = [];
	let samples = 0, keyDefinitions = 0, largeJoins = 0;
	const sample = name => { const m = memory(); samples++; for (const key of Object.keys(m)) observedMaximum[key] = Math.max(observedMaximum[key], m[key]); if (name) stages[name] = m; return m; };
	const define = Object.defineProperty, join = Array.prototype.join;
	Object.defineProperty = function(target, key, descriptor) {
		const large = typeof key === 'string' && key.length >= 262144;
		if (large && probe === 'gc-probe') global.gc();
		const before = large ? sample() : null, result = define(target, key, descriptor);
		if (large) { keyDefinitions++; if (probe === 'gc-probe') global.gc(); restoration.push({ event: 'key', index: keyDefinitions, chars: key.length, before, after: sample() }); }
		return result;
	};
	Array.prototype.join = function(separator) {
		let chars = 0; for (const part of this) { if (typeof part !== 'string') { chars = 0; break; } chars += part.length; }
		const large = chars >= 262144;
		if (large && probe === 'gc-probe') global.gc();
		const before = large ? sample() : null, result = join.call(this, separator);
		if (large) { largeJoins++; if (probe === 'gc-probe') global.gc(); restoration.push({ event: 'join', index: largeJoins, chars, before, after: sample() }); }
		return result;
	};
	let readBytes = 0, outputBytes = 0, largestChunk = 0;
	const iterator = fragments(inputParts), source = new ReadableStream({ pull(c) { sample(); const next = iterator.next(); if (next.done) c.close(); else { readBytes += next.value.length; c.enqueue(next.value); } } }, { highWaterMark: 0 });
	const started = performance.now();
	let result = await segmentedJsonResponseWithinLimit(new Response(source), limit, IMAGE_JSON_STRUCTURE_LIMITS, undefined, { retainStringPages: true });
	const parseMs = performance.now() - started; sample('afterParse'); global.gc(); sample('heldAfterGc');
	assert.equal(result.jsonValid, true); assert.equal(readBytes, limit); assert.equal(source.locked, false);
	// A short-lived verification scope must not retain full native property names.
	(() => {
		const object = discarded ? result.body.kept : result.body, keys = Object.keys(object), wanted = duplicate ? rows.slice(-1) : discarded ? rows.slice(12) : rows;
		assert.equal(keys.length, wanted.length); if (discarded) assert.equal(result.body.dead, 0);
		for (let i = 0; i < keys.length; i++) { assert.equal(keys[i].length, fill + 6); assert.equal(object[keys[i]], wanted[i].value); }
	})();
	const reader = streamJsonBody(result.body, IMAGE_JSON_STRUCTURE_LIMITS).getReader();
	while (true) { const next = await reader.read(); if (next.done) break; largestChunk = Math.max(largestChunk, next.value.length); outputBytes += next.value.length; actualHash.update(next.value); sample(); }
	reader.releaseLock(); assert.equal(outputBytes, expectedBytes); assert.equal(actualHash.digest('hex'), expectedDigest); assert.ok(largestChunk <= 65536);
	sample('afterDrain'); result = undefined; await nextTurn(); global.gc(); sample('releasedAfterGc');
	Object.defineProperty = define; Array.prototype.join = join;
	process.stdout.write(JSON.stringify({ mode, runtime: process.version, platform: process.platform, readBytes, outputBytes, largestChunk, parseMs,
		elapsedMs: performance.now() - started, samples, keyDefinitions, largeJoins, stages, restoration, observedMaximum }) + '\n');
}
