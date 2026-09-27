import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { RouteResult } from './model-router';
import { JsonStringPages, JSON_TEXT_PAGE_CHARS } from './egress/json-string-pages';
import {
	dispatchOpenAiImageEdits,
	dispatchOpenAiImageGenerations,
	type NormalizedImageEditRequest,
} from './egress/openai-images-driver';
import {
	buildImageEditUpstreamFields,
	buildImageGenerationUpstreamBody,
	digestTrustedImageAttemptContext,
	preparedImageAttemptMatchesRoute,
} from './image-attempt-context';
import { createRequestDeadline, RequestExecutionStoppedError } from './request-deadline';
import { MultipartFile } from './streaming-multipart-body';

const requestSha256 = 'a'.repeat(64);
const hash = (domain: string, value: unknown) =>
	createHash('sha256').update(domain).update(JSON.stringify(value)).digest('hex');

function route(overrides: Partial<RouteResult> = {}): RouteResult {
	return {
		targetId: 'route-image', modelSurfaceId: 'surface-image', routePoolId: 'pool-image',
		providerId: 'provider-image', providerName: 'Image provider', providerModelName: 'provider-image-model',
		upstreamProtocol: 'openai', upstreamOperation: 'images.generations', adapter: 'passthrough',
		providerEndpoints: { openai: { base: 'https://provider.example/v1' } },
		providerApiKey: 'private-test-secret', providerKeyId: 'byok:key-a', providerKeyFingerprint: 'label-a',
		priceOverrideRaw: null, routeMeteredProfileJson: null, routeChargedProfileJson: null,
		customParams: null, routeGroup: 'default', routePriority: 1, routeWeight: 1,
		...overrides,
	};
}

function file(name: string, bytes: Uint8Array, mimeType = 'image/png'): MultipartFile {
	const upload = new MultipartFile(name, mimeType);
	upload.append(bytes);
	upload.seal();
	return upload;
}

async function withDeadline<T>(work: (control: ReturnType<typeof createRequestDeadline>) => Promise<T>): Promise<T> {
	const control = createRequestDeadline(Date.now() + 30_000);
	try { return await work(control); }
	finally { control.dispose(); }
}

test('generation attempt binds the actual driver JSON, post-Guardrail prompt, route and request digest', async () => {
	await withDeadline(async control => {
		const selected = route({ customParams: { custom: { fromRoute: 1 }, model: 'route-model', quality: 'medium' } });
		const body = { prompt: 'guarded prompt', n: 1, custom: { fromClient: 2 }, model: 'public-model' };
		let atBoundary = '';
		let capturedBody = '';
		const result = await dispatchOpenAiImageGenerations(selected, body, undefined, null, undefined, {
			fetchImpl: async (_url, init) => {
				capturedBody = await new Response(init?.body).text();
				return Response.json({ error: { message: 'retryable' } }, { status: 503 });
			},
		}, async () => {
			atBoundary = (await digestTrustedImageAttemptContext({
				operation: 'images.generations', requestSha256, route: selected, body, control,
			})).outboundPayloadSha256;
		});
		await result.response.text();
		assert.deepEqual(JSON.parse(capturedBody), {
			custom: { fromRoute: 1, fromClient: 2 }, model: 'provider-image-model',
			quality: 'medium', prompt: 'guarded prompt', n: 1,
		});
		assert.deepEqual(buildImageGenerationUpstreamBody(selected, body), JSON.parse(capturedBody));
		assert.equal(atBoundary, createHash('sha256').update('cinatoken.images.generation-egress.v1\n').update(capturedBody).digest('hex'));
		const baseline = await digestTrustedImageAttemptContext({ operation: 'images.generations', requestSha256, route: selected, body, control });
		assert.notEqual(baseline.contextSha256, (await digestTrustedImageAttemptContext({
			operation: 'images.generations', requestSha256, route: selected,
			body: { ...body, prompt: 'before Guardrails' }, control,
		})).contextSha256);
		assert.notEqual(baseline.contextSha256, (await digestTrustedImageAttemptContext({
			operation: 'images.generations', requestSha256, route: route({ ...selected, providerKeyId: 'byok:key-b' }), body, control,
		})).contextSha256);
		assert.notEqual(baseline.contextSha256, (await digestTrustedImageAttemptContext({
			operation: 'images.generations', requestSha256: 'b'.repeat(64), route: selected, body, control,
		})).contextSha256);
		assert.notEqual(baseline.contextSha256, (await digestTrustedImageAttemptContext({
			operation: 'images.generations', requestSha256, route: route({ ...selected,
				providerEndpoints: { openai: { base: 'https://other.example/v1' } } }), body, control,
		})).contextSha256);
	});
});

