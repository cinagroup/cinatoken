import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it } from 'node:test';
import { boundRequestBody, MAX_REQUEST_BODY_BYTES } from './bounded-request-body';
import { createRequestDeadline } from './request-deadline';
import {
	IMAGE_JSON_ADMISSION_LIMITS, IMAGE_JSON_MAX_PROPERTY_NAME_CHARS,
	createJsonStructureBodyInspector, IMAGE_JSON_STRUCTURE_LIMITS, JsonStructureBudget, JsonStructureLimitError,
} from './json-structure-budget';

function nodes(value: unknown): number {
	if (Array.isArray(value)) return 1 + value.reduce((sum, item) => sum + nodes(item), 0);
	if (value !== null && typeof value === 'object') return 1 + Object.values(value).reduce<number>((sum, item) => sum + 1 + nodes(item), 0);
	return 1;
}
const examples: unknown[] = [null, true, false, 0, -2.5e-10, '', '图💡\ud800', '[{},:]"\\\n\t\r',
	[], {}, [null, 1, {}, []], { '"\\,:[]{}': [true, { '': '"\\' }, false] }];

for (const width of [1, 2, 7, 8192]) for (const key of [
	'A'.repeat(256), '💡'.repeat(128), '\\u0041'.repeat(256), '\\ud800'.repeat(256), '\\"'.repeat(256),
]) it(`property-name admission counts decoded UTF-16 at chunk ${width}, key prefix ${key.slice(0, 8)}`, () => {
	for (const extra of ['', 'x']) {
		const raw = '{"root":[{"' + key + extra + '":"' + 'A'.repeat(3000) + '"}],"end":0}';
		const budget = new JsonStructureBudget(IMAGE_JSON_ADMISSION_LIMITS);
		const write = () => { for (let i = 0; i < raw.length; i += width) budget.write(raw.slice(i, i + width)); };
		if (!extra) { write(); JSON.parse(raw); }
		else {
			let stopped: unknown;
			assert.throws(write, error => { assert.ok(error instanceof JsonStructureLimitError); assert.equal(error.dimension, 'property name characters'); stopped = error; return true; });
			assert.throws(() => budget.write(''), error => error === stopped);
		}
	}
});

it('property-name admission covers overwritten subtrees, but not values or opted-out parser consumers', () => {
	const raw = '{"discard":{"' + 'A'.repeat(257) + '":0},"discard":{},"value":"' + 'B'.repeat(3000) + '"}';
	assert.throws(() => new JsonStructureBudget(IMAGE_JSON_ADMISSION_LIMITS).write(raw), JsonStructureLimitError);
	new JsonStructureBudget(IMAGE_JSON_STRUCTURE_LIMITS).write(raw);
	new JsonStructureBudget(IMAGE_JSON_ADMISSION_LIMITS).write('{"a":["' + 'A'.repeat(3000) + '",{"a":0}],"b":1}');
	assert.equal(IMAGE_JSON_MAX_PROPERTY_NAME_CHARS, 256);
});

it('property-name configuration is validated and snapshotted', () => {
	for (const maxPropertyNameChars of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => new JsonStructureBudget({ ...IMAGE_JSON_STRUCTURE_LIMITS, maxPropertyNameChars }), RangeError);
	const limits = { ...IMAGE_JSON_STRUCTURE_LIMITS, maxPropertyNameChars: 2 }, budget = new JsonStructureBudget(limits);
	limits.maxPropertyNameChars = 999;
	assert.throws(() => budget.write('{"abc":0}'), JsonStructureLimitError);
});
for (const [index, value] of examples.entries()) for (const width of [1, 2, 3, 7, 65536]) {
	it(`JSON token budget agrees with independent tree count: sample ${index}, chunk ${width}`, () => {
		const text = JSON.stringify(value), expected = nodes(value);
		const budget = new JsonStructureBudget({ maxDepth: 64, maxNodes: expected });
		for (let offset = 0; offset < text.length; offset += width) { budget.write(text.slice(offset, offset + width)); budget.write(''); }
		assert.equal(budget.nodeCount, expected); assert.equal(budget.containerDepth, 0);
		assert.deepEqual(JSON.parse(text), value);
		if (expected > 1) assert.throws(() => new JsonStructureBudget({ maxDepth: 64, maxNodes: expected - 1 }).write(text), JsonStructureLimitError);
	});
}

it('deterministic heterogeneous JSON trees preserve values and exact token accounting across chunk splits', () => {
	let seed = 20260906;
	const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
	function tree(depth: number): unknown {
		if (depth === 0 || next() % 3 === 0) return examples[next() % 8];
		const count = next() % 6;
		return next() % 2 === 0 ? Array.from({ length: count }, () => tree(depth - 1))
			: Object.fromEntries(Array.from({ length: count }, (_, i) => [`${i}图\\"[]{}:,`, tree(depth - 1)]));
	}
	for (let i = 0; i < 200; i++) {
		const value = tree(6), text = JSON.stringify(value), budget = new JsonStructureBudget(IMAGE_JSON_STRUCTURE_LIMITS);
		for (let offset = 0; offset < text.length;) { const width = 1 + next() % 31; budget.write(text.slice(offset, offset + width)); offset += width; }
		assert.equal(budget.nodeCount, nodes(value)); assert.equal(budget.containerDepth, 0); assert.deepEqual(JSON.parse(text), value);
	}
});

