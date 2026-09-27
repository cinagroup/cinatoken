import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { IMAGE_JSON_STRUCTURE_LIMITS, JsonStructureLimitError } from '../json-structure-budget';
import { UpstreamResponseBodyTooLargeError } from './bounded-response-body';
import { JSON_PARSE_STRING_PIECE_CHARS, segmentedJsonResponseWithinLimit } from './segmented-json-response';
import { JsonStringPages, materializeJsonStringTree } from './json-string-pages';
import { JSON_NUMBER_SIGNIFICANT_DIGITS, JsonScalar } from './json-scalar';

const limits = IMAGE_JSON_STRUCTURE_LIMITS, encode = (text: string) => new TextEncoder().encode(text);
const maxBytes = 32 * 1024 * 1024;
function source(raw: Uint8Array, width: number) {
	let offset = 0;
	return new ReadableStream<Uint8Array>({ pull(c) {
		if (offset === raw.length) c.close(); else { const end = Math.min(raw.length, offset + width); c.enqueue(raw.subarray(offset, end)); offset = end; }
	} }, { highWaterMark: 0 });
}
async function compare(raw: Uint8Array, width: number) {
	const text = new TextDecoder().decode(raw);
	let expected: unknown, valid = true;
	try { expected = text ? JSON.parse(text) : null; }
	catch { valid = false; expected = { error: { message: text.slice(0, 500) || 'Invalid upstream JSON' } }; }
	const stream = source(raw, width), result = await segmentedJsonResponseWithinLimit(new Response(stream), maxBytes, limits);
	assert.equal(stream.locked, false); assert.equal(result.jsonValid, valid, text.slice(0, 100));
	assert.deepEqual(result.body, expected, text.slice(0, 100));
	assert.equal(JSON.stringify(result.body), JSON.stringify(expected), 'includes object key enumeration and duplicate overwrite order');
}
const validTexts = ['', '{}', '[]', 'null', 'true', 'false', '0', '-0', '1e400', '-1e400', '1e-400',
	'9007199254740993', '-2.2250738585072012e-308', '1.00000000000000011102230246251565404236316680908203125',
	'""', '"\\uD800\\uDC00\\uDFFF\\uD800"', '"a\\n\\t\\r\\b\\f\\/\\\\\\\""', '"图Ā💡  "',
	'{"9":1,"2":2,"x":0,"x":1,"1":3,"9":4,"__proto__":{"polluted":true},"constructor":{"prototype":1},"toJSON":"data"}',
	'{"":0,"empty":"","escaped\\u0022name":[{},[],null,true,false,-0,1e400],"nested":{"same":1,"same":2}}',
	' \n\r\t [ 1 , 2 , { "x" : "value" } ] \r\n', '\ufeff{"unicode":"\ufeff"}', '\ufeff'];
const invalidTexts = [' ', '\n', '\ufeff ', '[', '{', ']', '}', ',', ':', '[,]', '[0,]', '{"x":0,}', '{0:0}', '{true:1}',
	'{null:0}', '{"x" "y":0}', '{"x":}', '{"x":0 "y":1}', '[0 0]', '"a""b"', '1"2"', '"1"2', '{}[]', '[]{}',
	'00', '01', '-01', '+1', '1.', '.1', '-.1', '1e', '1e+', '1e-', '1e01e2', '--1', 'NaN', 'Infinity', 'undefined',
	'truefalse', 'True', 'nul', 'falseX', '"unterminated', '"trailing\\', '"\\x00"', '"\\v"', '"\\0"',
	'"\\u000"', '"\\uZZZZ"', '"\\u12\\4"', '"\\u123"4', '"\\\n"', '"\n"', '"\u0000"', '"\t"',
	'0\u00a01', '0\ufeff', '\u2028null', '\u0000', '{/*comment*/"x":0}', '[...[]]', '{"x"=0}'];
