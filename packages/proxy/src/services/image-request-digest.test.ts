import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { JsonStringPages, JSON_TEXT_PAGE_CHARS } from './egress/json-string-pages';
import type { NormalizedImageEditRequest } from './egress/openai-images-driver';
import { createRequestDeadline, RequestExecutionStoppedError } from './request-deadline';
import { MultipartFile, readStreamingMultipartBody } from './streaming-multipart-body';
import {
	digestTrustedImageEditIngress,
	digestTrustedImageGenerationIngress,
} from './image-request-digest';

const domain = 'cinatoken.images.trusted-ingress.v1\n';
const expected = (value: unknown) => createHash('sha256').update(domain).update(JSON.stringify(value)).digest('hex');

function withDeadline<T>(work: (control: ReturnType<typeof createRequestDeadline>) => Promise<T>): Promise<T> {
	const control = createRequestDeadline(Date.now() + 10_000);
	return work(control).finally(() => control.dispose());
}

function file(name: string, bytes: Uint8Array, type = 'image/png'): MultipartFile {
	const result = new MultipartFile(name, type);
	result.append(bytes);
	result.seal();
	return result;
}

function edit(images: NormalizedImageEditRequest['images']): NormalizedImageEditRequest {
	return { prompt: 'paint a tree', n: 1, size: '1024x1024', quality: 'high', images };
}

test('generations hashes the parsed JSON tree and trusted session with an operation domain', async () => {
	await withDeadline(async control => {
		const body = { model: 'synthetic', prompt: 'snow\n', n: 1, image: ['data:image/png;base64,AQID'], request_sha256: 'caller-value' };
		const digest = await digestTrustedImageGenerationIngress({ body, sessionId: 'sticky', control });
		assert.equal(digest, expected({ operation: 'images.generations', sessionId: 'sticky', body }));
		assert.match(digest, /^[0-9a-f]{64}$/);
		assert.notEqual(digest, body.request_sha256);
		assert.notEqual(digest, await digestTrustedImageGenerationIngress({ body: { ...body, image: ['data:image/png;base64,AQIE'] }, sessionId: 'sticky', control }));
		assert.notEqual(digest, await digestTrustedImageGenerationIngress({ body, sessionId: null, control }));
		assert.notEqual(digest, await digestTrustedImageGenerationIngress({ body: { ...body, prompt: 'snow' }, sessionId: 'sticky', control }));
	});
});

test('large paged generations strings hash without materializing or buffering a whole JSON body', async t => {
	const first = 'x'.repeat(JSON_TEXT_PAGE_CHARS - 1) + '\ud83d';
	const second = '\ude00' + 'data:image/png;base64,' + 'A'.repeat(JSON_TEXT_PAGE_CHARS - 100);
	const paged = new JsonStringPages([first, second]);
	t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('whole string materialization forbidden'); });
	await withDeadline(async control => {
		const body = { model: 'synthetic', prompt: 'portrait', image: paged, options: { nested: ['\u0000', '"\\'] } };
		const digest = await digestTrustedImageGenerationIngress({ body, sessionId: null, control });
		assert.equal(digest, expected({
			operation: 'images.generations', sessionId: null,
			body: { ...body, image: first + second },
		}));
	});
});

