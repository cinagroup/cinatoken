import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { boundRequestBody } from './bounded-request-body';
import { createRequestDeadline, RequestExecutionStoppedError } from './request-deadline';
import {
	createMultipartBodyInspector, MultipartBodyError, MULTIPART_MAX_FIELD_BYTES,
	MULTIPART_MAX_FIELDS_BYTES, MULTIPART_MAX_HEADER_BYTES, MULTIPART_MAX_PARTS,
} from './multipart-body-inspector';

const BOUNDARY = '----synthetic-multipart-resource-boundary';
const TYPE = `multipart/form-data; boundary="${BOUNDARY}"`;
const encoder = new TextEncoder();
function part(name: string, body = '', filename?: string, boundary = BOUNDARY, extra = '') {
	return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename === undefined ? '' : `; filename="${filename}"`}\r\n${extra}\r\n${body}\r\n`;
}
function wire(parts: string, boundary = BOUNDARY) { return encoder.encode(parts + `--${boundary}--\r\n`); }
function checker(contentType = TYPE, maxFileBytes = 100, maxFiles = 5) {
	return createMultipartBodyInspector(contentType, { maxFileBytes, maxFiles });
}
async function check(bytes: Uint8Array, options: { split?: number; type?: string; maxFileBytes?: number; maxFiles?: number } = {}) {
	const inspector = checker(options.type, options.maxFileBytes, options.maxFiles);
	try {
		const split = options.split ?? bytes.length;
		await inspector.write(bytes.subarray(0, split)); await inspector.write(bytes.subarray(split)); await inspector.end();
	} finally { inspector.dispose(); }
}
function failure(reason: MultipartBodyError['failure'], status?: number) {
	return (error: unknown) => {
		assert.ok(error instanceof MultipartBodyError);
		assert.equal(error.failure, reason);
		if (status !== undefined) assert.equal(error.status, status);
		assert.doesNotMatch(error.message, /PRIVATE_DETAIL/); return true;
	};
}

for (const boundary of ['x', 'abababa', BOUNDARY, "'()+_,-./:=?", 'boundary with spaces', 'a'.repeat(70)]) {
	it(`every two-chunk split preserves valid framing: boundary length ${boundary.length}`, async () => {
		const bytes = wire(part('model', 'synthetic', undefined, boundary) + part('image', 'abc', '图.png', boundary), boundary);
		for (let split = 0; split <= bytes.length; split++) {
			await check(bytes, { split, type: `multipart/form-data; boundary="${boundary}"`, maxFileBytes: 3 });
		}
	});
}

for (const data of ['\r', '\r\n', `\r\n--${BOUNDARY}X`, `\r\n--${BOUNDARY}-X`, `\r\n--${BOUNDARY}\rX`,
	`\r\n--${BOUNDARY}\r\r\n--${BOUNDARY}X`, '\0\u0001\ufffd', '💡'.repeat(7)]) {
	it(`counts binary false-boundary payload exactly (${JSON.stringify(data)})`, async () => {
		const bytes = wire(part('image', data, 'synthetic.png')), size = encoder.encode(data).length;
		for (let split = 0; split <= bytes.length; split++) await check(bytes, { split, maxFileBytes: size });
		await assert.rejects(check(bytes, { maxFileBytes: size - 1 }), failure('file_size', 400));
	});
}

for (const width of [1, 2, 3, 7, 31, 64, 4096]) {
	it(`repeated ${width}-byte fragments preserve header and body accounting`, async () => {
		const bytes = wire(part('provider', '{"data_collection":"deny"}') + part('image[]', 'synthetic', 'x.png'));
		const inspector = checker();
		try { for (let i = 0; i < bytes.length; i += width) await inspector.write(bytes.subarray(i, i + width)); await inspector.end(); }
		finally { inspector.dispose(); }
	});
}

for (const padding of [' ', '\t', ' \t \t']) {
	it(`accepts bounded transport padding across every split (${JSON.stringify(padding)})`, async () => {
		const text = part('image', 'abc', 'x.png').replace(`--${BOUNDARY}\r\n`, `--${BOUNDARY}${padding}\r\n`);
		const bytes = wire(text);
		for (let split = 0; split <= bytes.length; split++) await check(bytes, { split, maxFileBytes: 3 });
	});
}
for (const preamble of ['synthetic preamble\r\n', 'synthetic inline preamble']) {
	it(`counts the first file across every split with ${JSON.stringify(preamble)}`, async t => {
		const bytes = wire(preamble + part('image', 'abc', 'x.png') + part('image', 'def', 'y.png'));
		for (let split = 0; split <= bytes.length; split++) {
			await check(bytes, { split, maxFileBytes: 3, maxFiles: 2 });
			await assert.rejects(check(bytes, { split, maxFiles: 1 }), failure('files', 400));
		}
		// Native preamble support differs between Node versions; inspector limits above are mandatory.
		let native: FormData;
		try { native = await new Response(bytes, { headers: { 'Content-Type': TYPE } }).formData(); }
		catch (error) {
			assert.ok(error instanceof TypeError);
			assert.equal(error.message, 'Failed to parse body as FormData.');
			t.diagnostic(`Native parser rejects the preamble on ${process.version}`);
			return;
		}
		assert.equal(native.getAll('image').length, 2);
	});
}
it('unfinished transport padding has a finite framing limit', async () => {
	await assert.rejects(check(encoder.encode(`--${BOUNDARY}` + ' '.repeat(16385))), failure('framing', 413));
});
for (const filename of ['', 'x; y.png']) {
	it(`uses native file classification for ${JSON.stringify(filename)}`, async () => {
		const bytes = wire(part('image', 'abc', filename));
		const native = await new Response(bytes, { headers: { 'Content-Type': TYPE } }).formData();
		const isFile = native.get('image') instanceof Blob;
		await check(bytes);
		if (isFile) await assert.rejects(check(bytes, { maxFiles: 0 }), failure('files', 400));
	});
}
it('deterministic binary fuzz preserves exact byte accounting under irregular fragmentation', async () => {
	let seed = 104729;
	const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
	for (let run = 0; run < 40; run++) {
		const payload = new Uint8Array(512 + run); for (let i = 0; i < payload.length; i++) payload[i] = next() >>> 24;
		const head = encoder.encode(part('image', '', 'x.png').slice(0, -2)), tail = encoder.encode(`\r\n--${BOUNDARY}--\r\n`);
		const bytes = new Uint8Array(head.length + payload.length + tail.length); bytes.set(head); bytes.set(payload, head.length); bytes.set(tail, head.length + payload.length);
		const inspector = checker(TYPE, payload.length);
		try {
			for (let cursor = 0; cursor < bytes.length;) { const end = Math.min(bytes.length, cursor + 1 + next() % 107); await inspector.write(bytes.subarray(cursor, end)); cursor = end; }
			await inspector.end();
		} finally { inspector.dispose(); }
		await assert.rejects(check(bytes, { maxFileBytes: payload.length - 1 }), failure('file_size', 400));
	}
});

for (const type of ['', 'application/json', 'multipart/form-data', 'multipart/form-data; boundary=""',
	'multipart/form-data; boundary="ends with space "', 'multipart/form-data; boundary="bad💡"',
	'multipart/form-data; boundary=' + 'b'.repeat(71), TYPE + '; boundary=other', TYPE + ';broken', TYPE + 'z',
	'multipart/form-data; boundary="PRIVATE_DETAIL\\\r\n"', TYPE + ';x=' + 'a'.repeat(1024)]) {
	it(`rejects invalid or ambiguous boundary (${type.slice(0, 85)})`, async () => {
		await assert.rejects(check(wire(part('image', 'abc', 'x.png')), { type }), failure('boundary', 400));
	});
}
for (const type of [TYPE + '; charset=utf-8', `MULTIPART/FORM-DATA; charset="utf-8"; BOUNDARY="${BOUNDARY}"`,
	`multipart/form-data; boundary=${BOUNDARY}`]) {
	it(`accepts unambiguous content-type parameters (${type})`, async () => { await check(wire(part('image', 'abc', 'x.png')), { type }); });
}

for (const name of ['image', 'images', 'image[]', 'image_2', 'IMAGE', '__proto__', 'ignored-file']) {
	it(`counts every file irrespective of field spelling (${name})`, async () => {
		await check(wire(part(name, 'abc', 'x.png')), { maxFiles: 1 });
		await assert.rejects(check(wire(part(name, 'abc', 'x.png') + part('ignored', '', 'y.png')), { maxFiles: 1 }), failure('files', 400));
	});
}

for (const bytesOver of [0, 1]) {
	it(`scalar byte limit ${bytesOver === 0 ? 'inclusive' : 'overflow'}, independent of UTF-16 character count`, async () => {
		const body = '💡'.repeat(MULTIPART_MAX_FIELD_BYTES / 4) + 'x'.repeat(bytesOver);
		const result = check(wire(part('unknown', body)));
		if (bytesOver) await assert.rejects(result, failure('field_size', 413)); else await result;
	});
	it(`aggregate scalar limit ${bytesOver === 0 ? 'inclusive' : 'overflow'}`, async () => {
		const fields = part('repeated', 'x'.repeat(MULTIPART_MAX_FIELD_BYTES)).repeat(MULTIPART_MAX_FIELDS_BYTES / MULTIPART_MAX_FIELD_BYTES);
		const result = check(wire(fields + part('repeated', 'x'.repeat(bytesOver))));
		if (bytesOver) await assert.rejects(result, failure('fields_size', 413)); else await result;
	});
	it(`multipart part limit ${bytesOver === 0 ? 'inclusive' : 'overflow'}`, async () => {
		const result = check(wire(part('repeated', '').repeat(MULTIPART_MAX_PARTS + bytesOver)));
		if (bytesOver) await assert.rejects(result, failure('parts', 413)); else await result;
	});
}

for (const fragment of ['', `--${BOUNDARY}`, part('image', 'abc', 'x.png'), `--${BOUNDARY}\r\nContent-Disposition: form-data; name="x"\r\n`]) {
	it(`requires a complete closing delimiter (${fragment.length} bytes)`, async () => {
		await assert.rejects(check(encoder.encode(fragment)), failure('malformed', 400));
	});
}

for (const headers of ['Bad header\r\n', 'Content-Disposition: form-data\r\n', 'Content-Disposition: form-data; name="PRIVATE_DETAIL"\r\ninvalid\r\n']) {
	it(`native metadata probe rejects malformed part headers (${headers.length} bytes)`, async () => {
		await assert.rejects(check(wire(`--${BOUNDARY}\r\n${headers}\r\nabc\r\n`)), failure('malformed', 400));
	});
}

it('header bytes are capped before a missing terminator can finish', async () => {
	const inspector = checker();
	await assert.rejects(async () => inspector.write(encoder.encode(`--${BOUNDARY}\r\nX-Long: ` + 'x'.repeat(MULTIPART_MAX_HEADER_BYTES))), failure('headers', 413));
	inspector.dispose();
});
it('preamble and epilogue are not an unlimited field-size escape', async () => {
	await assert.rejects(check(encoder.encode('x'.repeat(16385))), failure('framing', 413));
	await assert.rejects(check(wire(part('image', 'a', 'x.png') + `--${BOUNDARY}--\r\n` + 'x'.repeat(16385))), failure('framing', 413));
});

it('wire bytes reach the native form parser unchanged, with no file copy API calls', async t => {
	const deadline = createRequestDeadline(Date.now() + 3000); t.after(() => deadline.dispose());
	const bytes = wire(part('model', 'synthetic') + part('image', 'abc\0def', '图.png', BOUNDARY, 'Content-Type: image/png\r\n'));
	let offset = 0;
	const source = new ReadableStream<Uint8Array>({ pull(c) { if (offset === bytes.length) c.close(); else c.enqueue(bytes.subarray(offset, ++offset)); } }, { highWaterMark: 0 });
	const upload = boundRequestBody(source, deadline, bytes.length, checker());
	const copy = t.mock.method(Blob.prototype, 'arrayBuffer', () => { throw new Error('Unexpected file copy'); });
	const form = await new Response(upload.body, { headers: { 'Content-Type': TYPE } }).formData();
	assert.equal(form.get('model'), 'synthetic'); const file = form.get('image'); assert.ok(file instanceof File);
	assert.equal(file.type, 'image/png'); assert.equal(file.name, '图.png'); assert.equal(file.size, 7);
	assert.equal(copy.mock.callCount(), 0); copy.mock.restore(); assert.equal(await file.text(), 'abc\0def');
	assert.equal(source.locked, false); assert.equal(getEventListeners(deadline.signal, 'abort').length, 0);
});

for (const reason of ['file_size', 'files', 'field_size', 'headers', 'parts'] as const) {
	it(`stops before requesting a withheld tail on ${reason}, without waiting for cancel ACK`, async t => {
		const deadline = createRequestDeadline(Date.now() + 3000); t.after(() => deadline.dispose());
		const head = reason === 'headers' ? `--${BOUNDARY}\r\nX-Long: ` + 'x'.repeat(MULTIPART_MAX_HEADER_BYTES)
			: reason === 'parts' ? part('x').repeat(MULTIPART_MAX_PARTS) + part('last')
				: reason === 'files' ? part('image', 'abc', 'x.png') + part('unknown', '', 'y.png')
					: part(reason === 'field_size' ? 'x' : 'image', 'x'.repeat(reason === 'field_size' ? MULTIPART_MAX_FIELD_BYTES + 100 : 200), reason === 'field_size' ? undefined : 'x.png');
		let pulls = 0, cancels = 0;
		const source = new ReadableStream<Uint8Array>({ pull(c) { if (++pulls === 1) c.enqueue(encoder.encode(head)); else throw new Error('Must not pull tail'); },
			cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
		const upload = boundRequestBody(source, deadline, 1024 * 1024, checker(TYPE, 100, 1));
		await assert.rejects(new Response(upload.body).text(), failure(reason));
		assert.equal(pulls, 1); assert.equal(cancels, 1); assert.equal(source.locked, false);
		assert.equal(getEventListeners(deadline.signal, 'abort').length, 0);
	});
}

for (const stop of ['client', 'deadline'] as const) {
	it(`${stop} cancels an in-flight header probe and observes its late result`, async t => {
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
		const parent = new AbortController(), deadline = createRequestDeadline(100, parent.signal); t.after(() => deadline.dispose());
		let complete!: (form: FormData) => void, entered = false, cancels = 0;
		t.mock.method(Response.prototype, 'formData', () => { entered = true; return new Promise<FormData>(done => { complete = done; }); });
		const bytes = wire(part('image', 'abc', 'x.png'));
		const source = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(bytes); }, cancel() { cancels++; } }, { highWaterMark: 0 });
		const upload = boundRequestBody(source, deadline, bytes.length, checker());
		const pending = assert.rejects(new Response(upload.body).text(), RequestExecutionStoppedError);
		for (let i = 0; i < 50 && !entered; i++) await nextTurn(); assert.equal(entered, true);
		if (stop === 'client') parent.abort(); else t.mock.timers.tick(100);
		await pending; const form = new FormData(); form.set('image', new File(['abc'], 'x.png')); complete(form); await nextTurn();
		assert.equal(cancels, 1); assert.equal(source.locked, false); assert.equal(getEventListeners(deadline.signal, 'abort').length, 0);
	});
}