for (const width of [1, 2, 3, 7, 8191, 8192, 65536]) {
	it(`segmented JSON native-value and property-order differential, width ${width}`, async () => {
		for (const text of validTexts) await compare(encode(text), width);
	});
	it(`segmented JSON native-syntax rejection differential, width ${width}`, async () => {
		for (const text of invalidTexts) await compare(encode(text), width);
	});
}
for (const delta of [-2, -1, 0, 1, 2]) for (const escape of ['\\uD800\\uDC00', '\\\"', '\\\\', '\\n']) {
	it(`segmented JSON long key/value native escape boundary delta ${delta}, escape ${escape}`, async () => {
		const value = 'a'.repeat(JSON_PARSE_STRING_PIECE_CHARS + delta) + escape + '图'.repeat(9000);
		await compare(encode('{"' + value + '":"' + value + '"}'), 8191);
	});
}
it('segmented JSON deterministic mixed-tree and mutation differential uses native JSON as independent oracle', async () => {
	let seed = 0x8a37b231;
	const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
	const strings = ['', '图💡', '\u0000"\\\n', '__proto__', 'constructor', 'toJSON', '\ud800', '2'];
	const tree = (depth: number): unknown => {
		const kind = Math.floor(random() * (depth ? 7 : 5));
		if (kind === 0) return null; if (kind === 1) return random() < .5;
		if (kind === 2) return (random() - .5) * 1e25;
		if (kind < 5) return strings[Math.floor(random() * strings.length)];
		if (kind === 5) return Array.from({ length: Math.floor(random() * 5) }, () => tree(depth - 1));
		const value: Record<string, unknown> = {};
		for (let i = 0, n = Math.floor(random() * 5); i < n; i++) Object.defineProperty(value,
			strings[Math.floor(random() * strings.length)]!, { value: tree(depth - 1), enumerable: true, configurable: true, writable: true });
		return value;
	};
	for (let i = 0; i < 250; i++) {
		const raw = JSON.stringify(tree(4)); await compare(encode(raw), 7);
		const position = Math.floor(random() * raw.length), inserted = ['"', '\\', ':', ',', '[', ' ', '0', '\u0000'][i % 8]!;
		await compare(encode(raw.slice(0, position) + inserted + raw.slice(position + 1)), 3);
	}
});
for (const width of [1, 2, 7, 65536]) it(`segmented JSON matches replacement decoding and BOM behavior, width ${width}`, async () => {
	const prefix = encode('{"x":"'), suffix = encode('"}');
	const malformed = new Uint8Array([0xc0, 0xaf, 0xed, 0xa0, 0x80, 0xe2, 0x82]);
	await compare(new Uint8Array([...prefix, ...malformed, ...suffix]), width);
	await compare(new Uint8Array([0xef, 0xbb, 0xbf, ...encode('"tail'), 0xe2, 0x82]), width);
});
it('large numeric tokens retain exact native rounding, underflow, overflow and rejection', async () => {
	for (const number of ['9'.repeat(65536), '9'.repeat(65536) + 'e-65535', '0.' + '0'.repeat(65536) + '1', '1e' + '9'.repeat(65536), '00' + '0'.repeat(65536)]) {
		await compare(encode('{"opaque":' + number + '}'), 8191);
	}
});
for (const dimension of ['depth', 'nodes'] as const) for (const extra of [0, 1]) {
	it(`segmented JSON ${dimension} ceiling plus ${extra}`, async () => {
		const text = dimension === 'depth' ? '['.repeat(limits.maxDepth + extra) + '0' + ']'.repeat(limits.maxDepth + extra)
			: '[' + '0,'.repeat(limits.maxNodes - 2 + extra) + '0]';
		const stream = source(encode(text), 4096);
		if (extra) await assert.rejects(segmentedJsonResponseWithinLimit(new Response(stream), maxBytes, limits), JsonStructureLimitError);
		else assert.equal((await segmentedJsonResponseWithinLimit(new Response(stream), maxBytes, limits)).jsonValid, true);
		assert.equal(stream.locked, false);
	});
}
for (const shape of ['string', 'whitespace'] as const) it(`full 32 MiB ${shape} input never reaches a full-text JSON parse/decode`, async t => {
	const prefix = encode(shape === 'string' ? '{"data":[{"b64_json":"' : '{"data":[{"b64_json":"AQID"}]}');
	const suffix = encode(shape === 'string' ? '"}],"label":"Ā"}' : '');
	let remaining = maxBytes - prefix.length - suffix.length, phase = 0;
	const page = new Uint8Array(65536).fill(shape === 'string' ? 65 : 32);
	const stream = new ReadableStream<Uint8Array>({ pull(c) {
		if (phase++ === 0) c.enqueue(prefix);
		else if (remaining) { const size = Math.min(remaining, page.length); remaining -= size; c.enqueue(page.subarray(0, size)); }
		else { c.enqueue(suffix); c.close(); }
	} }, { highWaterMark: 0 });
	const parse = JSON.parse, decode = TextDecoder.prototype.decode; let largestParse = 0, decoded = 0;
	t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
		largestParse = Math.max(largestParse, args[0].length); return parse(...args);
	});
	t.mock.method(TextDecoder.prototype, 'decode', function(this: TextDecoder, ...args: Parameters<TextDecoder['decode']>) {
		if (args[0]) { assert.ok(args[0].byteLength <= 65536); decoded += args[0].byteLength; }
		return decode.apply(this, args);
	});
	const result = await segmentedJsonResponseWithinLimit(new Response(stream), maxBytes, limits);
	assert.equal(result.jsonValid, true); assert.equal(decoded, maxBytes); assert.ok(largestParse <= JSON_PARSE_STRING_PIECE_CHARS + 7);
	assert.ok(result.body && typeof result.body === 'object' && 'data' in result.body && Array.isArray(result.body.data));
	const row: unknown = result.body.data[0]; assert.ok(row && typeof row === 'object' && 'b64_json' in row && typeof row.b64_json === 'string');
	assert.equal(row.b64_json.length, shape === 'string' ? maxBytes - prefix.length - suffix.length : 4);
});
for (const stop of ['before', 'pending', 'partial'] as const) it(`segmented JSON ${stop} cancellation disposes partial material without transport ACK`, async () => {
	const client = new AbortController(); let pulls = 0, cancels = 0;
	const stream = new ReadableStream<Uint8Array>({ pull(c) {
		pulls++; if (stop === 'partial' && pulls === 1) c.enqueue(encode('{"x":"' + 'a'.repeat(65536)));
	}, cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
	if (stop === 'before') client.abort('synthetic stop');
	const pending = assert.rejects(segmentedJsonResponseWithinLimit(new Response(stream), maxBytes, limits, client.signal));
	if (stop !== 'before') { while (pulls < (stop === 'partial' ? 2 : 1)) await nextTurn(); client.abort('synthetic stop'); }
	await pending; assert.equal(cancels, 1); assert.equal(stream.locked, false); assert.equal(getEventListeners(client.signal, 'abort').length, 0);
});
it('malformed early input retains the bounded preview and waits for EOF without accepting a partial result', async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>, settled = false;
	const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } }, { highWaterMark: 0 });
	const text = '"bad\\xescape"' + 'x'.repeat(1000);
	const pending = segmentedJsonResponseWithinLimit(new Response(stream), maxBytes, limits).then(value => { settled = true; return value; });
	controller.enqueue(encode(text)); await nextTurn(); assert.equal(settled, false);
	controller.close(); assert.deepEqual(await pending, { body: { error: { message: text.slice(0, 500) } }, jsonValid: false });
});
it('malformed early input cannot bypass the later byte or duplicate-node budget', async () => {
	const bad = '"\\x" ', dense = bad + '{' + '"x":0,'.repeat(limits.maxNodes);
	await assert.rejects(segmentedJsonResponseWithinLimit(new Response(dense), maxBytes, limits), JsonStructureLimitError);
	await assert.rejects(segmentedJsonResponseWithinLimit(new Response(bad + ' '.repeat(2000)), 1000, limits), UpstreamResponseBodyTooLargeError);
});
it('a huge borrowed transport page is decoded in bounded slices', async t => {
	const raw = encode('{"opaque":"' + 'a'.repeat(2 * 1024 * 1024) + '"}');
	const decode = TextDecoder.prototype.decode; let calls = 0;
	t.mock.method(TextDecoder.prototype, 'decode', function(this: TextDecoder, ...args: Parameters<TextDecoder['decode']>) {
		if (args[0]) { calls++; assert.ok(args[0].byteLength <= 65536); } return decode.apply(this, args);
	});
	assert.equal((await segmentedJsonResponseWithinLimit(new Response(source(raw, raw.length)), maxBytes, limits)).jsonValid, true);
	assert.ok(calls > 1);
});
it('a chunk crossing the node budget is rejected before any of its values reach native parsing', async t => {
	const parse = t.mock.method(JSON, 'parse');
	await assert.rejects(segmentedJsonResponseWithinLimit(new Response('[0,0,0,0]'), maxBytes, { maxDepth: 64, maxNodes: 4 }), JsonStructureLimitError);
	assert.equal(parse.mock.callCount(), 0);
});

