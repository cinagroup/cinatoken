// Same local synthetic driver harness before/after edits. No external services.
// Instrumented allocation samples, NOT continuous peaks or Workers acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';

const modes = ['generations', 'edits'].flatMap(operation =>
	['ascii', 'replacement', 'escapes', 'numeric-padding', 'numeric-leading-zero'].map(shape => `${operation}/${shape}`));
const mode = process.argv[2];
if (!mode) {
	for (const candidate of modes) {
		const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=768', '--import', 'tsx', fileURLToPath(import.meta.url), candidate],
			{ encoding: 'utf8', timeout: 60000, windowsHide: true });
		assert.equal(child.status, 0, child.stderr || child.error?.message); console.log(JSON.stringify(JSON.parse(child.stdout)));
	}
} else {
	assert.ok(modes.includes(mode)); globalThis.fetch = async () => { throw new Error('Network forbidden'); };
	const { dispatchOpenAiImageGenerations, dispatchOpenAiImageEdits, IMAGE_MAX_RESPONSE_BYTES } = await import('../src/services/egress/openai-images-driver.ts');
	const [operation, shape] = mode.split('/'), numeric = shape.startsWith('numeric-');
	const encoder = new TextEncoder(), decoder = new TextDecoder(), encode = text => encoder.encode(text);
	const usagePrefix = numeric ? '{"input_tokens":"' : '{"input_tokens":3,"output_tokens":7,"total_tokens":10,"audit_payload":"';
	const usageTail = numeric ? '3","output_tokens":7,"total_tokens":10}' : '"}';
	const expectedTail = numeric ? '3","output_tokens":7,"total_tokens":10,"completion_tokens":7}' : '","prompt_tokens":3,"completion_tokens":7}';
	const outer = '{"data":[{"b64_json":"AQID"}],"usage":', head = encode(outer + usagePrefix), tail = encode(usageTail + '}');
	const unit = shape === 'replacement' ? new Uint8Array([255]) : encode(shape === 'escapes' ? '\\n\\ud800X\\udc00' : shape === 'numeric-padding' ? ' ' : shape === 'numeric-leading-zero' ? '0' : 'A');
	const page = new Uint8Array(Math.floor(65536 / unit.length) * unit.length);
	for (let i = 0; i < page.length; i += unit.length) page.set(unit, i);
	let remaining = IMAGE_MAX_RESPONSE_BYTES - head.length - tail.length, phase = 0, readBytes = 0, expectedBytes = 0;
	const expected = createHash('sha256'), actual = createHash('sha256'), expectedResponse = createHash('sha256'), actualResponse = createHash('sha256');
	expectedResponse.update(outer);
	const updateExpected = bytes => { expected.update(bytes); expectedResponse.update(bytes); expectedBytes += bytes.length; };
	updateExpected(encode(usagePrefix));
	const memory = () => { const m = process.memoryUsage(); return { ...m, heapPlusExternal: m.heapUsed + m.external }; };
	global.gc(); const baseline = memory(), observedMaximum = { ...baseline }, stages = { baseline }; let samples = 0;
	const sample = name => { const m = memory(); samples++; for (const key of Object.keys(m)) observedMaximum[key] = Math.max(observedMaximum[key], m[key]); if (name) stages[name] = m; };
	const stringify = JSON.stringify, join = Array.prototype.join;
	JSON.stringify = function(value, ...args) {
		const usage = value && typeof value === 'object' && Object.hasOwn(value, 'input_tokens');
		if (usage) sample('rawStringifyBefore'); const result = stringify(value, ...args); if (usage) sample('rawStringifyAfter'); return result;
	};
	Array.prototype.join = function(separator) {
		let chars = 0; for (const part of this) { if (typeof part !== 'string') { chars = 0; break; } chars += part.length; }
		if (chars >= 262144) sample('largeJoinBefore'); const result = join.call(this, separator); if (chars >= 262144) sample('largeJoinAfter'); return result;
	};
	console.log = () => {}; console.error = () => {};
	const source = new ReadableStream({ pull(c) {
		sample(); let bytes;
		if (phase++ === 0) bytes = head;
		else if (remaining) {
			const count = Math.min(page.length, remaining);
			if (count % unit.length) { bytes = new Uint8Array(count).fill(65); bytes.set(page.subarray(0, count - count % unit.length)); }
			else bytes = page.subarray(0, count);
			remaining -= count; updateExpected(encode(decoder.decode(bytes, { stream: true })));
		} else { bytes = tail; assert.equal(decoder.decode(), ''); updateExpected(encode(expectedTail)); expectedResponse.update('}'); }
		readBytes += bytes.length; c.enqueue(bytes); if (bytes === tail) c.close();
	} }, { highWaterMark: 0 });
	const route = { targetId: 'synthetic', providerId: 'synthetic', providerName: 'Synthetic', providerModelName: 'synthetic-image', upstreamProtocol: 'openai',
		upstreamOperation: 'images.' + operation, adapter: 'passthrough', providerEndpoints: { openai: { base: 'https://synthetic.invalid/v1' } }, providerApiKey: 'synthetic',
		providerSharedChannelType: null, customParams: null, routeGroup: 'default', routePriority: 1, routeWeight: 1 };
	const options = { requireAuthoritativeUsage: true, fetchImpl: async () => new Response(source, { headers: { 'Content-Type': 'application/json' } }) };
	const started = performance.now();
	let result = operation === 'generations'
		? await dispatchOpenAiImageGenerations(route, { prompt: 'synthetic', n: 1 }, undefined, undefined, undefined, options)
		: await dispatchOpenAiImageEdits(route, { prompt: 'synthetic', n: 1, images: [] }, undefined, undefined, undefined, options);
	const driverMs = performance.now() - started; sample('afterDriver'); global.gc(); sample('heldAfterGc');
	assert.equal(result.response.status, 200); assert.equal(readBytes, IMAGE_MAX_RESPONSE_BYTES); assert.equal(source.locked, false);
	assert.equal(result.meta.imageUsage.text_tokens, 3); assert.equal(result.meta.imageUsage.image_output_tokens, 7);
	let usage = await result.usagePromise; const raw = usage.raw_usage; let rawBytes = 0;
	for (let i = 0; i < raw.length; i += 65536) { const chunk = encode(raw.slice(i, i + 65536)); rawBytes += chunk.length; actual.update(chunk); }
	assert.equal(rawBytes, expectedBytes); assert.equal(actual.digest('hex'), expected.digest('hex'));
	sample('afterAuditHash'); const reader = result.response.body.getReader(); let outputBytes = 0, largestChunk = 0;
	while (true) { const next = await reader.read(); if (next.done) break; outputBytes += next.value.length; largestChunk = Math.max(largestChunk, next.value.length); actualResponse.update(next.value); sample(); }
	reader.releaseLock(); assert.equal(actualResponse.digest('hex'), expectedResponse.digest('hex')); assert.ok(largestChunk <= 65536);
	sample('afterDrain'); result = undefined; usage = undefined;
	await nextTurn(); global.gc(); sample('releasedExceptAuditStringAfterGc');
	JSON.stringify = stringify; Array.prototype.join = join;
	process.stdout.write(JSON.stringify({ mode, runtime: process.version, platform: process.platform, readBytes, rawBytes, outputBytes, largestChunk, driverMs,
		elapsedMs: performance.now() - started, samples, stages, observedMaximum }) + '\n');
}