test('edits bind accepted file bytes, length, ordered metadata and parsed provider', async () => {
	const a = file('a.png', new Uint8Array([0, 1, 2, 3]));
	const b = file('b.png', new Uint8Array([7, 8, 9]), 'image/jpeg');
	const aChanged = file('a.png', new Uint8Array([0, 1, 2, 4]));
	try {
		await withDeadline(async control => {
			const provider = { order: ['one', 'two'] };
			const params = { model: 'synthetic', provider, edit: edit([
				{ filename: 'a.png', mimeType: 'image/png', upload: a },
				{ filename: 'b.png', mimeType: 'image/jpeg', upload: b },
			]), sessionId: 'session', control };
			const digest = await digestTrustedImageEditIngress(params);
			assert.equal(digest, expected({
				operation: 'images.edits', sessionId: 'session', model: 'synthetic', provider,
				prompt: 'paint a tree', n: 1, size: '1024x1024', quality: 'high', background: null,
				extra: null,
				images: [
					{ filename: 'a.png', mimeType: 'image/png', size: 4, sha256: createHash('sha256').update(new Uint8Array([0, 1, 2, 3])).digest('hex') },
					{ filename: 'b.png', mimeType: 'image/jpeg', size: 3, sha256: createHash('sha256').update(new Uint8Array([7, 8, 9])).digest('hex') },
				],
			}));
			assert.notEqual(digest, await digestTrustedImageEditIngress({ ...params, edit: edit([
				{ filename: 'a.png', mimeType: 'image/png', upload: aChanged },
				{ filename: 'b.png', mimeType: 'image/jpeg', upload: b },
			]) }));
			assert.notEqual(digest, await digestTrustedImageEditIngress({ ...params, edit: edit([
				{ filename: 'b.png', mimeType: 'image/jpeg', upload: b },
				{ filename: 'a.png', mimeType: 'image/png', upload: a },
			]) }));
			assert.notEqual(digest, await digestTrustedImageEditIngress({ ...params, provider: { order: ['two', 'one'] } }));
			assert.notEqual(digest, await digestTrustedImageEditIngress({ ...params, edit: edit([
				{ filename: 'renamed.png', mimeType: 'image/png', upload: a },
				{ filename: 'b.png', mimeType: 'image/jpeg', upload: b },
			]) }));
			// The digest read must leave the retained page store available for a
			// permitted retry after a definitive upstream rejection.
			assert.deepEqual(new Uint8Array(await new Response(a.stream()).arrayBuffer()), new Uint8Array([0, 1, 2, 3]));
		});
	} finally { a.dispose(); b.dispose(); aChanged.dispose(); }
});

test('edits digest uses the multipart parser decoded file bytes, not base64 transport text', async () => {
	const boundary = 'digest-fixture';
	const wire = `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="source.png"\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\n\r\nAQIDBA==\r\n--${boundary}--\r\n`;
	await withDeadline(async control => {
		const parsed = await readStreamingMultipartBody(new Request('https://example.invalid/v1/images/edits', {
			method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: wire,
		}), { maxFiles: 5, maxFileBytes: 20 * 1024 * 1024 }, control);
		assert.ok(parsed.image instanceof MultipartFile);
		try {
			const digest = await digestTrustedImageEditIngress({
				model: 'synthetic', provider: null, sessionId: null, control,
				edit: edit([{ filename: parsed.image.name, mimeType: parsed.image.type, upload: parsed.image }]),
			});
			assert.equal(digest, expected({
				operation: 'images.edits', sessionId: null, model: 'synthetic', provider: null,
				prompt: 'paint a tree', n: 1, size: '1024x1024', quality: 'high', background: null, extra: null,
				images: [{ filename: 'source.png', mimeType: 'image/png', size: 4,
					sha256: createHash('sha256').update(new Uint8Array([1, 2, 3, 4])).digest('hex') }],
			}));
		} finally { parsed.image.dispose(); }
	});
});

test('edits reject unadmitted byte/blob representations and disposed files', async () => {
	await withDeadline(async control => {
		const base = { model: 'synthetic', provider: null, sessionId: null, control };
		await assert.rejects(digestTrustedImageEditIngress({ ...base, edit: edit([{ filename: 'raw.png', mimeType: 'image/png', bytes: new Uint8Array([1]) }]) }), /admitted multipart file/);
		await assert.rejects(digestTrustedImageEditIngress({ ...base, edit: edit([{ filename: 'blob.png', mimeType: 'image/png', blob: new Blob([new Uint8Array([1])]) }]) }), /admitted multipart file/);
		const disposed = file('gone.png', new Uint8Array([1]));
		disposed.dispose();
		await assert.rejects(digestTrustedImageEditIngress({ ...base, edit: edit([{ filename: 'gone.png', mimeType: 'image/png', upload: disposed }]) }), /unavailable/);
	});
});

test('cancellation during file hashing stops before a request digest is issued', async () => {
	const parent = new AbortController();
	const control = createRequestDeadline(Date.now() + 10_000, parent.signal);
	class CancellingFile extends MultipartFile {
		override stream(): ReadableStream<Uint8Array> {
			return new ReadableStream({ pull(controller) {
				controller.enqueue(new Uint8Array([1]));
				parent.abort();
			} });
		}
	}
	const uploaded = new CancellingFile('stop.png', 'image/png');
	uploaded.append(new Uint8Array([1, 2])); uploaded.seal();
	try {
		await assert.rejects(digestTrustedImageEditIngress({
			model: 'synthetic', provider: null, sessionId: null, control,
			edit: edit([{ filename: 'stop.png', mimeType: 'image/png', upload: uploaded }]),
		}), RequestExecutionStoppedError);
	} finally { uploaded.dispose(); control.dispose(); }
});