it('duplicate keys, escaped property names and dangerous-looking keys are charged before native last-key-wins parsing', () => {
	const raw = '{"__proto__":{},"constructor":{},"a":0,"\\u0061":1}';
	const budget = new JsonStructureBudget({ maxDepth: 2, maxNodes: 9 });
	for (const c of raw) budget.write(c);
	assert.equal(budget.nodeCount, 9); const value = JSON.parse(raw);
	assert.equal(value.a, 1); assert.equal(Object.hasOwn(value, '__proto__'), true);
	assert.throws(() => new JsonStructureBudget({ maxDepth: 2, maxNodes: 8 }).write(raw), JsonStructureLimitError);
});

for (const dimension of ['depth', 'nodes'] as const) it(`exact ${dimension} ceiling passes, one extra fails and failure remains terminal`, () => {
	const { maxDepth, maxNodes } = IMAGE_JSON_STRUCTURE_LIMITS;
	const accepted = dimension === 'depth' ? '['.repeat(maxDepth) + '0' + ']'.repeat(maxDepth)
		: '[' + '0,'.repeat(maxNodes - 2) + '0]';
	const rejected = dimension === 'depth' ? '[' + accepted + ']' : accepted.slice(0, -1) + ',0]';
	const valid = new JsonStructureBudget(IMAGE_JSON_STRUCTURE_LIMITS); valid.write(accepted); JSON.parse(accepted);
	const budget = new JsonStructureBudget(IMAGE_JSON_STRUCTURE_LIMITS);
	let failure: JsonStructureLimitError | undefined;
	assert.throws(() => budget.write(rejected), error => {
		assert.ok(error instanceof JsonStructureLimitError); assert.equal(error.dimension, dimension); failure = error; return true;
	});
	assert.throws(() => budget.write('null'), error => error === failure);
	assert.throws(() => budget.write(''), error => error === failure);
});

for (const value of [0, -1, 1.5, NaN, Infinity]) it(`invalid structure configuration is rejected: ${value}`, () => {
	assert.throws(() => new JsonStructureBudget({ maxDepth: value, maxNodes: 10 }), RangeError);
	assert.throws(() => new JsonStructureBudget({ maxDepth: 10, maxNodes: value }), RangeError);
});
it('a caller cannot extend a live budget by mutating its original limits object', () => {
	const limits = { maxDepth: 1, maxNodes: 3 }, budget = new JsonStructureBudget(limits);
	limits.maxDepth = 99; limits.maxNodes = 999;
	assert.throws(() => budget.write('[[]]'), JsonStructureLimitError);
});
for (const raw of ['{invalid', '{"a":01}', '{"a":true,}', '{"a":"\\x00"}', '[}', '1 2', '"unterminated']) {
	it(`structural admission never replaces native syntax rejection: ${raw}`, () => {
		new JsonStructureBudget(IMAGE_JSON_STRUCTURE_LIMITS).write(raw);
		assert.throws(() => JSON.parse(raw), SyntaxError);
	});
}

for (const width of [1, 2, 3, 5, 65536]) it(`request byte inspector preserves streaming UTF-8, BOM and escapes at chunk width ${width}`, async () => {
	const raw = '\ufeff{"图💡":"\\u0022\\\\[]{}:,\ud800","n":-1.23e+5}';
	const bytes = new TextEncoder().encode(raw), native = new TextDecoder().decode(bytes);
	const deadline = createRequestDeadline(Date.now() + 5000);
	let offset = 0;
	const source = new ReadableStream<Uint8Array>({ pull(c) {
		if (offset === bytes.length) c.close(); else { const end = Math.min(bytes.length, offset + width); c.enqueue(bytes.subarray(offset, end)); offset = end; }
	} }, { highWaterMark: 0 });
	const guarded = boundRequestBody(source, deadline, bytes.length, createJsonStructureBodyInspector({ maxDepth: 1, maxNodes: 5 }));
	try { assert.deepEqual(await new Response(guarded.body).json(), JSON.parse(native)); }
	finally { guarded.dispose(); deadline.dispose(); }
	assert.equal(source.locked, false); assert.equal(getEventListeners(deadline.signal, 'abort').length, 0);
});

it('a dense request fails before native parsing/EOF and does not wait for cancel acknowledgement', async () => {
	let pulls = 0, cancels = 0;
	const source = new ReadableStream<Uint8Array>({ pull(c) {
		if (++pulls === 1) c.enqueue(new TextEncoder().encode('[0,0,0,0,')); else throw new Error('Must not request the tail');
	}, cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
	const deadline = createRequestDeadline(Date.now() + 5000);
	const guarded = boundRequestBody(source, deadline, 1024, createJsonStructureBodyInspector({ maxDepth: 2, maxNodes: 4 }));
	try { await assert.rejects(new Response(guarded.body).json(), JsonStructureLimitError); }
	finally { guarded.dispose(); deadline.dispose(); }
	assert.equal(pulls, 1); assert.equal(cancels, 1); assert.equal(source.locked, false);
});

it('JSON byte inspector keeps the full 50 MiB long-string capacity, even in one transport chunk', async t => {
	const bytes = new Uint8Array(MAX_REQUEST_BODY_BYTES).fill(65); bytes[0] = 34; bytes[bytes.length - 1] = 34;
	const decoder = TextDecoder.prototype.decode; let decoded = 0;
	t.mock.method(TextDecoder.prototype, 'decode', function(this: TextDecoder, ...[input, options]: Parameters<TextDecoder['decode']>) {
		if (input) { assert.ok(input.byteLength <= 65536); decoded += input.byteLength; }
		return decoder.call(this, input, options);
	});
	const inspector = createJsonStructureBodyInspector({ maxDepth: 1, maxNodes: 1 });
	await inspector.write(bytes); await inspector.end(); inspector.dispose();
	assert.equal(decoded, MAX_REQUEST_BODY_BYTES);
});