test('generation prepared attempt hashes the upload snapshot after caller mutations at the grant boundary', async () => {
	await withDeadline(async control => {
		const selected = route({
			customParams: { nested: { routeValue: 'prepared' } },
			providerKeyId: 'byok:prepared',
		});
		const body: Record<string, unknown> = { prompt: 'prepared prompt', n: 1, nested: { clientValue: 'prepared' } };
		const original = await digestTrustedImageAttemptContext({
			operation: 'images.generations', requestSha256, route: selected, body, control,
		});
		let preparedDigest: Awaited<typeof original> | undefined;
		let preparedIdentity: { targetId: string; providerKeyId: string | null; upstreamUrlSha256: string } | undefined;
		let capturedBody = '';
		const result = await dispatchOpenAiImageGenerations(selected, body, undefined, null, undefined, {
			fetchImpl: async (_url, init) => {
				capturedBody = await new Response(init?.body).text();
				return Response.json({ error: { message: 'known rejection' } }, { status: 503 });
			},
		}, async prepared => {
			assert.equal(preparedImageAttemptMatchesRoute(prepared, selected), true);
			assert.equal(preparedImageAttemptMatchesRoute(prepared, {
				...selected, providerEndpoints: { openai: { base: 'https://other.example/v1' } },
			}), false);
			body.prompt = 'mutated prompt';
			(body.nested as Record<string, unknown>).clientValue = 'mutated';
			(selected.customParams!.nested as Record<string, unknown>).routeValue = 'mutated';
			selected.providerKeyId = 'byok:mutated';
			selected.targetId = 'route-mutated';
			assert.equal(preparedImageAttemptMatchesRoute(prepared, selected), false);
			preparedIdentity = prepared.routeIdentity;
			preparedDigest = await prepared.digestTrustedContext(requestSha256, control);
			body.prompt = 'mutated again after digest';
			assert.ok(!JSON.stringify(prepared).includes('private-test-secret'));
			assert.ok(!JSON.stringify(prepared).includes('prepared prompt'));
			assert.ok(!JSON.stringify(prepared).includes('https://provider.example'));
		});
		await result.response.text();
		assert.deepEqual(JSON.parse(capturedBody), {
			nested: { routeValue: 'prepared', clientValue: 'prepared' },
			model: 'provider-image-model', prompt: 'prepared prompt', n: 1,
		});
		assert.deepEqual(preparedDigest, original);
		assert.equal(preparedDigest?.outboundPayloadSha256,
			createHash('sha256').update('cinatoken.images.generation-egress.v1\n').update(capturedBody).digest('hex'));
		assert.equal(preparedIdentity?.targetId, 'route-image');
		assert.equal(preparedIdentity?.providerKeyId, 'byok:prepared');
		assert.equal(preparedIdentity?.upstreamUrlSha256,
			createHash('sha256').update('https://provider.example/v1/images/generations').digest('hex'));
	});
});

test('paged generation data is hashed without a whole JSON body materialization', async t => {
	const paged = new JsonStringPages(['x'.repeat(JSON_TEXT_PAGE_CHARS), 'y'.repeat(JSON_TEXT_PAGE_CHARS)]);
	t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('materialize forbidden'); });
	await withDeadline(async control => {
		const result = await digestTrustedImageAttemptContext({
			operation: 'images.generations', requestSha256, route: route(),
			body: { prompt: 'guarded', image: paged }, control,
		});
		assert.equal(result.outboundPayloadSha256, hash('cinatoken.images.generation-egress.v1\n', {
			prompt: 'guarded', image: 'x'.repeat(JSON_TEXT_PAGE_CHARS) + 'y'.repeat(JSON_TEXT_PAGE_CHARS), model: 'provider-image-model',
		}));
	});
});