for (const retainStringPages of [false, true]) for (const shape of ['ascii', 'unicode', 'replacement']) {
	it(`unescaped JSON pages avoid native piece reparse: ${shape}/${retainStringPages ? 'paged' : 'native'}`, async t => {
		const prefix = encode('{"data":"'), suffix = encode('"}');
		const payload = shape === 'replacement' ? new Uint8Array(200000).fill(255)
			: encode((shape === 'ascii' ? 'A' : '图Ā💡\ufeff\u2028\u2029').repeat(100000));
		const raw = new Uint8Array(prefix.length + payload.length + suffix.length);
		raw.set(prefix); raw.set(payload, prefix.length); raw.set(suffix, prefix.length + payload.length);
		const expected: unknown = JSON.parse(new TextDecoder().decode(raw));
		const parse = JSON.parse; let calls = 0;
		t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
			calls++; assert.ok(args[0].length < 100, 'only the compact structure needs native parsing'); return parse(...args);
		});
		const stream = source(raw, 65536);
		const result = await segmentedJsonResponseWithinLimit(new Response(stream), maxBytes, limits, undefined, { retainStringPages });
		assert.equal(result.jsonValid, true); assert.equal(calls, 1); assert.equal(stream.locked, false);
		assert.deepEqual(materializeJsonStringTree(result.body), expected);
	});
}

