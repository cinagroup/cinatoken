import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createRequestDeadline, RequestExecutionStoppedError } from './request-deadline';
import { MultipartBodyError } from './multipart-body-inspector';
import { MultipartFile, readStreamingMultipartBody, MULTIPART_FILE_PAGE_BYTES, type MultipartBody } from './streaming-multipart-body';
import { createMultipartUploadBody } from './egress/multipart-upload-body';

const boundary = 'synthetic-ababab-boundary', type = `multipart/form-data; boundary=${boundary}`;
const encode = (value: string) => new TextEncoder().encode(value);
const limits = { maxFiles: 5, maxFileBytes: 20 * 1024 * 1024 };
function part(name: string, payload: string, filename?: string, extra = '') {
	return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename === undefined ? '' : `; filename="${filename}"`}\r\n${extra}\r\n${payload}\r\n`;
}
const wire = (value: string) => encode(value + `--${boundary}--\r\n`);
function request(bytes: Uint8Array, width = bytes.length) {
	let offset = 0;
	const body = new ReadableStream<Uint8Array>({ pull(c) {
		if (offset === bytes.length) c.close(); else { const end = Math.min(bytes.length, offset + width); c.enqueue(bytes.subarray(offset, end)); offset = end; }
	} }, { highWaterMark: 0 });
	const init = { method: 'POST', headers: { 'Content-Type': type }, body, duplex: 'half' };
	return new Request('https://synthetic.invalid/', init);
}
function dispose(body: MultipartBody) { for (const entry of Object.values(body).flat()) if (entry instanceof MultipartFile) entry.dispose(); }
async function bytesOf(file: MultipartFile | Blob) { return new Uint8Array(await new Response(file.stream()).arrayBuffer()); }
async function compare(bytes: Uint8Array, width: number) {
	const native = await new Response(bytes, { headers: { 'Content-Type': type } }).formData();
	const actual = await readStreamingMultipartBody(request(bytes, width), limits);
	try {
		assert.equal(Object.getPrototypeOf(actual), null);
		assert.deepEqual(Object.keys(actual), [...new Set(native.keys())]);
		for (const key of native.keys()) {
			const values = actual[key], entries = Array.isArray(values) ? values : [values];
			assert.equal(Array.isArray(values), native.getAll(key).length > 1 || key.endsWith('[]'));
			for (const [i, expected] of native.getAll(key).entries()) {
				const value = entries[i];
				if (typeof expected === 'string') assert.equal(value, expected);
				else {
					assert.ok(value instanceof MultipartFile); assert.equal(value.name, expected.name); assert.equal(value.type, expected.type);
					assert.equal(value.size, expected.size); assert.deepEqual(await bytesOf(value), await bytesOf(expected));
				}
			}
		}
	} finally { dispose(actual); }
}

for (const width of [1, 2, 3, 7, 31, 256, 65536]) {
	it(`native differential: binary, Unicode, duplicate/array/prototype keys; ${width}-byte fragments`, async () => {
		const bytes = wire(part('model', '\ufeffsynthetic💡') + part('prompt', '\0\ufffd图') + part('image[]', '\0💡\r\nbody', '图; x.png', 'Content-Type: IMAGE/PNG\r\n')
			+ part('image[]', 'second', 'empty-name.png') + part('__proto__', 'own property') + part('constructor', 'scalar') + part('repeat', '') + part('repeat', 'second') + part('scalar[]', 'one'));
		await compare(bytes, width);
	});
}
for (const filename of ['', 'x%22y.png', 'C:\\folder\\image.png', '../relative.png', '图.png']) {
	it(`native filename metadata preserved: ${JSON.stringify(filename)}`, () => compare(wire(part('image', 'binary', filename)), 1));
}
for (const encoding of ['base64', 'BASE64', 'binary', '8bit', 'unknown']) {
	it(`native transfer encoding semantics for both file and scalar: ${encoding}`, async () => {
		await compare(wire(part('image', 'Q U\r\nJD-_8=ignored', 'x.png', `Content-Transfer-Encoding: ${encoding}\r\n`)
			+ part('field', '8J+SoQ==', undefined, `Content-Transfer-Encoding: ${encoding}\r\n`)), 1);
	});
}
for (const encoded of ['A', 'AQ', 'AQI', 'AQID', '=AQID', 'AQ==ID', 'AQ!💡ID', 'AQĀŁID', '-_8_', '////', '77u/YWJj']) {
	it(`base64 fragmented decoder matches native for ${JSON.stringify(encoded)}`, () => compare(wire(part('image', encoded, 'x.png', 'Content-Transfer-Encoding: base64\r\n')), 2));
}
for (const payload of ['\r', '\r\n', `\r\n--${boundary}X`, `\r\n--${boundary}-X`, `\r\n--${boundary}\rX`,
	`\r\n--${boundary} \t X`, `\r\n--${boundary}\r\r\n--${boundary}X`]) {
	it(`scanner emits false boundary bytes exactly: ${JSON.stringify(payload)}`, async () => {
		const bytes = wire(part('image', payload, 'x.png'));
		for (let split = 1; split <= bytes.length; split++) {
			const body = await readStreamingMultipartBody(request(bytes, split), limits);
			try { assert.ok(body.image instanceof MultipartFile); assert.deepEqual(await bytesOf(body.image), encode(payload)); }
			finally { dispose(body); }
		}
	});
}

it('owned pages do not alias a reused network buffer, grow by pages, and are explicitly released', async () => {
	const file = new MultipartFile('x.png', 'image/png'), scratch = new Uint8Array(MULTIPART_FILE_PAGE_BYTES).fill(7);
	file.append(scratch); scratch.fill(9); file.append(scratch.subarray(0, 3)); file.seal();
	assert.equal(file.size, MULTIPART_FILE_PAGE_BYTES + 3); assert.equal(file.retainedBytes, MULTIPART_FILE_PAGE_BYTES * 2);
	const first = file.stream().getReader(); const page = await first.read(); assert.ok(page.value); page.value.fill(0); await first.cancel(); first.releaseLock();
	const copy = await bytesOf(file); assert.equal(copy[0], 7); assert.equal(copy.at(-1), 9);
	assert.throws(() => file.append(scratch));
	const unread = file.stream(); file.dispose(); file.dispose();
	assert.equal(file.retainedBytes, 0); await assert.rejects(new Response(unread).arrayBuffer(), /unavailable/);
	await assert.rejects(new Response(file.stream()).arrayBuffer(), /unavailable/);
});

it('large input enters native formData only through tiny metadata probes', async t => {
	const native = Response.prototype.formData;
	const originalBytes = MULTIPART_FILE_PAGE_BYTES * 3 + 1;
	const req = request(wire(part('image', 'x'.repeat(originalBytes), 'x.png')), 257);
	let probes = 0;
	t.mock.method(Response.prototype, 'formData', async function(this: Response) {
		const bytes = await this.arrayBuffer(); probes++; assert.ok(bytes.byteLength < 20000);
		return native.call(new Response(bytes, { headers: this.headers }));
	});
	const body = await readStreamingMultipartBody(req, limits);
	try { assert.ok(body.image instanceof MultipartFile); assert.equal(body.image.size, originalBytes); assert.equal(probes, 1); }
	finally { dispose(body); }
});

for (const stop of ['client', 'deadline', 'invalid-tail'] as const) {
	it(`partial upload ${stop} releases all retained pages and reader, without waiting for cancel ACK`, async t => {
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
		const client = new AbortController(), deadline = createRequestDeadline(100, client.signal); t.after(() => deadline.dispose());
		const owned: MultipartFile[] = [], originalAppend = MultipartFile.prototype.append;
		t.mock.method(MultipartFile.prototype, 'append', function(this: MultipartFile, bytes: Uint8Array) { if (!owned.includes(this)) owned.push(this); originalAppend.call(this, bytes); });
		let pulls = 0, cancels = 0;
		const source = new ReadableStream<Uint8Array>({ pull(c) {
			if (++pulls === 1) c.enqueue(encode(part('image', 'x'.repeat(100000), 'x.png')));
			else if (stop === 'invalid-tail') c.close();
		}, cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
		const init = { method: 'POST', body: source, headers: { 'Content-Type': type }, duplex: 'half' };
		const req = new Request('https://synthetic.invalid/', init);
		const pending = assert.rejects(readStreamingMultipartBody(req, limits, deadline), stop === 'invalid-tail' ? MultipartBodyError : RequestExecutionStoppedError);
		for (let i = 0; i < 100 && owned.length === 0; i++) await nextTurn(); assert.equal(owned.length, 1);
		if (stop === 'client') client.abort(); else if (stop === 'deadline') t.mock.timers.tick(100);
		await pending; assert.equal(owned[0]!.retainedBytes, 0); assert.equal(source.locked, false);
		assert.equal(cancels, stop === 'invalid-tail' ? 0 : 1); assert.equal(getEventListeners(deadline.signal, 'abort').length, 0);
	});
}

for (const stop of ['client', 'deadline'] as const) {
	it(`late metadata probe after ${stop} cannot create or retain a file`, async t => {
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
		const client = new AbortController(), deadline = createRequestDeadline(100, client.signal); t.after(() => deadline.dispose());
		let resolve!: (form: FormData) => void, entered = false;
		t.mock.method(Response.prototype, 'formData', () => { entered = true; return new Promise<FormData>(done => { resolve = done; }); });
		const append = t.mock.method(MultipartFile.prototype, 'append');
		const pending = assert.rejects(readStreamingMultipartBody(request(wire(part('image', 'payload', 'x.png'))), limits, deadline), RequestExecutionStoppedError);
		for (let i = 0; i < 100 && !entered; i++) await nextTurn(); assert.ok(entered);
		if (stop === 'client') client.abort(); else t.mock.timers.tick(100);
		await pending; const form = new FormData(); form.append('image', new File(['QUJD'], 'x.png')); resolve(form); await nextTurn();
		assert.equal(append.mock.callCount(), 0);
	});
}

it('outbound multipart round-trips metadata/fields and streams bounded pages without consuming replay storage', async () => {
	const file = new MultipartFile('图"\r\n.png', 'image/png'); file.append(new Uint8Array(MULTIPART_FILE_PAGE_BYTES * 2 + 3).fill(42)); file.seal();
	const fields = new FormData(); fields.set('model', 'synthetic'); fields.set('prompt', 'a\nb\rc'); fields.append('repeat', '1'); fields.append('repeat', '2');
	const signal = new AbortController().signal;
	try {
		for (let attempt = 0; attempt < 2; attempt++) {
			const upload = createMultipartUploadBody(fields, [{ filename: file.name, mimeType: file.type, payload: file }], signal);
			let size = 0; const reader = upload.body.getReader(), chunks: Uint8Array[] = [];
			while (true) { const result = await reader.read(); if (result.done) break; assert.ok(result.value.length <= MULTIPART_FILE_PAGE_BYTES); size += result.value.length; chunks.push(result.value); }
			reader.releaseLock(); assert.equal(size, upload.contentLength); upload.dispose();
			const form = await new Response(new Blob(chunks), { headers: { 'Content-Type': upload.contentType } }).formData();
			assert.equal(form.get('prompt'), 'a\r\nb\r\nc'); assert.deepEqual(form.getAll('repeat'), ['1', '2']);
			const image = form.get('image'); assert.ok(image instanceof File); assert.equal(image.name, file.name);
			assert.equal(image.size, file.size); assert.deepEqual(await bytesOf(image), await bytesOf(file));
			assert.equal(getEventListeners(signal, 'abort').length, 0);
		}
	} finally { file.dispose(); }
});
for (const end of ['cancel', 'abort', 'dispose', 'file-release'] as const) {
	it(`outbound ${end} releases readers/listeners even if upload never finishes`, async () => {
		const file = new MultipartFile('x.png', 'image/png'); file.append(encode('payload')); file.seal();
		const client = new AbortController(), upload = createMultipartUploadBody(new FormData(), [{ filename: file.name, mimeType: file.type, payload: file }], client.signal);
		const reader = upload.body.getReader(); await reader.read(); await reader.read();
		if (end === 'cancel') await reader.cancel();
		else {
			if (end === 'abort') client.abort(); else if (end === 'dispose') upload.dispose(); else file.dispose();
			await assert.rejects(reader.read());
		}
		reader.releaseLock(); upload.dispose(); file.dispose();
		assert.equal(getEventListeners(client.signal, 'abort').length, 0); assert.equal(file.retainedBytes, 0);
	});
}