test('edit attempt binds the driver scalar form fields and decoded ordered file bytes', async () => {
	const upload = file('source.png', new Uint8Array([1, 2, 3, 4]));
	const changed = file('source.png', new Uint8Array([1, 2, 3, 5]));
	const second = file('second.png', new Uint8Array([7, 8, 9]));
	try {
		await withDeadline(async control => {
			const selected = route({
				upstreamOperation: 'images.edits',
				customParams: { route_only: 'kept', quality: 'low', model: 'ignored', image: 'ignored', ignored_object: { x: 1 } },
			});
			const edit: NormalizedImageEditRequest = {
				prompt: 'guarded\nedit prompt', n: 2, quality: 'high',
				extra: { client_flag: true, ignored_array: ['x'], images: 'ignored' },
				images: [{ filename: 'source.png', mimeType: 'image/png', upload }],
			};
			let capturedForm: FormData | undefined;
			let boundaryDigest = '';
			const result = await dispatchOpenAiImageEdits(selected, edit, undefined, null, undefined, {
				fetchImpl: async (_url, init) => {
					capturedForm = await new Response(init?.body, { headers: init?.headers }).formData();
					return Response.json({ error: { message: 'retryable' } }, { status: 503 });
				},
			}, async () => {
				boundaryDigest = (await digestTrustedImageAttemptContext({
					operation: 'images.edits', requestSha256, route: selected, edit, control,
				})).outboundPayloadSha256;
			});
			await result.response.text();
			assert.ok(capturedForm);
			const capturedFields: Array<[string, string]> = [];
			for (const [name, value] of capturedForm) if (typeof value === 'string') capturedFields.push([name, value]);
			assert.deepEqual(capturedFields, buildImageEditUpstreamFields(selected, edit));
			assert.deepEqual(capturedFields, [
				['model', 'provider-image-model'], ['route_only', 'kept'], ['quality', 'high'],
				['client_flag', 'true'], ['prompt', 'guarded\r\nedit prompt'], ['n', '2'],
			]);
			const capturedFile = capturedForm.get('image');
			assert.ok(capturedFile && typeof capturedFile !== 'string');
			assert.equal(capturedFile.name, 'source.png');
			assert.equal(capturedFile.type, 'image/png');
			const capturedBytes = new Uint8Array(await capturedFile.arrayBuffer());
			assert.deepEqual(capturedBytes, new Uint8Array([1, 2, 3, 4]));
			assert.equal(boundaryDigest, hash('cinatoken.images.edit-egress.v1\n', {
				fields: capturedFields, images: [{ filename: capturedFile.name, mimeType: capturedFile.type,
					size: capturedFile.size, sha256: createHash('sha256').update(capturedBytes).digest('hex') }],
			}));
			const baseline = await digestTrustedImageAttemptContext({ operation: 'images.edits', requestSha256, route: selected, edit, control });
			assert.notEqual(baseline.contextSha256, (await digestTrustedImageAttemptContext({
				operation: 'images.edits', requestSha256, route: selected,
				edit: { ...edit, images: [{ filename: 'source.png', mimeType: 'image/png', upload: changed }] }, control,
			})).contextSha256);
			assert.notEqual(baseline.contextSha256, (await digestTrustedImageAttemptContext({
				operation: 'images.edits', requestSha256, route: selected, edit: { ...edit, prompt: 'original edit prompt' }, control,
			})).contextSha256);
			const ordered = await digestTrustedImageAttemptContext({
				operation: 'images.edits', requestSha256, route: selected, control,
				edit: { ...edit, images: [...edit.images, { filename: 'second.png', mimeType: 'image/png', upload: second }] },
			});
			const reversed = await digestTrustedImageAttemptContext({
				operation: 'images.edits', requestSha256, route: selected, control,
				edit: { ...edit, images: [{ filename: 'second.png', mimeType: 'image/png', upload: second }, ...edit.images] },
			});
			assert.notEqual(ordered.outboundPayloadSha256, reversed.outboundPayloadSha256);
		});
	} finally { upload.dispose(); changed.dispose(); second.dispose(); }
});