it('every unescaped JSON control character remains invalid at fast-path piece boundaries', async () => {
	for (let code = 0; code < 32; code++) for (const offset of [-1, 0, 1]) {
		await compare(encode('{"opaque":"' + 'A'.repeat(JSON_PARSE_STRING_PIECE_CHARS + offset) + String.fromCharCode(code) + '"}'), 8191);
	}
});

for (const nested of [false, true]) it(`discarded ${nested ? 'nested' : 'root'} native fields are resolved before materialization`, async t => {
	const value = 'A'.repeat(20000);
	const entries = `"9":0,"2":1,"__proto__":{"ignored":"${value}"},"x":"${value}","constructor":1,"toJSON":"data","\\u0078":"last","9":4,"__proto__":{"safe":true}`;
	const text = nested ? '{"provider":{' + entries + '}}' : '{' + entries + '}';
	t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('Must not join a discarded token'); });
	const result = await segmentedJsonResponseWithinLimit(new Response(source(encode(text), 8191)), maxBytes, limits, undefined,
		{ retainStringPages: true, nativeStringFields: nested ? ['provider'] : ['x', '__proto__'] });
	assert.equal(result.jsonValid, true); assert.deepEqual(result.body, JSON.parse(text));
	assert.equal(JSON.stringify(result.body), JSON.stringify(JSON.parse(text)));
});

function scalar(text: string, width = 97): number | boolean | null {
	const value = new JsonScalar(Buffer.byteLength(text));
	for (let start = 0; start < text.length; start += width) value.write(text.slice(start, start + width));
	return value.finish();
}