test('edit prepared attempt hashes the exact scalar fields and sealed file sent after caller mutations', async () => {
	const upload = file('source.png', new Uint8Array([11, 12, 13, 14]));
	const replacement = file('replacement.png', new Uint8Array([21, 22]));
	try {
		await withDeadline(async control => {
			const selected = route({
				upstreamOperation: 'images.edits', providerKeyId: 'byok:prepared',
				customParams: { route_only: 'prepared' },
			});
			const edit: NormalizedImageEditRequest = {
				prompt: 'prepared edit prompt', n: 1,
				images: [{ filename: 'source.png', mimeType: 'image/png', upload }],
			};
			const original = await digestTrustedImageAttemptContext({
				operation: 'images.edits', requestSha256, route: selected, edit, control,
			});
			let preparedDigest: Awaited<typeof original> | undefined;
			let preparedIdentity: { providerKeyId: string | null; targetId: string } | undefined;
			let capturedForm: FormData | undefined;
			const result = await dispatchOpenAiImageEdits(selected, edit, undefined, null, undefined, {
				fetchImpl: async (_url, init) => {
					capturedForm = await new Response(init?.body, { headers: init?.headers }).formData();
					return Response.json({ error: { message: 'known rejection' } }, { status: 503 });
				},
			}, async prepared => {
				assert.equal(preparedImageAttemptMatchesRoute(prepared, selected), true);
				assert.throws(() => upload.append(new Uint8Array([99])), /not writable/);
				edit.prompt = 'mutated edit prompt';
				edit.images[0]!.filename = 'mutated.png';
				edit.images[0]!.mimeType = 'image/jpeg';
				edit.images = [{ filename: 'replacement.png', mimeType: 'image/png', upload: replacement }];
				selected.customParams = { route_only: 'mutated' };
				selected.providerKeyId = 'byok:mutated';
				selected.targetId = 'route-mutated';
				assert.equal(preparedImageAttemptMatchesRoute(prepared, selected), false);
				preparedIdentity = prepared.routeIdentity;
				preparedDigest = await prepared.digestTrustedContext(requestSha256, control);
			});
			await result.response.text();
			assert.ok(capturedForm);
			const actualFields: Array<[string, string]> = [];
			for (const [name, value] of capturedForm) if (typeof value === 'string') actualFields.push([name, value]);
			assert.deepEqual(actualFields, [
				['model', 'provider-image-model'], ['route_only', 'prepared'],
				['prompt', 'prepared edit prompt'], ['n', '1'],
			]);
			const actualFile = capturedForm.get('image');
			assert.ok(actualFile && typeof actualFile !== 'string');
			assert.equal(actualFile.name, 'source.png');
			assert.equal(actualFile.type, 'image/png');
			assert.deepEqual(new Uint8Array(await actualFile.arrayBuffer()), new Uint8Array([11, 12, 13, 14]));
			assert.deepEqual(preparedDigest, original);
			assert.equal(preparedDigest?.outboundPayloadSha256, hash('cinatoken.images.edit-egress.v1\n', {
				fields: actualFields,
				images: [{ filename: actualFile.name, mimeType: actualFile.type, size: actualFile.size,
					sha256: createHash('sha256').update(new Uint8Array(await actualFile.arrayBuffer())).digest('hex') }],
			}));
			assert.equal(preparedIdentity?.providerKeyId, 'byok:prepared');
			assert.equal(preparedIdentity?.targetId, 'route-image');
		});
	} finally { upload.dispose(); replacement.dispose(); }
});

test('edit metadata uses the driver filename fallback and normalized MIME', async () => {
	const upload = file('', new Uint8Array([4, 5, 6]), 'IMAGE/PNG');
	try {
		await withDeadline(async control => {
			const selected = route({ upstreamOperation: 'images.edits' });
			const edit: NormalizedImageEditRequest = {
				prompt: 'guarded', n: 1, images: [{ filename: '', mimeType: 'IMAGE/PNG', upload }],
			};
			const digest = await digestTrustedImageAttemptContext({
				operation: 'images.edits', requestSha256, route: selected, edit, control,
			});
			let actual!: FormData;
			const result = await dispatchOpenAiImageEdits(selected, edit, undefined, null, undefined, {
				fetchImpl: async (_url, init) => {
					actual = await new Response(init?.body, { headers: init?.headers }).formData();
					return Response.json({ error: { message: 'known-zero' } }, { status: 503 });
				},
			});
			await result.response.text();
			const actualFile = actual.get('image');
			assert.ok(actualFile && typeof actualFile !== 'string');
			assert.equal(actualFile.name, 'image.png');
			assert.equal(actualFile.type, 'image/png');
			assert.equal(digest.outboundPayloadSha256, hash('cinatoken.images.edit-egress.v1\n', {
				fields: [['model', 'provider-image-model'], ['prompt', 'guarded'], ['n', '1']],
				images: [{ filename: actualFile.name, mimeType: actualFile.type,
					size: actualFile.size, sha256: createHash('sha256').update(new Uint8Array(await actualFile.arrayBuffer())).digest('hex') }],
			}));
		});
	} finally { upload.dispose(); }
});

test('attempt digest rejects invented hashes and unadmitted files before a grant', async () => {
	await withDeadline(async control => {
		const selected = route();
		for (const invalid of ['A'.repeat(64), requestSha256 + '\n', 'client-value']) {
			await assert.rejects(digestTrustedImageAttemptContext({
				operation: 'images.generations', requestSha256: invalid, route: selected, body: { prompt: 'guarded' }, control,
			}), /trusted image request digest/);
		}
		await assert.rejects(digestTrustedImageAttemptContext({
			operation: 'images.edits', requestSha256, route: selected,
			edit: { prompt: 'guarded', n: 1, images: [{ filename: 'raw.png', mimeType: 'image/png', bytes: new Uint8Array([1]) }] }, control,
		}), /admitted multipart file/);
		const upload = file('raw.png', new Uint8Array([1]));
		try {
			await assert.rejects(digestTrustedImageAttemptContext({
				operation: 'images.edits', requestSha256, route: selected,
				edit: { prompt: 'guarded', n: 1, images: [{ filename: 'raw.png', mimeType: 'text/plain', upload }] }, control,
			}), /admitted multipart file/);
		} finally { upload.dispose(); }
	});
});

test('prepared edit grant rejects unsealed and overridden multipart files before fetch', async () => {
	class OverriddenStreamFile extends MultipartFile {
		override stream(): ReadableStream<Uint8Array> { return super.stream(); }
	}
	const unsealed = new MultipartFile('unsealed.png', 'image/png');
	unsealed.append(new Uint8Array([1, 2, 3]));
	const overridden = new OverriddenStreamFile('overridden.png', 'image/png');
	overridden.append(new Uint8Array([4, 5, 6])); overridden.seal();
	try {
		await withDeadline(async control => {
			for (const upload of [unsealed, overridden]) {
				let fetchCalls = 0;
				await assert.rejects(dispatchOpenAiImageEdits(
					route({ upstreamOperation: 'images.edits' }),
					{ prompt: 'guarded', n: 1, images: [{ filename: upload.name, mimeType: 'image/png', upload }] },
					undefined, null, undefined,
					{ fetchImpl: async () => { fetchCalls++; return Response.json({}); } },
					prepared => prepared.digestTrustedContext(requestSha256, control).then(() => undefined),
				), upload === unsealed ? /Multipart file is unavailable/ : /admitted multipart file/);
				assert.equal(fetchCalls, 0);
			}
		});
	} finally { unsealed.dispose(); overridden.dispose(); }
});

test('cancellation during streamed file hashing yields no attempt context', async () => {
	const parent = new AbortController();
	const control = createRequestDeadline(Date.now() + 10_000, parent.signal);
	class CancellingFile extends MultipartFile {
		override stream(): ReadableStream<Uint8Array> {
			return new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array([1])); parent.abort(); } });
		}
	}
	const upload = new CancellingFile('stop.png', 'image/png');
	upload.append(new Uint8Array([1, 2])); upload.seal();
	try {
		await assert.rejects(digestTrustedImageAttemptContext({
			operation: 'images.edits', requestSha256, route: route(), control,
			edit: { prompt: 'guarded', n: 1, images: [{ filename: 'stop.png', mimeType: 'image/png', upload }] },
		}), RequestExecutionStoppedError);
	} finally { upload.dispose(); control.dispose(); }
});