for (const ending of ['valid', 'malformed', 'cancel'] as const) it(`unfinished numeric exponent ${ending} waits for full EOF or cancellation`, async () => {
	const abort = new AbortController(); let controller!: ReadableStreamDefaultController<Uint8Array>, settled = false, cancels = 0;
	const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
	const pending = segmentedJsonResponseWithinLimit(new Response(stream), 100000, limits, abort.signal)
		.then(value => { settled = true; return value; });
	controller.enqueue(encode('{"n":1' + '0'.repeat(20000) + 'e-'));
	await nextTurn(); assert.equal(settled, false);
	if (ending === 'cancel') { abort.abort('synthetic numeric cancel'); await assert.rejects(pending); assert.equal(cancels, 1); }
	else { controller.enqueue(encode(ending === 'valid' ? '20000}' : '}')); controller.close();
		const result = await pending; assert.equal(result.jsonValid, ending === 'valid'); if (result.jsonValid) assert.deepEqual(result.body, { n: 1 }); }
	assert.equal(stream.locked, false); assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

for (const width of [1, 7, 1023, 1024, 1025]) it(`bounded scalar grammar matches native JSON across ${width}-char fragments`, () => {
	for (const text of [...validTexts, ...invalidTexts, 'true0', 'falsee1', '-null', '1e-000000000', '-0e' + '9'.repeat(2000),
		'1' + '0'.repeat(10000) + 'e-10000', '0.' + '0'.repeat(10000) + '1e10001']) {
		let expected: unknown, invalid = false;
		try { expected = JSON.parse(text); invalid = expected !== null && typeof expected !== 'boolean' && typeof expected !== 'number'; }
		catch { invalid = true; }
		if (invalid) assert.throws(() => scalar(text, width), SyntaxError, text.slice(0, 80));
		else assert.ok(Object.is(scalar(text, width), expected), text.slice(0, 80));
	}
});

it('all finite binary64 exponent bins retain even rounding and both sides of padded exact midpoints', () => {
	const bytes = new DataView(new ArrayBuffer(8));
	const double = (bits: bigint) => { bytes.setBigUint64(0, bits); return bytes.getFloat64(0); };
	const pow5 = [1n]; for (let i = 1; i <= 1075; i++) pow5.push(pow5[i - 1]! * 5n);
	const padding = 10n ** BigInt(JSON_NUMBER_SIGNIFICANT_DIGITS + 80);
	for (let bin = 0; bin <= 2046; bin++) for (const fraction of [0n, 1n, (1n << 52n) - 1n]) {
		const bits = (BigInt(bin) << 52n) + fraction;
		const significand = bin === 0 ? fraction : (1n << 52n) + fraction;
		const power = (bin === 0 ? -1074 : bin - 1075) - 1;
		const odd = 2n * significand + 1n;
		const coefficient = power >= 0 ? odd << BigInt(power) : odd * pow5[-power]!;
		const exponent = Math.min(power, 0) - JSON_NUMBER_SIGNIFICANT_DIGITS - 80;
		for (const side of [-1n, 0n, 1n]) {
			const expected = double(side < 0n || (side === 0n && (significand & 1n) === 0n) ? bits : bits + 1n);
			const text = (coefficient * padding + side).toString() + 'e' + exponent;
			for (const sign of ['', '-']) {
				const signedExpected = sign ? -expected : expected;
				assert.ok(Object.is(JSON.parse(sign + text), signedExpected), `independent midpoint oracle ${bin}/${fraction}/${side}`);
				assert.ok(Object.is(scalar(sign + text), signedExpected), `bounded midpoint ${bin}/${fraction}/${side}/${sign}`);
			}
		}
	}
});

it('bounded scalar deterministic long significands/exponents match native conversion', () => {
	let seed = 0x679192fc;
	const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
	for (let i = 0; i < 2000; i++) {
		const length = random() % 4000 + 1;
		let digits = String(random() % 9 + 1);
		for (let j = 1; j < length; j++) digits += String(random() % 10);
		const point = random() % (length + 1);
		const mantissa = point === 0 ? '0.' + digits : point === length ? digits : digits.slice(0, point) + '.' + digits.slice(point);
		const exponent = (random() % 700) - 350 - point;
		const text = (i % 2 ? '-' : '') + mantissa + 'e' + exponent;
		assert.ok(Object.is(scalar(text, random() % 1100 + 1), JSON.parse(text)), `long scalar case ${i}`);
	}
});

for (const shape of ['integer', 'fraction', 'balanced', 'exponent', 'invalid-tail'] as const) {
	it(`full 50 MiB ${shape} scalar never requires an unbounded native conversion`, async t => {
		const maximum = 50 * 1024 * 1024;
		const head = encode('{"opaque":' + (shape === 'fraction' ? '0.' : shape === 'exponent' ? '-0e' : '1'));
		let remaining = maximum - head.length - 1, tail = encode('}');
		if (shape === 'balanced') {
			for (let i = 0; i < 3; i++) { tail = encode('e-' + remaining + '}'); remaining = maximum - head.length - tail.length; }
			tail = encode('e-' + remaining + '}');
		} else if (shape === 'invalid-tail') { tail = encode('x}'); remaining--; }
		let phase = 0, consumed = 0;
		const page = new Uint8Array(65536).fill(shape === 'exponent' ? 57 : 48);
		const stream = new ReadableStream<Uint8Array>({ pull(c) {
			let chunk: Uint8Array;
			if (phase++ === 0) chunk = head;
			else if (remaining) { const size = Math.min(remaining, page.length); remaining -= size; chunk = page.subarray(0, size); }
			else { consumed += tail.length; c.enqueue(tail); c.close(); return; }
			consumed += chunk.length; c.enqueue(chunk);
		} }, { highWaterMark: 0 });
		const parse = JSON.parse;
		t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => { assert.ok(args[0].length < 100, 'only compact object grammar uses JSON.parse'); return parse(...args); });
		t.mock.method(globalThis, 'Number', new Proxy(Number, { apply(target, receiver, args) {
			if (typeof args[0] === 'string') assert.ok(args[0].length <= JSON_NUMBER_SIGNIFICANT_DIGITS + 32);
			return Reflect.apply(target, receiver, args);
		} }));
		const result = await segmentedJsonResponseWithinLimit(new Response(stream), maximum, limits, undefined, { retainStringPages: true });
		assert.equal(consumed, maximum); assert.equal(stream.locked, false); assert.equal(result.jsonValid, shape !== 'invalid-tail');
		if (result.jsonValid) assert.ok(Object.is((result.body as { opaque: number }).opaque,
			shape === 'integer' ? Infinity : shape === 'balanced' ? 1 : shape === 'exponent' ? -0 : 0));
	});
}

for (const retainStringPages of [false, true]) for (const width of [1, 7, 8191]) {
	it(`consuming token ownership preserves nested duplicate and integer-key order, paged=${retainStringPages}, width=${width}`, async () => {
		const long = JSON.stringify('图\ud800💡\n'.repeat(4000));
		const raw = `{"9":{"gone":[${long},null,false,0]},"2":${long},"__proto__":{"old":${long}},"9":[true,null,-0],"2":[],"toJSON":"data","constructor":1,"__proto__":{"safe":${long}},"nested":{"x":[${long}],"x":{},"y":${long}},"0":false}`;
		const expected: unknown = JSON.parse(raw);
		const result = await segmentedJsonResponseWithinLimit(new Response(source(encode(raw), width)), maxBytes, limits, undefined,
			{ retainStringPages, nativeStringFields: ['__proto__'] });
		assert.equal(result.jsonValid, true); assert.deepEqual(materializeJsonStringTree(result.body), expected);
		assert.equal(JSON.stringify(materializeJsonStringTree(result.body)), JSON.stringify(expected));
	});
}

it('overwritten subtrees release without materializing either their long keys or nested values', async t => {
	const key = 'discard-key'.repeat(10000), value = 'discard-value'.repeat(10000), survivor = 'survives'.repeat(10000);
	const dead = `{${JSON.stringify(key)}:[{"inside":${JSON.stringify(value)}},null,false,-0]}`;
	const raw = `{"native":${dead},"keep":"${survivor}","na\\u0074ive":0,"nested":{"x":${dead},"x":true}}`;
	const expected: unknown = JSON.parse(raw), materialize = JsonStringPages.prototype.materialize; let joined = 0;
	t.mock.method(JsonStringPages.prototype, 'materialize', function(this: JsonStringPages) {
		assert.equal(this.length, survivor.length, 'dead keys/values must never join'); joined++; return materialize.call(this);
	});
	const result = await segmentedJsonResponseWithinLimit(new Response(source(encode(raw), 8191)), maxBytes, limits, undefined,
		{ retainStringPages: true, nativeStringFields: ['native', 'keep', 'nested'] });
	assert.equal(result.jsonValid, true); assert.equal(joined, 1); assert.deepEqual(result.body, expected);
});

it('restoration does not hold complete long names in a secondary Map', async t => {
	const key = 'key'.repeat(30000), raw = `{${JSON.stringify(key)}:0,${JSON.stringify(key)}:1,"keep":true}`;
	const expected: unknown = JSON.parse(raw), set = Map.prototype.set;
	t.mock.method(Map.prototype, 'set', function(this: Map<unknown, unknown>, name: unknown, value: unknown) {
		assert.ok(typeof name !== 'string' || name.length < 8192, 'no separate map of full restored keys'); return set.call(this, name, value);
	});
	const result = await segmentedJsonResponseWithinLimit(new Response(source(encode(raw), 8191)), maxBytes, limits, undefined, { retainStringPages: true });
	assert.equal(result.jsonValid, true); assert.deepEqual(result.body, expected);
});

it('in-place child restoration never invokes inherited setters or changes own data descriptors', async () => {
	const name = '__synthetic_restore_setter__'; let gets = 0, sets = 0;
	const raw = `{"${name}":{"x":0},"__proto__":{"polluted":true},"${name}":[1,2],"constructor":3,"toJSON":"data"}`;
	const expected: unknown = JSON.parse(raw);
	try {
		Object.defineProperty(Object.prototype, name, { configurable: true, get() { gets++; throw new Error('Must not get prototype'); }, set() { sets++; throw new Error('Must not set prototype'); } });
		const result = await segmentedJsonResponseWithinLimit(new Response(raw), maxBytes, limits, undefined, { retainStringPages: true });
		assert.deepEqual(result.body, expected); assert.equal(gets, 0); assert.equal(sets, 0);
		assert.equal(Object.getPrototypeOf(result.body), Object.prototype);
		for (const key of [name, '__proto__', 'constructor', 'toJSON']) {
			const descriptor = Object.getOwnPropertyDescriptor(result.body, key);
			assert.ok(descriptor && 'value' in descriptor && descriptor.enumerable && descriptor.configurable && descriptor.writable);
		}
	} finally { delete (Object.prototype as Record<string, unknown>)[name]; }
});

for (const phase of ['first-key', 'last-key', 'native-value']) for (const reasonKind of ['Error', 'SyntaxError', 'string']) {
	it(`restore cancellation at ${phase} preserves the exact ${reasonKind} reason after EOF`, async t => {
		const long = 'A'.repeat(20000), raw = phase === 'native-value' ? `{"native":"${long}"}` : `{"${long}":0,"B${long}":1}`;
		const response = new Response(source(encode(raw), 8191)), stream = response.body!, client = new AbortController();
		const reason = reasonKind === 'Error' ? new Error('Synthetic restore stop') : reasonKind === 'SyntaxError' ? new SyntaxError('Synthetic restore stop') : 'Synthetic restore stop';
		const materialize = JsonStringPages.prototype.materialize; let joins = 0;
		t.mock.method(JsonStringPages.prototype, 'materialize', function(this: JsonStringPages) {
			assert.equal(stream.locked, false, 'EOF reader ownership must already be released');
			const text = materialize.call(this); if (++joins === (phase === 'last-key' ? 2 : 1)) client.abort(reason); return text;
		});
		await assert.rejects(segmentedJsonResponseWithinLimit(response, maxBytes, limits, client.signal,
			{ retainStringPages: true, nativeStringFields: ['native'] }), error => error === reason);
		assert.equal(joins, phase === 'last-key' ? 2 : 1); assert.equal(stream.locked, false);
		assert.equal(getEventListeners(client.signal, 'abort').length, 0);
	});
}

for (const reasonKind of ['Error', 'SyntaxError']) it(`cancellation while dropping an overwritten subtree is not swallowed: ${reasonKind}`, async t => {
	const response = new Response('{"x":{"a":[null,false,0]},"x":1}'), client = new AbortController();
	const reason = reasonKind === 'Error' ? new Error('Synthetic discard stop') : new SyntaxError('Synthetic discard stop');
	const entries = Object.entries; let visits = 0;
	t.mock.method(Object, 'entries', ((value: object) => {
		const result = entries(value); if (!response.body!.locked && ++visits === 2) client.abort(reason); return result;
	}) as typeof Object.entries);
	await assert.rejects(segmentedJsonResponseWithinLimit(response, maxBytes, limits, client.signal, { retainStringPages: true }), error => error === reason);
	assert.equal(visits, 2); assert.equal(response.body!.locked, false); assert.equal(getEventListeners(client.signal, 'abort').length, 0);
});

it('invalid overwritten key escapes and container tails still require full native grammar rejection', async t => {
	const key = 'A'.repeat(20000);
	t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('No key restoration for invalid JSON'); });
	for (const raw of [`{"x":{"${key}\\x":0},"x":1}`, `{"x":{"${key}":0,},"x":1}`, `{"x":[0,],"x":1}`, `{"${key}":0,"${key}":1}[]`]) {
		const response = new Response(source(encode(raw), 8191)), stream = response.body!;
		const result = await segmentedJsonResponseWithinLimit(response, maxBytes, limits, undefined, { retainStringPages: true });
		assert.equal(result.jsonValid, false); assert.equal(stream.locked, false);
	}
});
