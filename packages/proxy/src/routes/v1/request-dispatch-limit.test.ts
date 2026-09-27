import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, it } from 'node:test';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import {
	computeRouteDataPolicySubjectFingerprintFromRows, createD1StorageContext,
	createEncryptedProvidersRepository,
	clearGcpServiceAccountTokenCache, GCP_OAUTH_TOKEN_URL,
	type EffectiveGuardrailRow, type GatewayRepositories, type ModelRow, type ModelRouteRow,
	type ProviderRow, type RequestPresetWithVersionRow, type ResolvedGatewayKeyRow,
	type StorageContext,
} from '@octafuse/core';
import { createProxyApp } from '../../app';
import { drainNodeBackgroundWork } from '../../runtime/schedule-background-work';
import { createRequestCapacityPool } from '../../services/request-capacity';
import { resetProviderCircuitStateForTests } from '../../services/provider-circuit-breaker';
import { resetUserModelCircuitStateForTests } from '../../services/user-model-circuit-breaker';
import { TEXT_REQUEST_DEADLINE_MS } from '../../services/request-deadline';
import { MAX_REQUEST_BODY_BYTES } from '../../services/bounded-request-body';
import { isGeminiInferenceRequest, isTextInferenceRequest } from '../../middleware/text-request-lifecycle';
import type { GuardrailBudgetRequestPort } from '../../services/request-budget-admission';

const NOW = '2026-09-05T00:00:00.000Z';
const MODEL_IDS = ['model-0', 'model-1', 'model-2', 'model-3', 'model-4'];

const textJsonResourceRoutes = [
	['/v1/chat/completions', 'chat', 'model'], ['/api/v1/chat/completions', 'chat', 'none'],
	['/v1/completions', 'chat', 'model'], ['/api/v1/completions', 'chat', 'none'],
	['/v1/responses', 'responses', 'model'], ['/api/v1/responses', 'responses', 'none'],
	['/v1/messages', 'messages', 'model'], ['/api/v1/messages', 'messages', 'none'],
	['/v1beta/models/model-0:generateContent', 'models.generate', 'model'],
] as const;
function textJsonResourceInput(path: string, operation: string, partition: string) {
	return JSON.stringify(operation === 'models.generate' ? { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } : {
		model: MODEL_IDS[0], models: MODEL_IDS, provider: { sort: { by: 'price', partition } },
		...(path.endsWith('/completions') && !path.includes('/chat/') ? { prompt: 'hi' }
			: operation === 'responses' ? { input: 'hi' } : { messages: [{ role: 'user', content: 'hi' }] }),
	});
}
function textUploadSuccessReply(operation: string, stream: boolean) {
	const usage = { input_tokens: 2, output_tokens: 3, total_tokens: 5 };
	const chatUsage = { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 };
	const geminiUsage = { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 };
	const value = operation === 'chat' ? { id: 'synthetic', object: 'chat.completion', created: 1, model: 'private', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: chatUsage }
		: operation === 'responses' ? { id: 'synthetic', object: 'response', created_at: 1, completed_at: 2, status: 'completed', model: 'private', output: [], usage }
		: operation === 'messages' ? { id: 'synthetic', type: 'message', role: 'assistant', model: 'private', content: [], stop_reason: 'end_turn', stop_sequence: null, usage }
		: { responseId: 'synthetic', candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: geminiUsage };
	if (!stream) return Response.json(value);
	const event = (data: unknown) => 'data: ' + JSON.stringify(data) + '\n\n';
	const sse = operation === 'chat' ? event({ id: 'synthetic', choices: [], usage: chatUsage }) + 'data: [DONE]\n\n'
		: operation === 'responses' ? event({ type: 'response.completed', response: value }) + 'data: [DONE]\n\n'
		: operation === 'messages' ? event({ type: 'message_start', message: { id: 'synthetic', usage } }) + event({ type: 'message_stop' })
		: event({ usageMetadata: geminiUsage });
	return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
}

for (const [path, operation, partition] of textJsonResourceRoutes) for (const stop of ['client', 'deadline']) for (const lateOutcome of ['resolve', 'reject']) {
	it(`preparation read resource public ${path}/${stop}/${lateOutcome}`, { timeout: 5000 }, async t => {
		for (const name of ['log', 'warn', 'error'] as const) t.mock.method(console, name, () => {});
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
		const f = await fixture(operation), pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 100 });
		const parent = new AbortController(), entered = deferred<void>();
		const expectedReads = operation === 'models.generate' ? 1 : MODEL_IDS.length;
		const late = Array.from({ length: expectedReads }, () => deferred<ModelRow | null>());
		let reads = 0, sends = 0;
		t.mock.method(f.storage.repositories.modelRouting, 'getModelById', () => { const gate = late[reads++]; assert.ok(gate); entered.resolve(); return gate.promise; });
		t.mock.method(globalThis, 'fetch', async () => { sends++; throw Error('Unexpected inference'); });
		const app = createProxyApp(async () => f.storage, { httpCapacity: { pool, reservedBytesPerRequest: 100 } });
		const tasks: Promise<unknown>[] = [];
		const ctx = { props: {}, passThroughOnException() {}, waitUntil(task: Promise<unknown>) { tasks.push(task); } };
		t.after(async () => { for (const gate of late) gate.resolve(null); await Promise.allSettled(tasks); });
		const pending = app.request(path, { method: 'POST', signal: parent.signal,
			headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
			body: textJsonResourceInput(path, operation, partition),
		}, { REQUEST_BODY_LOGGING: 'off' }, ctx);
		await entered.promise;
		if (stop === 'client') parent.abort(); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
		const response = await pending;
		assert.equal(response.status, stop === 'client' ? 499 : 504);
		if (stop === 'client') await assert.rejects(response.text(), /delivery stopped/); else await response.text();
		assert.equal(pool.snapshot().requests, 1); assert.equal(pool.tryAcquire(1), null);
		assert.equal(reads, expectedReads); assert.equal(sends, 0); assert.equal(f.batches(), 0);
		// A terminal read error is still terminal work, not a failed cleanup ACK.
		for (const gate of late.slice(0, -1)) { if (lateOutcome === 'resolve') gate.resolve(null); else gate.reject(Error('PRIVATE_LATE_READ')); }
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(pool.snapshot().requests, 1, 'every parallel query must finish');
		if (lateOutcome === 'resolve') late.at(-1)!.resolve(null); else late.at(-1)!.reject(Error('PRIVATE_LATE_READ'));
		await Promise.all(tasks);
		assert.equal(pool.snapshot().requests, 0); assert.equal(reads, expectedReads); assert.equal(sends, 0); assert.equal(f.batches(), 0);
	});
}

for (const [path, operation, partition] of textJsonResourceRoutes) for (const stream of [false, true]) {
	for (const mode of ['full', 'partial', 'last-page', 'cancel'] as const) {
		it(`text upload resource public ${path}/${stream ? 'sse' : 'json'}/${mode}`, { timeout: 5000 }, async t => {
			for (const name of ['log', 'warn', 'error'] as const) t.mock.method(console, name, () => {});
			const f = await fixture(operation), pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 100 });
			const app = createProxyApp(async () => f.storage, { httpCapacity: { pool, reservedBytesPerRequest: 100 } });
			const body = JSON.parse(textJsonResourceInput(path, operation, partition));
			if (operation !== 'models.generate') body.stream = stream;
			// Pass-through metadata exercises multiple upload pages without changing prompt estimates.
			body.metadata = { synthetic: mode === 'partial' ? '中😀'.repeat(30000) : 'short' };
			const requestPath = stream && operation === 'models.generate' ? path.replace(':generateContent', ':streamGenerateContent') : path;
			let sends = 0, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
			t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
				sends++; assert.ok(init?.body instanceof ReadableStream); assert.equal(init.redirect, 'error');
				const contentLength = Number(new Headers(init.headers).get('Content-Length'));
				assert.ok(contentLength > 0);
				if (mode === 'full') {
					const upload = await new Response(init.body).text();
					assert.equal(Buffer.byteLength(upload), contentLength);
					assert.equal(JSON.parse(upload).metadata.synthetic, body.metadata.synthetic);
				} else if (mode === 'cancel') await init.body.cancel();
				else {
					reader = init.body.getReader(); const page = await reader.read(); assert.equal(page.done, false);
					assert.ok(page.value); assert.ok(page.value.byteLength <= 65536);
					if (mode === 'partial') assert.ok(contentLength > page.value.byteLength);
					else assert.equal(contentLength, page.value.byteLength, 'last bytes are not consumer EOF');
				}
				return textUploadSuccessReply(operation, stream);
			});
			const tasks: Promise<unknown>[] = [];
			const ctx = { props: {}, passThroughOnException() {}, waitUntil(task: Promise<unknown>) { assert.equal(this, ctx); tasks.push(task); } };
			const response = await app.request(requestPath, { method: 'POST', headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, { REQUEST_BODY_LOGGING: 'off' }, ctx);
			assert.equal(response.status, 200, response.status !== 200 ? await response.text() : undefined);
			await response.text(); await Promise.all(tasks);
			assert.equal(sends, 1); assert.equal(f.batches(), 1);
			assert.equal(geminiLogValue(f.writes, 'status'), 'success');
			assert.equal(geminiLogValue(f.writes, 'input_tokens'), 2); assert.equal(geminiLogValue(f.writes, 'output_tokens'), 3);
			assert.equal(pool.snapshot().requests, mode === 'full' || mode === 'cancel' ? 0 : 1);
			if (reader) { await assert.rejects(reader.read(), /JSON upload stopped/); reader.releaseLock(); assert.equal(pool.tryAcquire(1), null); }
		});
	}
}

for (const [path, operation, partition] of textJsonResourceRoutes) {
	for (const mode of ['declared', 'non-ok', 'late-client', 'late-deadline'] as const) for (const ack of ['resolve', 'reject'] as const) {
		it(`text JSON resource public ${path}/${mode}/${ack}`, { timeout: 5000 }, async t => {
			for (const name of ['log', 'warn', 'error'] as const) t.mock.method(console, name, () => {});
			const f = await fixture(operation);
			const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 100 });
			const app = createProxyApp(async () => f.storage, { httpCapacity: { pool, reservedBytesPerRequest: 100 } });
			const parent = new AbortController(), cleanup = deferred<void>(), entered = deferred<void>(), headers = deferred<Response>();
			if (mode === 'late-deadline') t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			let sends = 0, cancels = 0;
			const sources: ReadableStream<Uint8Array>[] = [];
			const makeUpstream = () => {
				const source = new ReadableStream<Uint8Array>({ cancel() { cancels++; return cleanup.promise; } }, { highWaterMark: 0 });
				sources.push(source);
				return new Response(source, { status: mode === 'non-ok' ? 400 : 200,
					headers: { 'Content-Type': 'application/json', 'Content-Length': '999999999' } });
			};
			const upstream = makeUpstream();
			// Known HTTP rejection may use the existing multi-model fallback budget.
			// Each fetch must return a fresh body, never reuse an already-consumed Response.
			const expectedSends = mode === 'non-ok' && operation !== 'models.generate' ? 3 : 1;
			t.mock.method(globalThis, 'fetch', async () => { sends++; entered.resolve(); return mode.startsWith('late-') ? headers.promise : sends === 1 ? upstream : makeUpstream(); });
			const tasks: Promise<unknown>[] = [];
			const ctx = { props: {}, passThroughOnException() {}, waitUntil(task: Promise<unknown>) { assert.equal(this, ctx); tasks.push(task); } };
			t.after(async () => { cleanup.resolve(); headers.resolve(upstream); parent.abort(); await Promise.allSettled(tasks); });
			const pending = app.request(path, { method: 'POST', signal: parent.signal,
				headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
				body: textJsonResourceInput(path, operation, partition),
			}, { REQUEST_BODY_LOGGING: 'off' }, ctx);
			await entered.promise;
			if (mode === 'late-client') parent.abort();
			if (mode === 'late-deadline') t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			const response = await pending;
			// Existing bounded error capture converts an oversized non-2xx body to 502.
			assert.equal(response.status, mode === 'late-client' ? 499 : mode === 'late-deadline' ? 504 : 502);
			if (mode === 'late-client') await assert.rejects(response.text(), /Gateway response delivery stopped/);
			else await response.text();
			if (mode.startsWith('late-')) { assert.equal(pool.snapshot().requests, 1, 'raw header task retains capacity'); headers.resolve(upstream); }
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(f.batches(), 1, 'accounting does not wait for cleanup ACK');
			assert.equal(sends, expectedSends); assert.equal(cancels, expectedSends); assert.equal(pool.snapshot().requests, 1);
			assert.equal(pool.tryAcquire(1), null);
			if (ack === 'resolve') cleanup.resolve(); else cleanup.reject(Error('PRIVATE_CLEANUP_DETAIL'));
			await Promise.all(tasks);
			assert.equal(pool.snapshot().requests, ack === 'resolve' ? 0 : 1);
			assert.ok(sources.every(source => !source.locked)); assert.equal(sends, expectedSends); assert.equal(f.batches(), 1);
		});
	}
	it(`text JSON resource public EOF ${path} releases capacity and preserves usage`, { timeout: 5000 }, async t => {
		const f = await fixture(operation), pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 100 });
		const app = createProxyApp(async () => f.storage, { httpCapacity: { pool, reservedBytesPerRequest: 100 } });
		const value = operation === 'chat' ? { id: 'synthetic', object: 'chat.completion', created: 1, model: 'private', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }
			: operation === 'responses' ? { id: 'synthetic', object: 'response', created_at: 1, completed_at: 2, status: 'completed', model: 'private', output: [], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }
			: operation === 'messages' ? { id: 'synthetic', type: 'message', role: 'assistant', model: 'private', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3 } }
			: { responseId: 'synthetic', candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } };
		let sends = 0; t.mock.method(globalThis, 'fetch', async () => { sends++; return Response.json(value); });
		const tasks: Promise<unknown>[] = [];
		const ctx = { props: {}, passThroughOnException() {}, waitUntil(task: Promise<unknown>) { tasks.push(task); } };
		const response = await app.request(path, { method: 'POST', headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' }, body: textJsonResourceInput(path, operation, partition) }, { REQUEST_BODY_LOGGING: 'off' }, ctx);
		assert.equal(response.status, 200, response.status !== 200 ? await response.text() : undefined);
		await response.json(); await Promise.all(tasks);
		assert.equal(sends, 1); assert.equal(f.batches(), 1); assert.equal(pool.snapshot().requests, 0);
		assert.equal(geminiLogValue(f.writes, 'status'), 'success');
		assert.equal(geminiLogValue(f.writes, 'input_tokens'), 2); assert.equal(geminiLogValue(f.writes, 'output_tokens'), 3);
	});
}

for (const variant of ['openai', 'sync', 'async', 'native'] as const) for (const prefix of ['/v1', '/api/v1']) {
	if (variant === 'native' && prefix === '/api/v1') continue;
	for (const stage of ['headers', 'body'] as const) for (const ack of ['resolve', 'reject'] as const) {
		it(`ASR resource public ${variant}/${prefix}/${stage}/${ack}`, { timeout: 5000 }, async t => {
			for (const name of ['log', 'warn', 'error'] as const) t.mock.method(console, name, () => {});
			const f = await fixture(variant === 'native' ? 'audio.transcriptions.multimodal' : 'audio.transcriptions', 'synthetic-key', true, variant);
			const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 100 });
			const app = createProxyApp(async () => f.storage, { httpCapacity: { pool, reservedBytesPerRequest: 100 } });
			const cleanup = deferred<void>(), entered = deferred<void>(), headers = deferred<Response>(), parent = new AbortController(); let sends = 0, cancels = 0;
			const source = new ReadableStream<Uint8Array>({ pull() { entered.resolve(); }, cancel() { cancels++; return cleanup.promise; } }, { highWaterMark: 0 });
			t.mock.method(globalThis, 'fetch', async () => { sends++; if (stage === 'headers') { entered.resolve(); return headers.promise; } return new Response(source); });
			const tasks: Promise<unknown>[] = [];
			const ctx = { props: {}, passThroughOnException() {}, waitUntil(task: Promise<unknown>) { tasks.push(task); } };
			t.after(async () => { cleanup.resolve(); headers.resolve(new Response()); parent.abort(); await Promise.allSettled(tasks); });
			const json = variant === 'native' || variant === 'openai';
			const form = new FormData(); form.append('model', MODEL_IDS[0]!);
			if (variant === 'async') form.append('file_url', 'https://audio.example/synthetic.wav');
			else form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }), 'synthetic.wav');
			const suffix = variant === 'native' ? '/dashscope/services/aigc/multimodal-generation/generation' : '/audio/transcriptions';
			const pending = app.request(prefix + suffix, { method: 'POST', signal: parent.signal,
				headers: { Authorization: 'Bearer synthetic-client-key', ...(json ? { 'Content-Type': 'application/json' } : {}) },
				body: json ? JSON.stringify({ model: MODEL_IDS[0], ...(variant === 'native' ? { input: { messages: [] } } : { input_audio: { data: 'AQID', format: 'wav' } }) }) : form,
			}, { REQUEST_BODY_LOGGING: 'off' }, ctx);
			await entered.promise; parent.abort(); const response = await pending;
			assert.equal(response.status, 499); await assert.rejects(response.text(), /Gateway response delivery stopped/);
			if (stage === 'headers') headers.resolve(new Response(source));
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(f.batches(), 1); assert.equal(sends, 1); assert.equal(cancels, 1); assert.equal(pool.snapshot().requests, 1);
			const transitions = f.writes.filter(write => /UPDATE user_budget_reservations\s+SET state = \?/u.test(write.sql));
			assert.equal(transitions.length, 1); assert.equal(transitions[0]!.values[0], 'expired'); assert.equal(transitions[0]!.values[1], 1_500_000);
			if (ack === 'resolve') cleanup.resolve(); else cleanup.reject(Error('PRIVATE_ACK'));
			await Promise.all(tasks); assert.equal(pool.snapshot().requests, ack === 'resolve' ? 0 : 1); assert.equal(f.batches(), 1); assert.equal(sends, 1);
		});
	}
}

for (const variant of ['openai', 'speech', 'minimax'] as const) for (const prefix of ['/v1', '/api/v1']) {
	for (const format of ['audio', 'sse'] as const) for (const stop of ['client', 'downstream'] as const) for (const ack of ['resolve', 'reject'] as const) {
		it(`TTS resource public ${variant}/${prefix}/${format}/${stop}/${ack}`, { timeout: 5000 }, async t => {
			for (const name of ['log', 'warn'] as const) t.mock.method(console, name, () => {});
			const errors: unknown[][] = []; t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
			const f = await fixture('audio.speech', 'synthetic-key', true, 'openai', variant);
			const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 100 });
			const app = createProxyApp(async () => f.storage, { httpCapacity: { pool, reservedBytesPerRequest: 100 } });
			const cleanup = deferred<void>(), parent = new AbortController(); let cancels = 0, sends = 0;
			const source = new ReadableStream<Uint8Array>({
				start(c) { if (variant !== 'openai') c.enqueue(speechEvent(variant, false)); },
				cancel() { cancels++; return cleanup.promise; },
			}, { highWaterMark: 0 });
			t.mock.method(globalThis, 'fetch', async () => { sends++; return new Response(source, { headers: {
				'Content-Type': variant === 'openai' && format === 'audio' ? 'audio/pcm' : 'text/event-stream',
			} }); });
			const tasks: Promise<unknown>[] = [];
			const ctx = { props: {}, passThroughOnException() {}, waitUntil(task: Promise<unknown>) { tasks.push(task); } };
			t.after(async () => { cleanup.resolve(); parent.abort(); await Promise.allSettled(tasks); });
			const response = await app.request(prefix + '/audio/speech', {
				method: 'POST', signal: parent.signal, headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: MODEL_IDS[0], input: 'hello', voice: 'synthetic', response_format: 'pcm', stream_format: format }),
			}, { REQUEST_BODY_LOGGING: 'off' }, ctx);
			assert.equal(response.status, 200, response.status !== 200 ? await response.text() : undefined);
			if (stop === 'client') { parent.abort(); await response.arrayBuffer().catch(() => undefined); }
			else await response.body!.cancel();
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(f.batches(), 1); assert.equal(cancels, 1); assert.equal(sends, 1); assert.deepEqual(errors, []);
			const transitions = f.writes.filter(write => /UPDATE user_budget_reservations\s+SET state = \?/u.test(write.sql));
			assert.equal(transitions.length, 1); assert.equal(transitions[0]!.values[0], 'expired'); assert.equal(transitions[0]!.values[1], 5000);
			assert.equal(pool.snapshot().requests, 1); assert.equal(pool.tryAcquire(1), null);
			if (ack === 'resolve') cleanup.resolve(); else cleanup.reject(Error('PRIVATE_CLEANUP_DETAIL'));
			await Promise.all(tasks);
			assert.equal(pool.snapshot().requests, ack === 'resolve' ? 0 : 1);
			assert.equal(f.batches(), 1); assert.equal(sends, 1);
		});
	}
}

for (const prefix of ['/v1', '/api/v1']) it(`TTS resource public Qwen format gate ${prefix} remains pre-dispatch`, async t => {
	const f = await fixture('audio.speech', 'synthetic-key', true, 'openai', 'qwen');
	const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 100 });
	const app = createProxyApp(async () => f.storage, { httpCapacity: { pool, reservedBytesPerRequest: 100 } });
	t.mock.method(globalThis, 'fetch', async () => { throw Error('Unexpected inference'); });
	const response = await app.request(prefix + '/audio/speech', { method: 'POST', headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: MODEL_IDS[0], input: 'hello', voice: 'synthetic', response_format: 'pcm' }),
	}, { REQUEST_BODY_LOGGING: 'off' });
	assert.equal(response.status, 502); await response.text();
	assert.equal(pool.snapshot().requests, 0); assert.deepEqual(f.admissionCalls, []); assert.equal(f.batches(), 0);
});

for (const [path, operation, partition] of [
	['/v1/chat/completions', 'chat', 'model'], ['/api/v1/chat/completions', 'chat', 'none'],
	['/v1/responses', 'responses', 'model'], ['/api/v1/responses', 'responses', 'none'],
	['/v1/messages', 'messages', 'model'], ['/api/v1/messages', 'messages', 'none'],
	['/v1beta/models/model-0:streamGenerateContent', 'models.generate', 'model'],
] as const) for (const stop of ['client', 'downstream'] as const) for (const ack of ['resolve', 'reject'] as const) {
	it(`text resource public ${operation}/${partition}/${stop}/${ack}`, { timeout: 5000 }, async t => {
		for (const name of ['log', 'warn'] as const) t.mock.method(console, name, () => {});
		const errors: unknown[][] = []; t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
		const f = await fixture(operation);
		const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 100 });
		const app = createProxyApp(async () => f.storage, { httpCapacity: { pool, reservedBytesPerRequest: 100 } });
		const cleanup = deferred<void>(), parent = new AbortController(); let cancels = 0, sends = 0;
		const source = new ReadableStream<Uint8Array>({ cancel() { cancels++; return cleanup.promise; } });
		t.mock.method(globalThis, 'fetch', async () => { sends++; return new Response(source, { headers: { 'Content-Type': 'text/event-stream' } }); });
		const tasks: { promise: Promise<unknown>; settled: boolean }[] = [];
		const ctx = { props: {}, passThroughOnException() {}, waitUntil(promise: Promise<unknown>) {
			const entry = { promise, settled: false }; tasks.push(entry);
			void promise.then(() => { entry.settled = true; }, () => { entry.settled = true; });
		} };
		t.after(async () => { cleanup.resolve(); parent.abort(); await Promise.allSettled(tasks.map(x => x.promise)); });
		const response = await app.request(path, {
			method: 'POST', signal: parent.signal, headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
			body: JSON.stringify(operation === 'models.generate' ? { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } : {
				model: MODEL_IDS[0], models: MODEL_IDS, stream: true, provider: { sort: { by: 'price', partition } },
				...(operation === 'responses' ? { input: 'hi' } : { messages: [{ role: 'user', content: 'hi' }] }),
			}),
		}, { REQUEST_BODY_LOGGING: 'off' }, ctx);
		assert.equal(response.status, 200, response.status !== 200 ? await response.text() : undefined);
		assert.ok(tasks.length > 0, 'resource lifecycle registered before response returns');
		if (stop === 'client') { parent.abort(); await response.text().catch(() => undefined); }
		else await response.body!.cancel();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(f.batches(), 1, 'accounting terminates with cleanup ACK still withheld');
		assert.equal(cancels, 1); assert.equal(sends, 1); assert.deepEqual(errors, []);
		assert.ok(tasks.some(x => !x.settled)); assert.equal(pool.snapshot().requests, 1);
		assert.equal(pool.tryAcquire(1), null);
		if (ack === 'resolve') cleanup.resolve(); else cleanup.reject(Error('PRIVATE_CLEANUP_DETAIL'));
		await Promise.all(tasks.map(x => x.promise));
		assert.equal(source.locked, false);
		assert.equal(pool.snapshot().requests, ack === 'resolve' ? 0 : 1, 'unconfirmed cleanup quarantines numeric capacity');
		assert.equal(f.batches(), 1); assert.equal(sends, 1);
	});
}
const { privateKey: syntheticPrivateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
});

for (const [suffix, operation] of [
	['chat/completions', 'chat'], ['completions', 'chat'], ['messages', 'messages'], ['responses', 'responses'],
] as const) {
	for (const prefix of ['/v1', '/api/v1']) {
		for (const partition of ['model', 'none'] as const) {
			it(`${prefix}/${suffix} shares auxiliary auth across model fallback (partition=${partition})`, async (t) => {
				const credential = JSON.stringify({ type: 'service_account', client_email: 'synthetic@example.invalid', private_key: syntheticPrivateKey });
				const { app, batches } = await fixture(operation, credential);
				let authCalls = 0; let inferenceCalls = 0;
				const errors: unknown[][] = [];
				t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
				t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
					if (String(input) === GCP_OAUTH_TOKEN_URL) { authCalls++; return Response.json({ error: 'private auth detail' }, { status: 503 }); }
					inferenceCalls++; throw new Error('Unexpected inference');
				});
				const response = await app.request(`${prefix}/${suffix}`, {
					method: 'POST', headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
					body: JSON.stringify({ model: MODEL_IDS[0], models: MODEL_IDS, provider: { sort: { by: 'price', partition } },
						...(suffix === 'completions' ? { prompt: 'hi' } : operation === 'responses' ? { input: 'hi' } : { messages: [{ role: 'user', content: 'hi' }] }) }),
				}, { REQUEST_BODY_LOGGING: 'off' });
				assert.equal(response.headers.get('X-OctaFuse-Error-Code'), 'gateway.auxiliary_auth_limit_exceeded');
				await assertEarlyFailure(response, 502, 'gateway.auxiliary_auth_limit_exceeded', operation);
				await drainNodeBackgroundWork();
				assert.equal(authCalls, 3); assert.equal(inferenceCalls, 0);
				assert.deepEqual(errors, [], 'no swallowed settlement errors');
				assert.equal(batches(), 1, 'one terminal usage record, not one per failed auth');
			});
		}
	}
}

/**
 * Runs the real authentication, model planner, outer route loop, dispatcher and
 * text drivers. Repository rows and upstream HTTP are synthetic. The tiny SQL
 * sink accepts only an empty workspace-budget read and zero-cost log writes;
 * this is NOT a database/financial persistence test.
 */
async function fixture(
	operation: 'chat' | 'responses' | 'messages' | 'models.generate' | 'embeddings' | 'rerank' | 'images.generations' | 'images.edits' | 'audio.transcriptions' | 'audio.transcriptions.multimodal' | 'audio.speech',
	providerCredential: string | ((index: number) => string) = 'synthetic-provider-key',
	paid = false,
	asrVariant: 'openai' | 'sync' | 'async' | 'native' = 'openai',
	ttsVariant: 'openai' | 'speech' | 'qwen' | 'minimax' = 'openai',
	options: { routeFanout?: readonly number[]; upstreamBase?: string } = {},
) {
	let batches = 0;
	const writes: Array<{ sql: string; values: unknown[] }> = [];
	const admissionCalls: string[] = [];
	let reservation: { request_id: string; user_id: string; api_key_id: string;
		budget_epoch: number; reserved_micros: number; settled_micros: number; state: string } | null = null;
	function emptyResult<T>(changes = 0): D1Result<T> {
		return { results: [], success: true, meta: {
			duration: 0, size_after: 0, rows_read: 0, rows_written: changes,
			last_row_id: 0, changes, changed_db: changes > 0,
		} };
	}
	class Statement {
		constructor(readonly sql: string, readonly values: unknown[] = []) {}
		bind(...values: unknown[]) { return new Statement(this.sql, values); }
		async first<T = Record<string, unknown>>(_column?: string): Promise<T | null> {
			if (paid && this.sql.includes('FROM user_budget_reservations')) return reservation as T | null;
			if (paid && this.sql.includes('FROM api_key_request_logs')) return null;
			if (paid && this.sql.includes('SELECT budget_spent_micros')) return { budget_spent_micros: 0 } as T;
			throw new Error('Unexpected fixture first()');
		}
		async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
			throw new Error('Unexpected fixture run()');
		}
		async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
			assert.match(this.sql, /FROM workspace_budgets budget/);
			return emptyResult<T>();
		}
		raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
		raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
		async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
			// Error alerts read this configuration directly through Drizzle.
			assert.match(this.sql, paid ? /from "(users|system_config)"/ : /select "value" from "system_config"/);
			assert.notEqual(options?.columnNames, true, 'Unexpected fixture column headers');
			return [];
		}
	}
	const db: D1Database = {
		prepare: (sql: string) => new Statement(sql),
		batch: async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
			for (const statement of statements) {
				assert.ok(statement instanceof Statement);
				assert.match(statement.sql, paid
					? /^\s*(?:INSERT\s+INTO\s+(api_key_request_logs|public_model_daily_stats|provider_attempt_availability|user_audit_logs)|UPDATE\s+(users|user_budget_reservations|guardrail_budget_windows))/i
					: /^\s*INSERT\s+INTO\s+(api_key_request_logs|public_model_daily_stats|provider_attempt_availability)/i);
				writes.push({ sql: statement.sql, values: statement.values });
			}
			batches += 1;
			return statements.map(() => emptyResult<T>(1));
		},
		exec: async () => { throw new Error('Unexpected fixture exec()'); },
		withSession: () => { throw new Error('Unexpected fixture withSession()'); },
		dump: async () => { throw new Error('Unexpected fixture dump()'); },
	};
	const storage = createD1StorageContext(db);
	const key: ResolvedGatewayKeyRow = {
		id: 'key-dispatch-limit', key: 'synthetic-client-key', user_id: 'user-dispatch-limit',
		workspace_id: 'workspace-test', name: 'Test', status: 'active', metadata: null,
		last_used_at: null, created_at: NOW, updated_at: NOW, user_email: null,
		user_metadata: null, user_charged_cost_factors: null, budget_max: paid ? 10 : null,
		budget_base: 0, budget_spent: 0, budget_period: 'none', budget_reset_at: null,
		budget_epoch: 0, budget_reserved_micros: 0, include_byok_in_limit: false,
		limit_micros: null, limit_epoch: 0, limit_reset: null, expires_at: null,
	};
	const audio = operation.startsWith('audio.');
	const speech = operation === 'audio.speech';
	const protocol = operation === 'models.generate' ? 'gemini' : operation === 'messages' ? 'anthropic' : audio && (speech ? ttsVariant !== 'openai' : asrVariant !== 'openai') ? 'dashscope' : 'openai';
	const upstreamOperation = speech ? ttsVariant === 'qwen' || ttsVariant === 'minimax' ? 'audio.speech.multimodal' : operation : audio && asrVariant !== 'openai'
		? asrVariant === 'async' ? 'audio.transcriptions.async' : 'audio.transcriptions.multimodal' : operation;
	const vector = operation === 'embeddings' || operation === 'rerank';
	const image = operation === 'images.generations' || operation === 'images.edits';
	const models: ModelRow[] = MODEL_IDS.map((id) => ({
		id, display_name: id, vendor: 'test', context_window: 8192, max_tokens: 1024,
		pricing_profile: null, tags: '[]', description: null, metadata: null,
		input_modalities: image ? '["text","image"]' : audio && !speech ? '["audio"]' : '["text"]', output_modalities: JSON.stringify([image ? 'image' : speech ? 'audio' : vector ? operation : 'text']), released_at: null,
		route_policy: '{"strategy":"weight_priority"}', created_at: NOW,
	}));
	const routeRows: ModelRouteRow[] = MODEL_IDS.flatMap((id, modelIndex) => Array.from({ length: options.routeFanout?.[modelIndex] ?? 1 }, (_, slot) => ({
		id: `target-${id}${slot ? `-${slot}` : ''}`, model_id: vector || image || audio ? MODEL_IDS[0]! : id,
		provider_id: `provider-${id}${slot ? `-${slot}` : ''}`, provider_model_name: `private-${id}${slot ? `-${slot}` : ''}`,
		priority: 1, status: 'active', route_group: 'default', weight: 1, price_override: null,
		custom_params: null, upstream_protocol: protocol, upstream_operation: upstreamOperation,
		adapter: speech ? ttsVariant === 'openai' ? 'passthrough' : ttsVariant === 'speech' ? 'dashscope-tts-speech' : ttsVariant === 'qwen' ? 'dashscope-tts-qwen' : 'dashscope-tts-minimax'
			: audio && asrVariant === 'sync' ? 'dashscope-asr-qwen-file' : audio && asrVariant === 'async' ? 'dashscope-asr-file-async' : 'passthrough', routing_metadata: null,
	})));
	const providers: ProviderRow[] = routeRows.map((route, index) => ({
		id: route.provider_id, name: route.provider_id, api_key: typeof providerCredential === 'function' ? providerCredential(index) : providerCredential,
		endpoints: JSON.stringify({ [protocol]: { base: options.upstreamBase ?? 'https://upstream.invalid/v1' } }),
		status: 'active', description: null, created_at: NOW,
	}));
	const bindings = await Promise.all(routeRows.map(async (route, index) => ({
		id: `endpoint-${route.id}`, model_id: route.model_id, provider_id: route.provider_id,
		provider_slug: 'test', tag: 'test', endpoint_class: null, region: null,
		context_length: 8192, max_prompt_tokens: null, max_completion_tokens: 1024,
		quantization: null, supported_parameters: '[]', pricing: JSON.stringify({ currency: 'USD', prompt: paid ? '0.000001' : '0', completion: '0' }),
		supports_implicit_caching: false, supports_voice_cloning: false,
		audio_capabilities: audio ? JSON.stringify({ v: 1, pricing_by_operation: { [upstreamOperation]: {
			currency: 'USD', meter: { kind: speech ? 'characters' : 'duration', unit: speech ? 'unicode_code_point' : 'second', price: '0.001', minimum_units: 0, increment_units: 1 },
		} } }) : '{}',
		supports_tool_choice: '{"auto":true,"function":true,"none":true,"required":true}',
		image_capabilities: image ? JSON.stringify({ provider_slug: 'test', provider_tag: null, supports_streaming: true,
			supported_parameters: { n: { type: 'range', min: 1, max: 10 } }, allowed_passthrough_parameters: [],
			pricing: [{ billable: 'output_image', unit: 'image', cost_usd: paid ? '0.04' : '0' }],
		}) : '{}', evidence_url: 'https://upstream.invalid/evidence', verified_by: 'test',
		verified_at: NOW, expires_at: '2099-01-01T00:00:00.000Z', status: 'verified' as const,
		created_at: NOW, updated_at: NOW, route_target_id: route.id,
		subject_fingerprint: await computeRouteDataPolicySubjectFingerprintFromRows(route, providers[index]!),
	})));
	const repositories: GatewayRepositories = {
		...storage.repositories,
		apiKeys: { ...storage.repositories.apiKeys, getApiKeyWithUserByKey: async () => key, getApiKeyByIdInWorkspace: async () => key },
		guardrails: { ...storage.repositories.guardrails, getEffectiveForRequest: async () => [] },
		byokKeys: { ...storage.repositories.byokKeys, listActiveForRequest: async () => [], shouldSuppressSharedCapacityForRequest: async () => false },
		modelRouting: {
			...storage.repositories.modelRouting,
			getModelById: async (id: string) => models.find((row) => row.id === id) ?? null,
			resolveModelSurface: async () => null,
			getModelRoutesByModelId: async (id: string) => routeRows.filter((row) => row.model_id === id),
		},
		providers: { ...storage.repositories.providers, getProvidersByIds: async (ids: string[]) => providers.filter((row) => ids.includes(row.id)) },
		modelEndpoints: { ...storage.repositories.modelEndpoints, listRuntimeBindingsByRouteTargetIds: async (ids: string[]) => bindings.filter((row) => ids.includes(row.route_target_id)) },
		routeDataPolicies: { ...storage.repositories.routeDataPolicies, getByRouteTargetIds: async () => [] },
		systemConfig: { ...storage.repositories.systemConfig, getConfig: async () => null },
		...(paid ? {
			users: { ...storage.repositories.users, getById: async () => null },
			userBudgets: {
				...storage.repositories.userBudgets,
				expireBefore: async () => 0,
				reserve: async (params) => {
					admissionCalls.push('reserve');
					reservation = { request_id: params.requestId, user_id: params.userId, api_key_id: params.apiKeyId,
						budget_epoch: params.expectedBudgetEpoch, reserved_micros: params.reservedMicros, settled_micros: 0, state: 'reserved' };
					return { status: 'reserved', reservation: { requestId: params.requestId, userId: params.userId,
						apiKeyId: params.apiKeyId, budgetEpoch: params.expectedBudgetEpoch, limitMicros: 10_000_000, reservedMicros: params.reservedMicros } };
				},
				markDispatched: async () => { assert.ok(reservation); reservation.state = 'dispatched'; admissionCalls.push('dispatch'); return true; },
			},
		} satisfies Partial<GatewayRepositories> : {}),
		requestLogs: { ...storage.repositories.requestLogs, getRecentRoutePerformanceSamples: async () => [], getRouteAvailabilityAggregates: async () => [] },
	};
	const app = createProxyApp(async () => ({ client: storage.client, repositories }));
	app.onError((error) => { throw error; });
	return { app, batches: () => batches, storage: { client: storage.client, repositories }, key, writes, admissionCalls,
		configuredRoutes: routeRows.length };
}

beforeEach(() => {
	clearGcpServiceAccountTokenCache();
	resetProviderCircuitStateForTests();
	resetUserModelCircuitStateForTests();
});

it('opt-in authenticated Chat budget proof rejects a one-hop affordable but three-hop unaffordable plan before fetch', async t => {
	const f = await fixture('chat', 'synthetic-provider-key', true);
	const heldMicros: number[] = [];
	const ordinaryReserve = f.storage.repositories.userBudgets.reserve;
	t.mock.method(f.storage.repositories.userBudgets, 'reserve', async (params: Parameters<typeof ordinaryReserve>[0]) => {
		heldMicros.push(params.reservedMicros);
		if (params.reservedMicros > 20_000) return { status: 'blocked' as const, remainingMicros: 20_000 };
		return ordinaryReserve(params);
	});
	let sends = 0;
	t.mock.method(globalThis, 'fetch', async () => {
		sends++;
		throw new Error('An unaffordable aggregate must not reach upstream');
	});
	const response = await f.app.request('/v1/chat/completions', {
		method: 'POST',
		headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
		body: textJsonResourceInput('/v1/chat/completions', 'chat', 'model'),
	}, { REQUEST_BODY_LOGGING: 'off', AUTHENTICATED_CHAT_BUDGET_PROOF_ENABLED: 'reviewed-v1' });
	assert.equal(response.status, 402, await response.text());
	assert.equal(sends, 0);
	assert.equal(heldMicros.length, 1);
	assert.ok(heldMicros[0]! > 20_000, 'the proof must hold all three possible paid dispatches');
	assert.ok(heldMicros[0]! < 60_000, 'one paid dispatch would still fit the test limit');
});

it('opt-in authenticated Chat budget proof admits a priced two-attempt HTTP failover', async t => {
	const f = await fixture('chat', 'synthetic-provider-key', true);
	let sends = 0;
	t.mock.method(globalThis, 'fetch', async () => {
		sends++;
		return sends === 1 ? new Response('busy', { status: 429 })
			: textUploadSuccessReply('chat', false);
	});
	const tasks: Promise<unknown>[] = [];
	const context = { props: {}, passThroughOnException() {},
		waitUntil(task: Promise<unknown>) { tasks.push(task); } };
	const response = await f.app.request('/v1/chat/completions', {
		method: 'POST',
		headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
		body: textJsonResourceInput('/v1/chat/completions', 'chat', 'model'),
	}, { REQUEST_BODY_LOGGING: 'off', AUTHENTICATED_CHAT_BUDGET_PROOF_ENABLED: 'reviewed-v1' }, context);
	assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
	await response.text();
	await Promise.all(tasks);
	assert.equal(sends, 2);
	assert.deepEqual(f.admissionCalls.filter(call => call === 'reserve' || call === 'dispatch'),
		['reserve', 'dispatch']);
});

it('PostgreSQL Chat owner activation fails closed before upstream send without dedicated runtime and LOGIN bindings', async t => {
	const f = await fixture('chat', 'synthetic-provider-key', true);
	let sends = 0;
	t.mock.method(globalThis, 'fetch', async () => { sends++; throw new Error('unexpected upstream send'); });
	const response = await f.app.request('/v1/chat/completions', {
		method: 'POST',
		headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
		body: textJsonResourceInput('/v1/chat/completions', 'chat', 'model'),
	}, { REQUEST_BODY_LOGGING: 'off', AUTHENTICATED_CHAT_BUDGET_PROOF_ENABLED: 'reviewed-v1',
		POSTGRES_CHAT_BUDGET_OWNER_ENABLED: 'reviewed-v1' });
	assert.equal(response.status, 503);
	assert.equal(sends, 0);
});

it('PostgreSQL Chat owner receives the final post-preset body and original ingress digest', async t => {
	const f = await fixture('chat', 'synthetic-provider-key', false);
	const pgClient = { ...f.storage.client, driver: 'postgres' as const,
		raw: { unsafe: async () => [] } };
	const storage = { ...f.storage, client: pgClient,
		repositories: { ...f.storage.repositories, client: pgClient } } as unknown as StorageContext;
	const preset: RequestPresetWithVersionRow = {
		id: 'preset-synthetic', workspace_id: 'workspace-test', owner_user_id: f.key.user_id,
		slug: 'synthetic', name: 'Synthetic', description: null, visibility: 'private', status: 'active',
		designated_version: 1, latest_version: 1, created_at: NOW, updated_at: NOW,
		version_id: 'version-synthetic', version_system_prompt: 'Use short answers.',
		version_config_json: JSON.stringify({ model: MODEL_IDS[0], temperature: 0.2 }),
		version_created_by_user_id: f.key.user_id, version_created_at: NOW,
	};
	t.mock.method(storage.repositories.requestPresets, 'getAccessibleBySlug', async () => preset);
	const rawBody = ` { "model" : "@preset/synthetic", "models" : ["${MODEL_IDS[1]}", "${MODEL_IDS[1]}", "${MODEL_IDS[2]}"], "messages" : [{"role":"user","content":"hi"}] } `;
	const entered = deferred<void>(), opened = deferred<void>(), abort = new AbortController();
	let ownerOpens = 0;
	const app = createProxyApp(async () => storage, {
		chatBudgetRequestOwnerFactory: async params => {
			ownerOpens++;
			const quote = params.finalQuoteInput;
			assert.ok(quote);
			assert.equal(quote.requestId, params.identity.requestId);
			assert.equal(quote.originalBodySha256, createHash('sha256').update(rawBody).digest('hex'));
			assert.deepEqual(quote.modelIds, MODEL_IDS.slice(0, 3));
			const finalBody = JSON.parse(quote.finalBodyUtf8) as Record<string, unknown>;
			assert.equal(finalBody.model, MODEL_IDS[0]);
			assert.deepEqual(finalBody.models, MODEL_IDS.slice(0, 3));
			assert.equal(finalBody.temperature, 0.2);
			assert.equal(finalBody.preset, undefined);
			assert.deepEqual(finalBody.messages, [
				{ role: 'system', content: 'Use short answers.' },
				{ role: 'user', content: 'hi' },
			]);
			assert.equal(quote.finalBodySha256, createHash('sha256').update(quote.finalBodyUtf8).digest('hex'));
			entered.resolve();
			await opened.promise;
			return {
				ordinaryBudgetRepositories: storage.repositories,
				guardrailBudgetRequestPort: {
					identity: { requestId: params.identity.requestId, userId: params.identity.userId,
						apiKeyId: params.identity.apiKeyId },
					reserve: async () => ({ ok: true, reserved: false }),
					extend: async () => ({ ok: true, reserved: false }),
					markDispatched: async () => {}, releasePreDispatch: async () => {},
					forfeitPostDispatch: async () => {},
				},
				close: async () => {},
			};
		},
	});
	let sends = 0;
	t.mock.method(globalThis, 'fetch', async () => { sends++; throw new Error('unexpected upstream send'); });
	const tasks: Promise<unknown>[] = [];
	const context = { props: {}, passThroughOnException() {}, waitUntil(task: Promise<unknown>) { tasks.push(task); } };
	t.after(async () => { opened.resolve(); await Promise.allSettled(tasks); });
	const pending = app.request('/v1/chat/completions', {
		method: 'POST', signal: abort.signal,
		headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
		body: rawBody,
	}, { REQUEST_BODY_LOGGING: 'off', AUTHENTICATED_CHAT_BUDGET_PROOF_ENABLED: 'reviewed-v1',
		POSTGRES_CHAT_BUDGET_OWNER_ENABLED: 'reviewed-v1',
		HYPERDRIVE: { connectionString: 'postgres://runtime@localhost/gateway' },
		BUDGET_ADMISSION_HYPERDRIVE: { connectionString: 'postgres://admission@localhost/gateway' },
		BUDGET_RECOVERY_HYPERDRIVE: { connectionString: 'postgres://recovery@localhost/gateway' },
	} as Parameters<typeof app.request>[2], context);
	await entered.promise;
	abort.abort();
	opened.resolve();
	const response = await pending;
	assert.equal(response.status, 499);
	await Promise.allSettled(tasks);
	assert.equal(ownerOpens, 1);
	assert.equal(sends, 0);
});

for (const stop of ['client', 'deadline'] as const) it(`${stop} stopped Chat request closes its direct budget owner after the open await and preserves capacity until close ACK`, async t => {
	if (stop === 'deadline') t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
	const f = await fixture('chat', 'synthetic-provider-key', true);
	const pgClient = { ...f.storage.client, driver: 'postgres' as const,
		raw: { unsafe: async () => [] } };
	const storage = { ...f.storage, client: pgClient,
		repositories: { ...f.storage.repositories, client: pgClient } } as unknown as StorageContext;
	const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 100 });
	const entered = deferred<void>(), opened = deferred<void>(), closeAck = deferred<void>();
	const abort = new AbortController();
	let closes = 0, sends = 0;
	t.mock.method(globalThis, 'fetch', async () => { sends++; throw new Error('unexpected upstream send'); });
	const app = createProxyApp(async () => storage, {
		httpCapacity: { pool, reservedBytesPerRequest: 100 },
		chatBudgetRequestOwnerFactory: async params => {
			assert.equal(params.identity.requestId.length > 0, true);
			assert.equal(params.identity.userId, f.key.user_id);
			assert.equal(params.identity.apiKeyId, f.key.id);
			entered.resolve();
			await opened.promise;
			return {
				ordinaryBudgetRepositories: storage.repositories,
				guardrailBudgetRequestPort: {} as GuardrailBudgetRequestPort,
				close: async () => { closes++; await closeAck.promise; },
			};
		},
	});
	const tasks: Promise<unknown>[] = [];
	const context = { props: {}, passThroughOnException() {}, waitUntil(task: Promise<unknown>) { tasks.push(task); } };
	t.after(async () => { opened.resolve(); closeAck.resolve(); await Promise.allSettled(tasks); });
	const pending = Promise.resolve(app.request('/v1/chat/completions', {
		method: 'POST', signal: abort.signal,
		headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
		body: textJsonResourceInput('/v1/chat/completions', 'chat', 'model'),
	}, { REQUEST_BODY_LOGGING: 'off', AUTHENTICATED_CHAT_BUDGET_PROOF_ENABLED: 'reviewed-v1',
		POSTGRES_CHAT_BUDGET_OWNER_ENABLED: 'reviewed-v1',
		HYPERDRIVE: { connectionString: 'postgres://runtime@localhost/gateway' },
		BUDGET_ADMISSION_HYPERDRIVE: { connectionString: 'postgres://admission@localhost/gateway' },
		BUDGET_RECOVERY_HYPERDRIVE: { connectionString: 'postgres://recovery@localhost/gateway' },
	} as Parameters<typeof app.request>[2], context));
	await Promise.race([entered.promise, pending.then(response => {
		throw new Error(`PostgreSQL Chat owner was not opened: ${response.status}`);
	})]);
	if (stop === 'client') abort.abort(); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
	opened.resolve();
	const response = await pending;
	assert.equal(response.status, stop === 'client' ? 499 : 504);
	if (stop === 'deadline') await response.text();
	else await assert.rejects(response.text(), /delivery stopped/);
	assert.equal(sends, 0);
	assert.equal(closes, 1);
	assert.equal(pool.snapshot().requests, 1);
	closeAck.resolve();
	await Promise.all(tasks);
	assert.equal(pool.snapshot().requests, 0);
});

for (const partition of ['model', 'none'] as const) it(`real Chat ${partition} dispatcher sends once after a PostgreSQL owner grant even when the first provider returns 503`, async t => {
	const f = await fixture('chat', 'synthetic-provider-key', true);
	const pgClient = { ...f.storage.client, driver: 'postgres' as const,
		raw: { unsafe: async () => [] } };
	const storage = { ...f.storage, client: pgClient,
		repositories: { ...f.storage.repositories, client: pgClient } } as unknown as StorageContext;
	let opens = 0, closes = 0, sends = 0;
	const app = createProxyApp(async () => storage, {
		chatBudgetRequestOwnerFactory: async params => {
			opens++;
			return {
				ordinaryBudgetRepositories: storage.repositories,
				guardrailBudgetRequestPort: {
					identity: { requestId: params.identity.requestId, userId: params.identity.userId,
						apiKeyId: params.identity.apiKeyId },
					reserve: async () => ({ ok: true, reserved: false }),
					extend: async () => ({ ok: true, reserved: false }),
					markDispatched: async () => {}, releasePreDispatch: async () => {},
					forfeitPostDispatch: async () => {},
				},
				close: async () => { closes++; },
			};
		},
	});
	t.mock.method(globalThis, 'fetch', async () => {
		sends++;
		return sends === 1 ? new Response('busy', { status: 503 }) : textUploadSuccessReply('chat', false);
	});
	const tasks: Promise<unknown>[] = [];
	const context = { props: {}, passThroughOnException() {}, waitUntil(task: Promise<unknown>) { tasks.push(task); } };
	const response = await app.request('/v1/chat/completions', {
		method: 'POST',
		headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
		body: textJsonResourceInput('/v1/chat/completions', 'chat', partition),
	}, { REQUEST_BODY_LOGGING: 'off', AUTHENTICATED_CHAT_BUDGET_PROOF_ENABLED: 'reviewed-v1',
		POSTGRES_CHAT_BUDGET_OWNER_ENABLED: 'reviewed-v1',
		HYPERDRIVE: { connectionString: 'postgres://runtime@localhost/gateway' },
		BUDGET_ADMISSION_HYPERDRIVE: { connectionString: 'postgres://admission@localhost/gateway' },
		BUDGET_RECOVERY_HYPERDRIVE: { connectionString: 'postgres://recovery@localhost/gateway' },
	} as Parameters<typeof app.request>[2], context);
	assert.equal(response.status, 503, await response.text());
	await Promise.allSettled(tasks);
	assert.equal(opens, 1);
	assert.equal(closes, 1);
	assert.equal(sends, 1);
});

// Exercises the real image entry/planner/driver/usage writer, using verified
// synthetic endpoint prices and a finite reservation. Captured SQL is intent,
// not evidence of real database transactions or financial persistence.
for (const suffix of ['images', 'images/generations', 'images/edits'] as const) {
	for (const prefix of ['/v1', '/api/v1']) {
		for (const outcome of ['auth-limit', 'auth-cancel', 'known-then-limit', 'known-then-cancel', 'invalid-accepted', 'transport-unknown', 'accepted-cancel', 'success'] as const) {
			it(`${prefix}/${suffix}: ${outcome} preserves image settlement and public errors`, { timeout: 5000 }, async t => {
				const edit = suffix === 'images/edits';
				const { app, batches, admissionCalls, writes } = await fixture(edit ? 'images.edits' : 'images.generations',
					index => JSON.stringify({ type: 'service_account', client_email: `synthetic-${index}@example.invalid`, private_key: syntheticPrivateKey }), true);
				const parent = new AbortController(); const entered = deferred<void>(); const late = deferred<Response>();
				const cancel = outcome.endsWith('cancel');
				const sent = outcome.startsWith('auth-') ? 0 : 1;
				const unknown = outcome === 'invalid-accepted' || outcome === 'transport-unknown';
				let auth = 0; let inference = 0; let cancelled = 0;
				const errors: unknown[][] = [];
				t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
				t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
					if (String(input) === GCP_OAUTH_TOKEN_URL) {
						auth++;
						if (sent && auth === 1) return Response.json({ access_token: 'synthetic', expires_in: 3600 });
						if (cancel) { entered.resolve(); return late.promise; }
						return Response.json({ error: 'PRIVATE_AUTH_DETAIL' }, { status: 503 });
					}
					inference++;
					if (outcome === 'transport-unknown') throw new Error('PRIVATE_TRANSPORT_DETAIL');
					if (outcome === 'success') return Response.json({ data: [{ b64_json: 'AQI=' }] });
					if (outcome === 'accepted-cancel') return new Response(new ReadableStream<Uint8Array>({
						pull() { entered.resolve(); return new Promise<void>(() => {}); },
						cancel() { cancelled++; return new Promise<void>(() => {}); },
					}, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/json' } });
					return Response.json({}, { status: outcome === 'invalid-accepted' ? 200 : outcome.startsWith('known-') ? 429 : 503 });
				});
				const form = new FormData();
				form.append('model', MODEL_IDS[0]!); form.append('prompt', 'synthetic');
				form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'synthetic.png');
				const responsePromise = app.request(`${prefix}/${suffix}`, {
					method: 'POST', signal: parent.signal, headers: { Authorization: 'Bearer synthetic-client-key',
						...(edit ? {} : { 'Content-Type': 'application/json' }) },
					body: edit ? form : JSON.stringify({ model: MODEL_IDS[0], prompt: 'synthetic' }),
				}, { REQUEST_BODY_LOGGING: 'off' });
				if (cancel) { await entered.promise; parent.abort('PRIVATE_CANCEL_DETAIL'); }
				const response = await responsePromise; const text = await response.text(); await drainNodeBackgroundWork();
				assert.equal(response.status, outcome === 'success' ? 200 : cancel ? 499 : 502, text);
				assert.doesNotMatch(text, /PRIVATE_(AUTH|TRANSPORT|CANCEL)_DETAIL|PRIVATE KEY|@example/);
				if (outcome.endsWith('limit')) {
					assert.equal(response.headers.get('X-OctaFuse-Error-Code'), 'gateway.auxiliary_auth_limit_exceeded');
					assert.equal(JSON.parse(text).code, 'gateway.auxiliary_auth_limit_exceeded');
				}
				assert.equal(inference, sent); assert.equal(auth, outcome === 'success' || unknown || outcome === 'accepted-cancel' ? 1 : cancel ? sent + 1 : 3);
				assert.deepEqual(admissionCalls, sent ? ['reserve', 'dispatch'] : []);
				for (const error of errors) assert.match(String(error[0]), /"event":"gateway.images.upstream_error"/, 'no swallowed settlement failures');
				assert.equal(batches(), 1);
				const transitions = writes.filter(write => /UPDATE user_budget_reservations\s+SET state = \?/u.test(write.sql));
				assert.equal(transitions.length, sent);
				if (sent) {
					assert.equal(transitions[0]!.values[0], unknown ? 'expired' : 'settled');
					assert.equal(transitions[0]!.values[1], unknown || outcome === 'success' ? 40_000 : 0,
						'unknown holds ceiling; success uses verified price; cancellations/known rejection remain buyer-zero');
				}
				if (cancel && outcome !== 'accepted-cancel') {
					late.resolve(new Response(new ReadableStream({ cancel() { cancelled++; return new Promise<void>(() => {}); } })));
					await new Promise<void>(resolve => setImmediate(resolve));
				}
				if (cancel) assert.equal(cancelled, 1);
			});
		}
	}
}

for (const prefix of ['/v1', '/api/v1']) for (const suffix of ['images', 'images/generations']) {
	for (const outcome of ['completed', 'client', 'deadline'] as const) {
		it(`${prefix}/${suffix}: SSE ${outcome} settles once even without downstream reads`, { timeout: 5000 }, async t => {
			const { app, writes, batches } = await fixture('images.generations', 'synthetic-key', true);
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			const errors: unknown[][] = []; let cancelled = 0; let sent = 0;
			t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
			const parent = new AbortController();
			const source = new ReadableStream<Uint8Array>({
				start(c) { if (outcome === 'completed') c.enqueue(new TextEncoder().encode('data: {"type":"image_generation.completed","b64_json":"AQI="}\n\ndata: [DONE]\n\n')); },
				cancel() { cancelled++; return new Promise<void>(() => {}); },
			});
			t.mock.method(globalThis, 'fetch', async () => { sent++; return new Response(source, { headers: { 'Content-Type': 'text/event-stream' } }); });
			const response = await app.request(`${prefix}/${suffix}`, { method: 'POST', signal: parent.signal,
				headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: MODEL_IDS[0], prompt: 'synthetic', stream: true }),
			}, { REQUEST_BODY_LOGGING: 'off' });
			assert.equal(response.status, 200);
			if (outcome === 'completed') assert.match(await response.text(), /\[DONE\]/);
			else if (outcome === 'client') parent.abort(); else t.mock.timers.tick(300_000);
			await drainNodeBackgroundWork();
			assert.deepEqual(errors, []); assert.equal(sent, 1); assert.equal(batches(), 1); assert.equal(cancelled, 1); assert.equal(source.locked, false);
			const transitions = writes.filter(write => /UPDATE user_budget_reservations\s+SET state = \?/u.test(write.sql));
			assert.equal(transitions.length, 1); assert.equal(transitions[0]!.values[0], 'settled');
			assert.equal(transitions[0]!.values[1], outcome === 'completed' ? 40_000 : 0);
			if (outcome !== 'completed') await response.body?.cancel();
		});
	}
}

// Real vector ingress/admission/settlement chain, with an in-memory SQL capture
// at the storage boundary. This verifies intent/amount, not database atomicity.
for (const operation of ['embeddings', 'rerank'] as const) {
	for (const prefix of ['/v1', '/api/v1']) {
		for (const outcome of ['auth-limit', 'auth-cancel', 'known-then-limit', 'known-then-cancel', 'invalid-accepted', 'transport-unknown'] as const) {
			it(`${prefix}/${operation}: ${outcome} preserves finite-budget settlement facts`, { timeout: 5000 }, async (t) => {
				const credential = (index: number) => JSON.stringify({ type: 'service_account',
					client_email: `synthetic-${index}@example.invalid`, private_key: syntheticPrivateKey });
				const { app, batches, admissionCalls, writes } = await fixture(operation, credential, true);
				const parent = new AbortController(); const entered = deferred<void>(); const late = deferred<Response>();
				const cancel = outcome.endsWith('cancel');
				const sent = outcome.startsWith('auth-') ? 0 : 1;
				const unknown = outcome === 'invalid-accepted' || outcome === 'transport-unknown';
				let authCalls = 0; let inferenceCalls = 0; let authSignal: AbortSignal | null | undefined;
				const errors: unknown[][] = [];
				t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
				t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
					if (String(input) === GCP_OAUTH_TOKEN_URL) {
						authCalls++;
						if (sent && authCalls === 1) return Response.json({ access_token: 'synthetic', expires_in: 3600 });
						if (cancel) { authSignal = init?.signal; entered.resolve(); return late.promise; }
						return Response.json({ error: 'private auth detail' }, { status: 503 });
					}
					inferenceCalls++;
					if (outcome === 'transport-unknown') throw new Error('private transport detail');
					return outcome === 'invalid-accepted' ? Response.json({}) : Response.json({ error: 'unavailable' }, { status: outcome.startsWith('known-') ? 429 : 503 });
				});
				const pending = app.request(`${prefix}/${operation}`, {
					method: 'POST', signal: parent.signal,
					headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
					body: JSON.stringify({ model: MODEL_IDS[0], ...(operation === 'embeddings'
						? { input: 'synthetic' } : { query: 'synthetic', documents: ['synthetic'] }) }),
				}, { REQUEST_BODY_LOGGING: 'off' });
				if (cancel) { await entered.promise; parent.abort('private client cancellation detail'); }
				const response = await pending;
				const text = await response.text();
				await drainNodeBackgroundWork();
				assert.equal(response.status, cancel ? 499 : 502, JSON.stringify({ text, errors }));
				assert.doesNotMatch(text, /private (auth|transport|client)|PRIVATE KEY|synthetic-.*@/);
				assert.equal(inferenceCalls, sent);
				assert.equal(authCalls, cancel ? sent + 1 : unknown ? 1 : 3);
				assert.deepEqual(admissionCalls, sent ? ['reserve', 'dispatch'] : []);
				assert.deepEqual(errors, [], 'no swallowed admission/settlement error');
				assert.equal(batches(), 1, 'one terminal usage record');
				const transitions = writes.filter(write => /UPDATE user_budget_reservations\s+SET state = \?/u.test(write.sql));
				assert.equal(transitions.length, sent);
				if (sent) {
					assert.equal(transitions[0]!.values[0], unknown ? 'expired' : 'settled');
					if (unknown) assert.ok(Number(transitions[0]!.values[1]) > 0, 'accepted/unknown work retains the reserved ceiling');
					else assert.equal(transitions[0]!.values[1], 0, 'known rejection then local auth stop settles zero');
				}
				if (cancel) {
					assert.equal(authSignal?.aborted, true);
					let cancelled = 0;
					late.resolve(new Response(new ReadableStream({ cancel() { cancelled++; return new Promise<void>(() => {}); } })));
					await new Promise<void>(resolve => setImmediate(resolve));
					assert.equal(cancelled, 1); assert.equal(inferenceCalls, sent);
				}
			});
		}
	}
}

// ASR does not share Images' buyer-zero-on-cancel rule: after accepted/unknown
// work, retain its reservation ceiling pending authoritative reconciliation.
for (const variant of ['openai', 'sync', 'async', 'native'] as const) for (const prefix of ['/v1', '/api/v1']) {
	// The native DashScope surface has no /api/v1 alias in createProxyApp.
	if (variant === 'native' && prefix === '/api/v1') continue;
	for (const outcome of ['auth-limit', 'auth-cancel', 'auth-deadline', 'known-then-limit', 'known-then-cancel', 'invalid-accepted', 'transport-unknown', 'accepted-cancel', 'accepted-deadline', 'success'] as const) {
		it(`${prefix}/ASR(${variant}): ${outcome} preserves admission and settlement facts`, { timeout: 5000 }, async t => {
			const { app, writes, batches, admissionCalls } = await fixture(variant === 'native' ? 'audio.transcriptions.multimodal' : 'audio.transcriptions',
				index => JSON.stringify({ type: 'service_account', client_email: `asr-${index}@example.invalid`, private_key: syntheticPrivateKey }), true, variant);
			if (outcome.endsWith('deadline')) t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			const parent = new AbortController(); const entered = deferred<void>(); const late = deferred<Response>();
			const stop = outcome.endsWith('cancel') || outcome.endsWith('deadline');
			const sent = outcome.startsWith('auth-') ? 0 : 1;
			const unknown = ['invalid-accepted', 'transport-unknown', 'accepted-cancel', 'accepted-deadline'].includes(outcome);
			let auth = 0; let submissions = 0; let queries = 0; let cancels = 0;
			const errors: unknown[][] = [];
			t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
			t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input) === GCP_OAUTH_TOKEN_URL) {
					auth++;
					if (sent && auth === 1) return Response.json({ access_token: 'synthetic', expires_in: 3600 });
					if (stop) { entered.resolve(); return late.promise; }
					return Response.json({ error: 'PRIVATE_AUTH_DETAIL' }, { status: 503 });
				}
				assert.equal(init?.redirect, 'manual');
				if (variant === 'async' && init?.method !== 'POST') {
					queries++;
					if (String(input).includes('/tasks/')) return Response.json({ output: { task_status: 'SUCCEEDED', results: [{ transcription_url: 'https://result.example/asr.json' }] }, usage: { seconds: 1 } });
					return Response.json({ transcripts: [{ text: 'synthetic', sentences: [] }] });
				}
				submissions++;
				if (outcome === 'transport-unknown') throw new Error('PRIVATE_TRANSPORT_DETAIL');
				if (outcome.startsWith('accepted-')) return new Response(new ReadableStream<Uint8Array>({
					pull() { entered.resolve(); return new Promise<void>(() => {}); },
					cancel() { cancels++; return new Promise<void>(() => {}); },
				}, { highWaterMark: 0 }));
				if (outcome === 'success') return Response.json(variant === 'async' ? { output: { task_id: 'task-1' } }
					: variant === 'openai' ? { text: 'synthetic', duration: 1 }
					: { output: { text: 'synthetic', choices: [{ message: { content: [{ text: 'synthetic' }] } }] }, usage: { seconds: 1 } });
					return Response.json({}, { status: outcome === 'invalid-accepted' ? 200 : outcome.startsWith('known-') ? 429 : 503 });
			});
			const json = variant === 'native' || variant === 'openai';
			const form = new FormData(); form.append('model', MODEL_IDS[0]!);
			if (variant === 'async') form.append('file_url', 'https://audio.example/test.wav');
			else form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }), 'test.wav');
			const suffix = variant === 'native' ? '/dashscope/services/aigc/multimodal-generation/generation' : '/audio/transcriptions';
			const pending = app.request(prefix + suffix, { method: 'POST', signal: parent.signal,
				headers: { Authorization: 'Bearer synthetic-client-key', ...(json ? { 'Content-Type': 'application/json' } : {}) },
				body: json ? JSON.stringify({ model: MODEL_IDS[0], ...(variant === 'native'
					? { input: { messages: [] } } : { input_audio: { data: 'AQID', format: 'wav' } }) }) : form,
			}, { REQUEST_BODY_LOGGING: 'off' });
			if (stop) {
				const early = await Promise.race([entered.promise.then(() => null), Promise.resolve(pending)]);
				if (early) assert.fail(`Request returned before cancellation boundary: ${early.status} ${await early.text()}`);
				if (outcome.endsWith('deadline')) t.mock.timers.tick(120_000); else parent.abort('PRIVATE_CANCEL_DETAIL');
			}
			const response = await pending; const text = await response.text(); await drainNodeBackgroundWork();
			assert.equal(response.status, outcome === 'success' ? 200 : stop ? outcome.endsWith('deadline') ? 504 : 499 : 502, text);
			assert.doesNotMatch(text, /PRIVATE_(AUTH|TRANSPORT|CANCEL)_DETAIL|PRIVATE KEY|@example/);
			if (stop || outcome.endsWith('limit')) {
				const code = outcome.endsWith('limit') ? 'gateway.auxiliary_auth_limit_exceeded' : outcome.endsWith('deadline') ? 'gateway.request_deadline_exceeded' : 'gateway.request_cancelled';
				assert.equal(response.headers.get('X-OctaFuse-Error-Code'), code); assert.equal(JSON.parse(text).code, code);
			}
			assert.equal(submissions, sent); assert.equal(queries, variant === 'async' && outcome === 'success' ? 2 : 0);
			assert.equal(auth, outcome === 'success' || unknown ? 1 : stop ? sent + 1 : 3);
			assert.deepEqual(admissionCalls, sent ? ['reserve', 'dispatch'] : []);
			for (const error of errors) assert.match(String(error[0]), /"event":"gateway.audio.upstream_error"/, 'no swallowed settlement failure');
			assert.equal(batches(), 1);
			const transitions = writes.filter(write => /UPDATE user_budget_reservations\s+SET state = \?/u.test(write.sql));
			assert.equal(transitions.length, sent);
			if (sent) {
				assert.equal(transitions[0]!.values[0], unknown ? 'expired' : 'settled');
				assert.equal(transitions[0]!.values[1], unknown ? 1_500_000 : outcome === 'success' ? 1000 : 0);
			}
			if (stop && !outcome.startsWith('accepted-')) { late.resolve(new Response(new ReadableStream({ cancel() { cancels++; return new Promise<void>(() => {}); } }))); await new Promise<void>(resolve => setImmediate(resolve)); }
			if (stop) assert.equal(cancels, 1);
		});
	}
}

// TTS uses the existing character-billing contract. Accepted cancellation is
// unknown, not Images' buyer-zero rule. This asserts captured SQL intent only.
for (const variant of ['openai', 'speech', 'minimax'] as const) for (const prefix of ['/v1', '/api/v1']) {
	for (const outcome of ['auth-limit', 'auth-cancel', 'auth-deadline', 'known-then-limit', 'known-then-cancel', 'invalid-accepted', 'transport-unknown', 'headers-cancel', 'success'] as const) {
		it(`${prefix}/TTS(${variant}): ${outcome} preserves finite-budget settlement facts`, { timeout: 5000 }, async t => {
			const { app, writes, batches, admissionCalls } = await fixture('audio.speech',
				index => JSON.stringify({ type: 'service_account', client_email: 'tts-' + index + '@example.invalid', private_key: syntheticPrivateKey }), true, 'openai', variant);
			if (outcome.endsWith('deadline')) t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			const parent = new AbortController(); const entered = deferred<void>(); const late = deferred<Response>();
			const stop = outcome.endsWith('cancel') || outcome.endsWith('deadline');
			const sent = outcome.startsWith('auth-') ? 0 : 1;
			const unknown = ['invalid-accepted', 'transport-unknown', 'headers-cancel'].includes(outcome);
			let auth = 0; let sends = 0; let cancels = 0;
			const errors: unknown[][] = [];
			t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
			t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input) === GCP_OAUTH_TOKEN_URL) {
					auth++;
					if (sent && auth === 1) return Response.json({ access_token: 'synthetic', expires_in: 3600 });
					if (stop) { entered.resolve(); return late.promise; }
					return Response.json({ error: 'PRIVATE_AUTH_DETAIL' }, { status: 503 });
				}
				assert.equal(init?.redirect, 'manual'); sends++;
				if (outcome === 'transport-unknown') throw new Error('PRIVATE_TRANSPORT_DETAIL');
				if (outcome === 'headers-cancel') { entered.resolve(); return late.promise; }
				if (outcome === 'success') return speechResponse(variant, false);
					return Response.json({}, { status: outcome === 'invalid-accepted' ? 200 : outcome.startsWith('known-') ? 429 : 503 });
			});
			const pending = app.request(prefix + '/audio/speech', { method: 'POST', signal: parent.signal,
				headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: MODEL_IDS[0], input: 'hello', voice: 'synthetic', response_format: 'pcm' }),
			}, { REQUEST_BODY_LOGGING: 'off' });
			if (stop) {
				const early = await Promise.race([entered.promise.then(() => null), Promise.resolve(pending)]);
				if (early) assert.fail('Request returned before stop boundary: ' + early.status + ' ' + await early.text());
				if (outcome.endsWith('deadline')) t.mock.timers.tick(300_000); else parent.abort('PRIVATE_CANCEL_DETAIL');
			}
			const response = await pending;
			const text = await response.text(); await drainNodeBackgroundWork();
			assert.equal(response.status, outcome === 'success' ? 200 : stop ? outcome.endsWith('deadline') ? 504 : 499 : 502, text);
			assert.doesNotMatch(text, /PRIVATE_(AUTH|TRANSPORT|CANCEL)_DETAIL|PRIVATE KEY|@example/);
			if (stop || outcome.endsWith('limit')) {
				const code = outcome.endsWith('limit') ? 'gateway.auxiliary_auth_limit_exceeded' : outcome.endsWith('deadline') ? 'gateway.request_deadline_exceeded' : 'gateway.request_cancelled';
				assert.equal(response.headers.get('X-OctaFuse-Error-Code'), code); assert.equal(JSON.parse(text).code, code);
			}
			assert.equal(sends, sent); assert.equal(auth, outcome === 'success' || unknown ? 1 : stop ? sent + 1 : 3);
			assert.deepEqual(admissionCalls, sent ? ['reserve', 'dispatch'] : []);
			for (const error of errors) assert.match(String(error[0]), /"event":"gateway.audio_speech.upstream_error"/, 'no swallowed settlement failure');
			assert.equal(batches(), 1);
			const transitions = writes.filter(write => /UPDATE user_budget_reservations\s+SET state = \?/u.test(write.sql));
			assert.equal(transitions.length, sent);
			if (sent) {
				assert.equal(transitions[0]!.values[0], unknown ? 'expired' : 'settled');
				assert.equal(transitions[0]!.values[1], unknown || outcome === 'success' ? 5000 : 0);
			}
			if (stop) {
				late.resolve(new Response(new ReadableStream({ cancel() { cancels++; return new Promise<void>(() => {}); } })));
				await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(cancels, 1);
			}
		});
	}
	for (const streamFormat of ['audio', 'sse'] as const) for (const stop of ['client', 'deadline', 'downstream', 'success'] as const) {
		it(`${prefix}/TTS(${variant}/${streamFormat}): ${stop} owns settlement after headers`, { timeout: 5000 }, async t => {
			const { app, writes, batches, admissionCalls } = await fixture('audio.speech', 'synthetic-key', true, 'openai', variant);
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			const parent = new AbortController(); let cancels = 0; let sends = 0;
			const errors: unknown[][] = []; t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
			const source = new ReadableStream<Uint8Array>({
				start(c) { if (variant !== 'openai') c.enqueue(speechEvent(variant, false)); },
				cancel() { cancels++; return new Promise<void>(() => {}); },
			}, { highWaterMark: 0 });
			t.mock.method(globalThis, 'fetch', async () => {
				sends++;
				return stop === 'success' ? speechResponse(variant, streamFormat === 'sse')
					: new Response(source, { headers: { 'Content-Type': variant === 'openai' && streamFormat === 'audio' ? 'audio/pcm' : 'text/event-stream' } });
			});
			const response = await app.request(prefix + '/audio/speech', { method: 'POST', signal: parent.signal,
				headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: MODEL_IDS[0], input: 'hello', voice: 'synthetic', response_format: 'pcm', stream_format: streamFormat }),
			}, { REQUEST_BODY_LOGGING: 'off' });
			assert.equal(response.status, 200, response.status !== 200 ? await response.text() : undefined);
			if (stop === 'success') await response.arrayBuffer();
			else if (stop === 'client') parent.abort('PRIVATE_CANCEL_DETAIL');
			else if (stop === 'deadline') t.mock.timers.tick(300_000);
			else await response.body?.cancel();
			await drainNodeBackgroundWork();
			assert.deepEqual(errors, []); assert.equal(sends, 1); assert.equal(batches(), 1);
			assert.deepEqual(admissionCalls, ['reserve', 'dispatch']);
			const transitions = writes.filter(write => /UPDATE user_budget_reservations\s+SET state = \?/u.test(write.sql));
			assert.equal(transitions.length, 1); assert.equal(transitions[0]!.values[0], stop === 'success' ? 'settled' : 'expired');
			assert.equal(transitions[0]!.values[1], 5000, 'five codepoints use the confirmed price; unknown holds the ceiling');
			assert.doesNotMatch(JSON.stringify(writes), /PRIVATE_CANCEL_DETAIL/);
			if (stop !== 'success') { assert.equal(cancels, 1); assert.equal(source.locked, false); }
			if (stop === 'client' || stop === 'deadline') await assert.rejects(response.arrayBuffer(), /Audio speech request/);
		});
	}
}
// Qwen currently emits WAV only; the public contract accepts MP3/PCM.
// Preserve fail-closed behavior rather than quietly labelling WAV as PCM.
for (const prefix of ['/v1', '/api/v1']) for (const format of ['mp3', 'pcm', 'wav'] as const) {
	it(`${prefix}/TTS(qwen): incompatible public ${format} is refused before OAuth/admission`, async t => {
		const { app, batches, admissionCalls } = await fixture('audio.speech', 'synthetic-key', true, 'openai', 'qwen');
		const calls = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected upstream'); });
		const response = await app.request(prefix + '/audio/speech', { method: 'POST',
			headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: MODEL_IDS[0], input: 'hello', voice: 'synthetic', response_format: format }),
		}, { REQUEST_BODY_LOGGING: 'off' });
		assert.equal(response.status, format === 'wav' ? 400 : 502, await response.text());
		assert.equal(response.headers.get('X-OctaFuse-Error-Code'), format === 'wav' ? 'gateway.invalid_request' : 'gateway.route_resolution_failed');
		await drainNodeBackgroundWork(); assert.equal(calls.mock.callCount(), 0); assert.deepEqual(admissionCalls, []); assert.equal(batches(), 0);
	});
}

function speechEvent(variant: 'openai' | 'speech' | 'qwen' | 'minimax', terminal: boolean): Uint8Array {
	const value = variant === 'openai' ? terminal
		? { type: 'speech.audio.done', usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }
		: { type: 'speech.audio.delta', audio: 'AQID' }
		: { output: variant === 'minimax' ? { data: { audio: '010203', status: terminal ? 2 : 1 } }
			: { audio: { data: 'AQID' }, finish_reason: terminal ? 'stop' : null }, usage: { characters: 999 } };
	return new TextEncoder().encode('data: ' + JSON.stringify(value) + '\n\n');
}
function speechResponse(variant: 'openai' | 'speech' | 'qwen' | 'minimax', sse: boolean): Response {
	return variant === 'openai' && !sse ? new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/pcm' } })
		: new Response(speechEvent(variant, true), { headers: { 'Content-Type': 'text/event-stream' } });
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

for (const [suffix, operation] of [
	['chat/completions', 'chat'], ['completions', 'chat'], ['messages', 'messages'], ['responses', 'responses'],
] as const) {
	for (const prefix of ['/v1', '/api/v1']) {
		it(`${prefix}/${suffix} propagates cancellation inside model suffix resolution`, { timeout: 5000 }, async (t) => {
			const { storage, batches } = await fixture(operation);
			const entered = deferred<void>(); const late = deferred<null>(); const ids: string[] = [];
			t.mock.method(storage.repositories.modelRouting, 'getModelById', (id: string) => { ids.push(id); entered.resolve(); return late.promise; });
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			const fetches = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected inference'); });
			const app = createProxyApp(async () => storage);
			const response = app.request(`${prefix}/${suffix}`, {
				method: 'POST', headers: { Authorization: 'Bearer synthetic-client-key' },
				body: JSON.stringify({ model: `${MODEL_IDS[0]}:default`, ...(suffix === 'completions' ? { prompt: 'hi' } : {}) }),
			}, {});
			await entered.promise; t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			await assertEarlyFailure(await response, 504, 'gateway.request_deadline_exceeded', operation);
			late.resolve(null); await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(ids, [`${MODEL_IDS[0]}:default`], 'must not query the base model after outer timeout');
			assert.equal(fetches.mock.callCount(), 0); assert.equal(batches(), 0);
		});
	}
	for (const rejectWrite of [false, true]) {
		it(`${suffix} keeps provider-key migration owned when planner times out (reject=${rejectWrite})`, { timeout: 5000 }, async (t) => {
			const { storage, batches } = await fixture(operation);
			const entered = deferred<void>(); const write = deferred<number>();
			const upgrades = t.mock.method(storage.repositories.providers, 'updateProviderByPatch', () => { entered.resolve(); return write.promise; });
			const configuredStorage = { ...storage, repositories: { ...storage.repositories,
				providers: createEncryptedProvidersRepository(storage.repositories.providers, 'synthetic-request-test-encryption-secret'),
			} };
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			const fetches = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected inference'); });
			const app = createProxyApp(async () => configuredStorage);
			let finished = false;
			const response = Promise.resolve(app.request(`/v1/${suffix}`, {
				method: 'POST', headers: { Authorization: 'Bearer synthetic-client-key' },
				body: JSON.stringify({ model: MODEL_IDS[0], ...(suffix === 'completions' ? { prompt: 'hi' } : {}) }),
			}, {})).then((value) => { finished = true; return value; });
			await entered.promise; t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(finished, false, 'request lifetime must contain the pending compatibility write');
			if (rejectWrite) write.reject(new Error('synthetic migration rejection')); else write.resolve(1);
			await assertEarlyFailure(await response, 504, 'gateway.request_deadline_exceeded', operation);
			assert.equal(upgrades.mock.callCount(), 1); assert.equal(fetches.mock.callCount(), 0); assert.equal(batches(), 0);
		});
	}
}

async function assertEarlyFailure(response: Response, status: number, code: string, operation: string) {
	assert.equal(response.status, status);
	assert.equal(response.headers.get('X-OctaFuse-Error-Code'), code);
	const body = await response.json();
	assert.doesNotMatch(JSON.stringify(body), /private client cancellation detail/);
	assert.ok(body && typeof body === 'object' && 'code' in body && 'error' in body);
	assert.equal(body.code, code);
	assert.ok(body.error && typeof body.error === 'object');
	if (operation === 'responses') {
		assert.ok('status' in body);
		assert.equal(body.status, 'failed');
	} else if (operation === 'messages') {
		assert.ok('type' in body);
		assert.equal(body.type, 'error');
	} else {
		assert.ok('code' in body.error);
		assert.equal(body.error.code, status);
	}
}

it('scopes the arrival deadline to exact text POST routes, including aliases', () => {
	for (const prefix of ['/v1', '/api/v1']) {
		for (const suffix of ['/chat/completions', '/completions', '/messages', '/responses']) {
			assert.equal(isTextInferenceRequest('POST', prefix + suffix), true);
			assert.equal(isTextInferenceRequest('POST', prefix + suffix + '/'), true);
			assert.equal(isTextInferenceRequest('GET', prefix + suffix), false);
			assert.equal(isTextInferenceRequest('POST', prefix + suffix + '/other'), false);
		}
	}
	for (const path of ['/v1/images', '/v1/audio/speech', '/v1beta/models/m:generateContent', '/api/v1/batches']) {
		assert.equal(isTextInferenceRequest('POST', path), false);
	}
});

for (const [suffix, operation] of [
	['chat/completions', 'chat'], ['completions', 'chat'], ['messages', 'messages'], ['responses', 'responses'],
] as const) {
	for (const prefix of ['/v1', '/api/v1']) {
		const path = `${prefix}/${suffix}`;
		for (const declared of [false, true]) {
			it(`${path} stops a silent upload at the arrival deadline (content-length=${declared})`, { timeout: 5000 }, async (t) => {
				const { storage, batches } = await fixture(operation);
				t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
				t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected inference'); });
				const entered = deferred<void>();
				let cancelled = 0;
				const body = new ReadableStream<Uint8Array>({
					pull() { entered.resolve(); return new Promise<void>(() => {}); },
					cancel() { cancelled++; return new Promise<void>(() => {}); },
				}, { highWaterMark: 0 });
				const init = { method: 'POST', body, duplex: 'half', headers: {
					Authorization: 'Bearer synthetic-client-key', ...(declared ? { 'Content-Length': '1' } : {}),
				} };
				const app = createProxyApp(async () => storage);
				const response = app.request(path, init, {});
				await entered.promise;
				t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
				await assertEarlyFailure(await response, 504, 'gateway.request_deadline_exceeded', operation);
				assert.equal(cancelled, 1);
				assert.equal(body.locked, false);
				assert.equal(batches(), 0, 'an upload timeout is not a billable provider attempt');
			});
		}
		it(`${path} rejects observed oversize despite a small content-length`, { timeout: 5000 }, async (t) => {
			const { storage, batches } = await fixture(operation);
			let cancelled = 0;
			const body = new ReadableStream<Uint8Array>({
				pull(c) { c.enqueue(new Uint8Array(MAX_REQUEST_BODY_BYTES + 1)); },
				cancel() { cancelled++; return new Promise<void>(() => {}); },
			}, { highWaterMark: 0 });
			t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected inference'); });
			const app = createProxyApp(async () => storage);
			const init = { method: 'POST', body, duplex: 'half', headers: {
				Authorization: 'Bearer synthetic-client-key', 'Content-Length': '1',
			} };
			await assertEarlyFailure(await app.request(path, init, {}), 413, 'gateway.payload_too_large', operation);
			assert.equal(cancelled, 1);
			assert.equal(body.locked, false);
			assert.equal(batches(), 0);
		});
	}
	for (const stage of ['preset', 'model'] as const) {
		it(`${suffix} bounds ${stage} preparation and never dispatches its late result`, { timeout: 5000 }, async (t) => {
			const { storage, batches } = await fixture(operation);
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			const entered = deferred<void>();
			const late = deferred<null>();
			if (stage === 'preset') t.mock.method(storage.repositories.requestPresets, 'getAccessibleBySlug', () => {
				entered.resolve(); return late.promise;
			});
			else t.mock.method(storage.repositories.modelRouting, 'getModelById', () => {
				entered.resolve(); return late.promise;
			});
			let fetches = 0;
			t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('Unexpected inference'); });
			const app = createProxyApp(async () => storage);
			const response = app.request(`/v1/${suffix}`, {
				method: 'POST', headers: { Authorization: 'Bearer synthetic-client-key' },
				body: JSON.stringify({ model: MODEL_IDS[0], ...(suffix === 'completions' ? { prompt: 'hi' } : {}),
					...(stage === 'preset' ? { preset: 'synthetic' } : {}) }),
			}, {});
			await entered.promise;
			t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			await assertEarlyFailure(await response, 504, 'gateway.request_deadline_exceeded', operation);
			late.resolve(null);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(fetches, 0);
			assert.equal(batches(), 0);
		});
	}
}

it('does not orphan a pending auth migration or start a late budget reset', { timeout: 5000 }, async (t) => {
	const { storage, key } = await fixture('chat');
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
	const entered = deferred<void>();
	const migration = deferred<ResolvedGatewayKeyRow>();
	t.mock.method(storage.repositories.apiKeys, 'getApiKeyWithUserByKey', () => { entered.resolve(); return migration.promise; });
	const userReads = t.mock.method(storage.repositories.users, 'getById', async () => { throw new Error('Late budget reset'); });
	const app = createProxyApp(async () => storage);
	let finished = false;
	const response = Promise.resolve(app.request('/v1/chat/completions', {
		method: 'POST', body: '{}', headers: { Authorization: 'Bearer synthetic-client-key' },
	}, {})).then((value) => { finished = true; return value; });
	await entered.promise;
	t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(finished, false, 'owned migration completion must not be abandoned');
	migration.resolve({ ...key, budget_period: 'daily', budget_reset_at: '2026-01-01T00:00:00.000Z' });
	await assertEarlyFailure(await response, 504, 'gateway.request_deadline_exceeded', 'chat');
	assert.equal(userReads.mock.callCount(), 0);
});

it('counts storage initialization time and refuses authentication after late initialization', async (t) => {
	const { storage } = await fixture('chat');
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
	const auth = t.mock.method(storage.repositories.apiKeys, 'getApiKeyWithUserByKey', async () => { throw new Error('Late auth'); });
	const app = createProxyApp(async () => { t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS); return storage; });
	await assertEarlyFailure(await app.request('/v1/chat/completions', { method: 'POST', body: '{}' }, {}),
		504, 'gateway.request_deadline_exceeded', 'chat');
	assert.equal(auth.mock.callCount(), 0);
});

it('cancels an unread upload on early authentication rejection without waiting for ACK', { timeout: 5000 }, async () => {
	const { storage } = await fixture('chat');
	let pulls = 0;
	let cancels = 0;
	const body = new ReadableStream<Uint8Array>({
		pull() { pulls++; return new Promise<void>(() => {}); },
		cancel() { cancels++; return new Promise<void>(() => {}); },
	}, { highWaterMark: 0 });
	const app = createProxyApp(async () => storage);
	const init = { method: 'POST', body, duplex: 'half' };
	const response = await app.request('/v1/chat/completions', init, {});
	assert.equal(response.status, 401);
	assert.equal(pulls, 0);
	assert.equal(cancels, 1);
	assert.equal(body.locked, false);
});

it('returns a sanitized cancellation before storage when the client is already gone', async () => {
	const parent = new AbortController();
	parent.abort('private client cancellation detail');
	let storageCalls = 0;
	const app = createProxyApp(async () => { storageCalls++; throw new Error('Unexpected storage'); });
	const response = await app.request('/api/v1/responses', { method: 'POST', signal: parent.signal, body: '{}' }, {});
	await assertEarlyFailure(response, 499, 'gateway.request_cancelled', 'responses');
	assert.equal(storageCalls, 0);
});

it('keeps the dispatcher connected to client cancellation after entry middleware has returned', { timeout: 5000 }, async (t) => {
	const { app, batches } = await fixture('chat');
	const parent = new AbortController();
	let upstreamSignal: AbortSignal | undefined;
	let cancelled = 0;
	t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
		upstreamSignal = init?.signal ?? undefined;
		return new Response(new ReadableStream<Uint8Array>({
			pull() { return new Promise<void>(() => {}); },
			cancel() { cancelled++; return new Promise<void>(() => {}); },
		}), { headers: { 'Content-Type': 'text/event-stream' } });
	});
	const response = await app.request('/v1/chat/completions', {
		method: 'POST', signal: parent.signal, headers: { Authorization: 'Bearer synthetic-client-key' },
		body: JSON.stringify({ model: MODEL_IDS[0], stream: true, messages: [{ role: 'user', content: 'hi' }] }),
	}, {});
	assert.equal(response.status, 200);
	assert.equal(upstreamSignal?.aborted, false);
	parent.abort('private client cancellation detail');
	await assert.rejects(response.text(), /cancelled/);
	await drainNodeBackgroundWork();
	assert.equal(upstreamSignal?.aborted, true);
	assert.equal(cancelled, 1);
	assert.equal(batches(), 1);
});

// Full public Gemini route and accounting code; the SQL sink captures intent,
// not a real database commit. Cleanup ACK is deliberately withheld at assertions.
for (const stop of ['client', 'downstream'] as const) {
	for (const phase of ['silent', 'blocked-write'] as const) for (const ack of ['resolve', 'reject'] as const) {
		it(`Gemini public settlement ignores cleanup ACK: ${stop}/${phase}/${ack}`, { timeout: 5000 }, async t => {
			const { app, batches, writes, admissionCalls } = await fixture('models.generate', 'synthetic-key', true);
			const parent = new AbortController(); const cleanup = deferred<void>();
			const errors: unknown[][] = []; let sends = 0; let cancels = 0;
			t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
			const source = new ReadableStream<Uint8Array>({
				start(c) {
					if (phase === 'blocked-write') c.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\n'));
				},
				cancel() { cancels++; return cleanup.promise; },
			});
			t.mock.method(globalThis, 'fetch', async () => {
				sends++;
				return new Response(source, { headers: { 'Content-Type': 'text/event-stream' } });
			});
			let response: Response | undefined;
			t.after(async () => {
				parent.abort(); cleanup.resolve();
				await response?.body?.cancel().catch(() => {});
				await drainNodeBackgroundWork();
			});
			response = await app.request('/v1beta/models/model-0:streamGenerateContent', {
				method: 'POST', signal: parent.signal,
				headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
				body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
			}, { REQUEST_BODY_LOGGING: 'off' });
			assert.equal(response.status, 200, response.status !== 200 ? await response.text() : undefined);
			if (stop === 'client') parent.abort('PRIVATE_CANCEL_DETAIL'); else await response.body?.cancel('PRIVATE_CANCEL_DETAIL');
			let accounted = false;
			const accounting = drainNodeBackgroundWork().then(() => { accounted = true; });
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(accounted, true, 'Public accounting must finish before an untrusted cleanup ACK');
			await accounting;
			assert.equal(cancels, 1); assert.equal(sends, 1); assert.equal(batches(), 1);
			assert.equal(source.locked, true, 'Pump still owns abandoned reader while cleanup is pending');
			assert.deepEqual(errors, []); assert.deepEqual(admissionCalls, ['reserve', 'dispatch']);
			const transitions = writes.filter(write => /UPDATE user_budget_reservations\s+SET state = \?/u.test(write.sql));
			assert.equal(transitions.length, 1); assert.equal(transitions[0]!.values[0], 'expired');
			assert.ok(Number(transitions[0]!.values[1]) > 0, 'Unknown upstream cost retains reservation ceiling');
			assert.doesNotMatch(JSON.stringify(writes), /PRIVATE_CANCEL_DETAIL|Stream usage timeout/);
			assert.match(JSON.stringify(writes), /Client disconnected/);
			if (ack === 'resolve') cleanup.resolve(); else cleanup.reject(new Error('PRIVATE_CLEANUP_DETAIL'));
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(source.locked, false); assert.equal(cancels, 1); assert.equal(batches(), 1);
			if (stop === 'client') await assert.rejects(response.body!.cancel(), /cancelled/);
			else await response.body?.cancel();
		});
	}
}

const geminiInput = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
const nextGeminiTurn = () => new Promise<void>(resolve => setImmediate(resolve));
function geminiLogValue(writes: Array<{ sql: string; values: unknown[] }>, column: string) {
	const logs = writes.filter(write => /INSERT INTO api_key_request_logs/u.test(write.sql));
	assert.equal(logs.length, 1);
	const columns = logs[0]!.sql.match(/api_key_request_logs\s*\(([^)]+)\)/u)?.[1]?.split(',').map(value => value.trim());
	assert.ok(columns); const index = columns.indexOf(column); assert.ok(index >= 0);
	return logs[0]!.values[index];
}
for (const action of ['generateContent', 'streamGenerateContent'] as const) {
	for (const phase of ['storage', 'auth', 'guardrail', 'model'] as const) for (const stop of ['client', 'deadline'] as const) {
		it(`Gemini ingress stops preparation: ${action}/${phase}/${stop}`, { timeout: 5000 }, async t => {
			const f = await fixture('models.generate'); const parent = new AbortController();
			const entered = deferred<void>(), gate = deferred<void>(); let sends = 0, settled = false;
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			const wait = async () => { entered.resolve(); await gate.promise; };
			const repos = f.storage.repositories;
			if (phase === 'auth') { const original = repos.apiKeys.getApiKeyWithUserByKey; t.mock.method(repos.apiKeys, 'getApiKeyWithUserByKey', async (...args: Parameters<typeof original>) => { await wait(); return original(...args); }); }
			if (phase === 'guardrail') t.mock.method(repos.guardrails, 'getEffectiveForRequest', async () => { await wait(); return []; });
			if (phase === 'model') { const original = repos.modelRouting.getModelById; t.mock.method(repos.modelRouting, 'getModelById', async (...args: Parameters<typeof original>) => { await wait(); return original(...args); }); }
			t.mock.method(globalThis, 'fetch', async () => { sends++; return Response.json({ usageMetadata: { promptTokenCount: 0 } }); });
			const app = createProxyApp(async () => { if (phase === 'storage') await wait(); return f.storage; });
			const pending = Promise.resolve(app.request('/v1beta/models/model-0:' + action, {
				method: 'POST', signal: parent.signal, body: geminiInput, headers: { Authorization: 'Bearer synthetic-client-key' },
			}, {})).then(response => { settled = true; return response; });
			void pending.catch(() => {});
			t.after(async () => { parent.abort(); gate.resolve(); await pending; await drainNodeBackgroundWork(); });
			await entered.promise;
			if (stop === 'client') parent.abort('PRIVATE_CANCEL_DETAIL'); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			await nextGeminiTurn();
			// Storage initialization and legacy-key lookup can own clients/migration
			// writes. Preserve that owner; only proven read-only phases detach.
			const ownsInitialization = phase === 'storage' || phase === 'auth';
			assert.equal(settled, !ownsInitialization);
			if (ownsInitialization) gate.resolve();
			const response = await pending;
			await assertEarlyFailure(response, stop === 'client' ? 499 : 504, stop === 'client' ? 'gateway.request_cancelled' : 'gateway.request_deadline_exceeded', 'chat');
			gate.resolve(); await nextGeminiTurn(); assert.equal(sends, 0); assert.equal(f.batches(), 0);
		});
	}
	for (const stop of ['client', 'deadline'] as const) {
		it(`Gemini ingress stops incomplete upload: ${action}/${stop}`, { timeout: 5000 }, async t => {
			const f = await fixture('models.generate'); const parent = new AbortController(), entered = deferred<void>();
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			let controller!: ReadableStreamDefaultController<Uint8Array>; let cancels = 0, settled = false;
			const source = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull() { entered.resolve(); return new Promise<void>(() => {}); }, cancel() { cancels++; } });
			const app = createProxyApp(async () => f.storage);
			const init = { method: 'POST', signal: parent.signal, body: source, duplex: 'half', headers: { Authorization: 'Bearer synthetic-client-key' } };
			const pending = Promise.resolve(app.request('/v1beta/models/model-0:' + action, init, {})).then(response => { settled = true; return response; });
			void pending.catch(() => {});
			t.after(async () => { parent.abort(); if (!cancels) controller.close(); await pending; await drainNodeBackgroundWork(); });
			await entered.promise;
			if (stop === 'client') parent.abort(); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			await nextGeminiTurn(); assert.equal(settled, true, 'Incomplete upload must stop at the request boundary');
			await assertEarlyFailure(await pending, stop === 'client' ? 499 : 504, stop === 'client' ? 'gateway.request_cancelled' : 'gateway.request_deadline_exceeded', 'chat');
			assert.equal(cancels, 1); assert.equal(f.batches(), 0);
		});
	}
}
for (const phase of ['headers', 'json', 'silent-sse', 'usage-sse'] as const) {
	it(`Gemini ingress keeps original deadline through dispatch: ${phase}`, { timeout: 5000 }, async t => {
		const f = await fixture('models.generate', 'synthetic-key', true); const parent = new AbortController();
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
		const original = f.storage.repositories.modelRouting.getModelById;
		t.mock.method(f.storage.repositories.modelRouting, 'getModelById', async (...args: Parameters<typeof original>) => { t.mock.timers.tick(1000); return original(...args); });
		const entered = deferred<void>(), headerGate = deferred<Response>(); let sends = 0, cancels = 0, settled = false;
		let upstreamSignal: AbortSignal | undefined;
		const source = new ReadableStream<Uint8Array>({ start(c) {
			if (phase === 'json') c.enqueue(new TextEncoder().encode('{'));
			if (phase === 'usage-sse') c.enqueue(new TextEncoder().encode('data: {"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":1,"totalTokenCount":3}}\n\n'));
		}, cancel() { cancels++; } });
		t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
			sends++; upstreamSignal = init?.signal ?? undefined; entered.resolve();
			return phase === 'headers' ? headerGate.promise : new Response(source, { headers: { 'Content-Type': phase === 'json' ? 'application/json' : 'text/event-stream' } });
		});
		const app = createProxyApp(async () => f.storage);
		const action = phase.endsWith('sse') ? 'streamGenerateContent' : 'generateContent';
		const pending = Promise.resolve(app.request('/v1beta/models/model-0:' + action, { method: 'POST', signal: parent.signal, body: geminiInput, headers: { Authorization: 'Bearer synthetic-client-key' } }, {})).then(response => { settled = true; return response; });
		void pending.catch(() => {});
		t.after(async () => { parent.abort(); headerGate.resolve(Response.json({})); const response = await pending; await response.body?.cancel().catch(() => {}); await drainNodeBackgroundWork(); });
		await entered.promise; await nextGeminiTurn();
		t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS - (Date.now() - new Date(NOW).getTime()));
		await nextGeminiTurn();
		assert.equal(upstreamSignal?.aborted, true, 'Preparation time is not a new dispatch deadline');
		assert.equal(settled, true); const response = await pending;
		if (phase.endsWith('sse')) { assert.equal(response.status, 200); await assert.rejects(response.text(), /deadline/); }
		else await assertEarlyFailure(response, 504, 'gateway.request_deadline_exceeded', 'chat');
		await drainNodeBackgroundWork(); assert.equal(sends, 1); assert.equal(f.batches(), 1);
		assert.equal(geminiLogValue(f.writes, 'status'), 'error');
		assert.match(String(geminiLogValue(f.writes, 'error_message')), /deadline/);
		const transitions = f.writes.filter(write => /UPDATE user_budget_reservations\s+SET state = \?/u.test(write.sql));
		assert.equal(transitions.length, 1); assert.equal(transitions[0]!.values[0], 'expired');
		if (phase !== 'headers') assert.equal(cancels, 1);
	});
}
for (const partialUsage of [false, true]) {
	it(`Gemini ingress records stream failure, never success: usage=${partialUsage}`, { timeout: 5000 }, async t => {
		const f = await fixture('models.generate', 'synthetic-key', true); let controller!: ReadableStreamDefaultController<Uint8Array>;
		const source = new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(partialUsage ? { usageMetadata: { promptTokenCount: 2 } } : {}) + '\n\n')); } });
		t.mock.method(globalThis, 'fetch', async () => new Response(source, { headers: { 'Content-Type': 'text/event-stream' } }));
		const response = await f.app.request('/v1beta/models/model-0:streamGenerateContent', { method: 'POST', body: geminiInput, headers: { Authorization: 'Bearer synthetic-client-key' } }, {});
		assert.equal(response.status, 200); const reader = response.body!.getReader(); await reader.read();
		controller.error(new Error('PRIVATE_TRANSPORT_DETAIL')); await reader.read(); reader.releaseLock();
		await drainNodeBackgroundWork(); assert.equal(f.batches(), 1);
		assert.equal(geminiLogValue(f.writes, 'status'), 'error');
		assert.equal(geminiLogValue(f.writes, 'error_message'), 'Gemini upstream response stream failed');
		assert.doesNotMatch(JSON.stringify(f.writes), /PRIVATE_TRANSPORT_DETAIL/);
	});
}

it('Gemini ingress matcher covers encoded/invalid action parameters but no other surface', () => {
	for (const path of ['/v1beta/models/a:generateContent', '/v1beta/models/a:streamGenerateContent', '/v1beta/models/a%3AgenerateContent', '/v1beta/models/a%2Fb:generateContent', '/v1beta/models/invalid', '/v1beta/models/a:generateContent/']) assert.equal(isGeminiInferenceRequest('POST', path), true, path);
	for (const path of ['/v1beta/models', '/v1beta/models/', '/v1beta/models/a/b:generateContent', '/v1beta/models/a:generateContent/extra', '/api/v1beta/models/a:generateContent', '/v1/models/a:generateContent']) assert.equal(isGeminiInferenceRequest('POST', path), false, path);
	assert.equal(isGeminiInferenceRequest('GET', '/v1beta/models/a:generateContent'), false);
});
for (const stop of ['client', 'deadline'] as const) {
	for (const ack of ['resolve', 'reject'] as const) {
		it(`Gemini ingress owns pending guardrail audit: ${stop}/${ack}`, { timeout: 5000 }, async t => {
			const f = await fixture('models.generate'), parent = new AbortController(), gate = deferred<void>(), entered = deferred<void>();
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			const row: EffectiveGuardrailRow = { id: 'guardrail', workspace_id: 'workspace-test', owner_user_id: f.key.user_id, name: 'Synthetic', description: null,
				status: 'active', designated_version: 1, latest_version: 1, created_at: NOW, updated_at: NOW, version_id: 'version-1', version_config_json: '{"allowed_models":["not-this-model"]}',
				version_created_by_user_id: f.key.user_id, version_created_at: NOW, assignment_id: 'assignment', assignment_scope_type: 'user', assignment_scope_id: f.key.user_id };
			t.mock.method(f.storage.repositories.guardrails, 'getEffectiveForRequest', async () => [row]);
			let auditWrites = 0, settled = false;
			t.mock.method(f.storage.repositories.userAuditLogs, 'insertUserAuditLog', async () => { auditWrites++; entered.resolve(); await gate.promise; });
			const fetches = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected inference'); });
			const app = createProxyApp(async () => f.storage);
			const pending = Promise.resolve(app.request('/v1beta/models/model-0:generateContent', { method: 'POST', signal: parent.signal, body: geminiInput, headers: { Authorization: 'Bearer synthetic-client-key' } }, {})).then(response => { settled = true; return response; });
			void pending.catch(() => {});
			t.after(async () => { parent.abort(); gate.resolve(); await pending; await drainNodeBackgroundWork(); });
			await entered.promise; if (stop === 'client') parent.abort(); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			await nextGeminiTurn(); assert.equal(settled, false, 'Started audit write must retain request ownership');
			if (ack === 'resolve') gate.resolve(); else gate.reject(new Error('PRIVATE_AUDIT_DETAIL'));
			await assertEarlyFailure(await pending, stop === 'client' ? 499 : 504, stop === 'client' ? 'gateway.request_cancelled' : 'gateway.request_deadline_exceeded', 'chat');
			assert.equal(auditWrites, 1); assert.equal(fetches.mock.callCount(), 0); assert.equal(f.batches(), 0);
		});
	}
	it(`Gemini ingress owns budget admission before stopping dispatch: ${stop}`, { timeout: 5000 }, async t => {
		const f = await fixture('models.generate', 'synthetic-key', true), parent = new AbortController(), gate = deferred<void>(), entered = deferred<void>();
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
		const original = f.storage.repositories.userBudgets.reserve; let settled = false;
		t.mock.method(f.storage.repositories.userBudgets, 'reserve', async (...args: Parameters<typeof original>) => { entered.resolve(); await gate.promise; return original(...args); });
		const fetches = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected inference'); });
		const app = createProxyApp(async () => f.storage);
		const pending = Promise.resolve(app.request('/v1beta/models/model-0:generateContent', { method: 'POST', signal: parent.signal, body: geminiInput, headers: { Authorization: 'Bearer synthetic-client-key' } }, {})).then(response => { settled = true; return response; });
		void pending.catch(() => {});
		t.after(async () => { parent.abort(); gate.resolve(); await pending; await drainNodeBackgroundWork(); });
		await entered.promise; if (stop === 'client') parent.abort(); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
		await nextGeminiTurn(); assert.equal(settled, false, 'Admission must not become an orphaned write'); gate.resolve();
		await assertEarlyFailure(await pending, stop === 'client' ? 499 : 504, stop === 'client' ? 'gateway.request_cancelled' : 'gateway.request_deadline_exceeded', 'chat');
		await drainNodeBackgroundWork(); assert.equal(fetches.mock.callCount(), 0); assert.equal(f.batches(), 1);
		const transitions = f.writes.filter(write => /UPDATE user_budget_reservations\s+SET state = \?/u.test(write.sql));
		assert.equal(transitions.length, 1); assert.equal(transitions[0]!.values[0], 'settled'); assert.equal(transitions[0]!.values[1], 0);
	});
}

it('rejects declared oversized uploads before storage and releases the source', async () => {
	let storageCalls = 0;
	let cancels = 0;
	const body = new ReadableStream<Uint8Array>({ cancel() { cancels++; } }, { highWaterMark: 0 });
	const app = createProxyApp(async () => { storageCalls++; throw new Error('Unexpected storage'); });
	const init = { method: 'POST', body, duplex: 'half', headers: { 'Content-Length': String(MAX_REQUEST_BODY_BYTES + 1) } };
	await assertEarlyFailure(await app.request('/v1/responses', init, {}), 413, 'gateway.payload_too_large', 'responses');
	assert.equal(storageCalls, 0);
	assert.equal(cancels, 1);
	assert.equal(body.locked, false);
});

it('cancels a pre-aborted streamed upload rather than leaving it unread', async () => {
	const parent = new AbortController();
	parent.abort('private client cancellation detail');
	let cancels = 0;
	const body = new ReadableStream<Uint8Array>({ cancel() { cancels++; } }, { highWaterMark: 0 });
	const app = createProxyApp(async () => { throw new Error('Unexpected storage'); });
	const init = { method: 'POST', body, signal: parent.signal, duplex: 'half' };
	await assertEarlyFailure(await app.request('/v1/messages', init, {}), 499, 'gateway.request_cancelled', 'messages');
	assert.equal(cancels, 1);
	assert.equal(body.locked, false);
});

it('cancels a pending streamed upload when the client disconnects after authentication', { timeout: 5000 }, async () => {
	const { storage } = await fixture('responses');
	const parent = new AbortController();
	const entered = deferred<void>();
	let cancels = 0;
	const body = new ReadableStream<Uint8Array>({
		pull() { entered.resolve(); return new Promise<void>(() => {}); },
		cancel() { cancels++; return new Promise<void>(() => {}); },
	}, { highWaterMark: 0 });
	const app = createProxyApp(async () => storage);
	const init = { method: 'POST', body, signal: parent.signal, duplex: 'half', headers: { Authorization: 'Bearer synthetic-client-key' } };
	const response = app.request('/v1/responses', init, {});
	await entered.promise;
	parent.abort('private client cancellation detail');
	await assertEarlyFailure(await response, 499, 'gateway.request_cancelled', 'responses');
	assert.equal(cancels, 1);
	assert.equal(body.locked, false);
});

for (const [path, operation] of [
	['/v1/chat/completions', 'chat'], ['/v1/completions', 'chat'],
	['/v1/messages', 'messages'], ['/v1/responses', 'responses'],
] as const) {
	for (const partition of ['model', 'none'] as const) {
		it(`${path} terminates a sent deadline once with protocol-correct errors (partition=${partition})`, async (t) => {
			const { app, batches, storage, key } = await fixture(operation);
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			// Authentication time consumes the SAME arrival budget as dispatch.
			t.mock.method(storage.repositories.apiKeys, 'getApiKeyWithUserByKey', async () => {
				t.mock.timers.tick(120_000);
				return key;
			});
			const errors: unknown[][] = [];
			t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
			let fetches = 0;
			t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				assert.equal(new URL(String(input)).hostname, 'upstream.invalid');
				fetches++;
				assert.equal(Date.now() - Date.parse(NOW), 120_000);
				return new Promise((_resolve, reject) => {
					assert.ok(init?.signal);
					init.signal.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
					t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS - 120_000);
				});
			});
			const response = await app.request(path, {
				method: 'POST', headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: MODEL_IDS[0], models: MODEL_IDS,
					provider: { sort: { by: 'price', partition } },
					...(path === '/v1/completions' ? { prompt: 'hi' } : operation === 'responses' ? { input: 'hi' } : { messages: [{ role: 'user', content: 'hi' }] }),
				}),
			}, { REQUEST_BODY_LOGGING: 'off' });
			const body = await response.json();
			await drainNodeBackgroundWork();
			assert.equal(response.status, 504, JSON.stringify({ body, errors }));
			assert.equal(fetches, 1, 'deadline must terminate both ordinary and global outer loops');
			assert.ok(body && typeof body === 'object' && 'code' in body && 'error' in body);
			assert.equal(body.code, 'gateway.request_deadline_exceeded');
			assert.ok(body.error && typeof body.error === 'object');
			if (operation === 'messages') {
				assert.ok('type' in body.error && 'type' in body && 'request_id' in body);
				assert.equal(body.type, 'error');
				assert.equal(body.error.type, 'timeout_error');
				assert.equal(typeof body.request_id, 'string');
			} else if (operation === 'responses') {
				assert.ok('status' in body && 'code' in body.error);
				assert.equal(body.status, 'failed');
				assert.equal(body.error.code, 'server_error');
			} else {
				assert.ok('code' in body.error);
				assert.equal(body.error.code, 504);
			}
			assert.deepEqual(errors, [], 'no swallowed fixture or settlement errors');
			assert.equal(batches(), 1, 'exactly one terminal usage record');
		});
	}
	for (const outcome of ['clear-429', 'unknown'] as const) {
		it(`${path} shares the outer model budget and stops on ${outcome}`, async (t) => {
			const { app, batches } = await fixture(operation);
			const errors: unknown[][] = [];
			t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
			let fetches = 0;
			t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
				assert.equal(new URL(String(input)).hostname, 'upstream.invalid');
				fetches += 1;
				if (outcome === 'unknown') throw new TypeError('synthetic connection reset after write');
				return Response.json({ error: { message: 'rate limited' } }, { status: 429 });
			});
			const response = await app.request(path, {
				method: 'POST', headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: MODEL_IDS[0], models: MODEL_IDS,
					...(path === '/v1/completions' ? { prompt: 'hi' } : operation === 'responses' ? { input: 'hi' } : { messages: [{ role: 'user', content: 'hi' }] }),
				}),
			}, { REQUEST_BODY_LOGGING: 'off' });
			const body = await response.json();
			await drainNodeBackgroundWork();
			assert.equal(response.status, 502, JSON.stringify({ body, errors }));
			assert.equal(fetches, outcome === 'unknown' ? 1 : 3);
			// Preserve the existing public normalization of a gateway fetch failure.
			assert.ok(body && typeof body === 'object' && 'code' in body);
			assert.equal(body.code, outcome === 'unknown' ? 'upstream.server_error' : 'gateway.dispatch_limit_exceeded');
			assert.deepEqual(errors, [], 'no swallowed fixture or settlement errors');
			assert.equal(batches(), 1, 'one terminal usage record, not one per fallback model');
		});
	}
}

const socketTextResources = [
	['/v1/chat/completions', 'chat'],
	['/v1/completions', 'chat'],
	['/v1/responses', 'responses'],
	['/v1/messages', 'messages'],
] as const;
for (const [path, operation] of socketTextResources) for (const terminal of ['all-429', 'socket-reset'] as const) {
	it(`public ${path} bounds outer models and inner keys over real sockets: ${terminal}`, { timeout: 10000 }, async t => {
		const received: Array<{ model: string; credential: string | undefined; bytes: number }> = [];
		const server = createServer(async (incoming, outgoing) => {
			const chunks: Uint8Array[] = [];
			for await (const chunk of incoming) chunks.push(chunk);
			const body = Buffer.concat(chunks);
			const parsed = JSON.parse(body.toString('utf8')) as { model: string };
			const credentialHeader = incoming.headers.authorization ?? incoming.headers['x-api-key'];
			received.push({ model: parsed.model,
				credential: Array.isArray(credentialHeader) ? credentialHeader[0] : credentialHeader, bytes: body.length });
			if (terminal === 'socket-reset' && received.length === 2) {
				outgoing.destroy();
				return;
			}
			outgoing.writeHead(429, { 'Content-Type': 'application/json' });
			outgoing.end('{"error":{"message":"synthetic rate limit"}}');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		t.after(async () => {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		});
		const upstreamBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
		const nativeFetch = globalThis.fetch.bind(globalThis);
		t.mock.method(globalThis, 'fetch', (input: RequestInfo | URL, init?: RequestInit) => {
			assert.equal(new URL(input instanceof Request ? input.url : String(input)).origin, new URL(upstreamBase).origin);
			return nativeFetch(input, init);
		});
		for (const name of ['log', 'warn', 'error'] as const) t.mock.method(console, name, () => {});
		const { app, batches, configuredRoutes } = await fixture(operation, index => `synthetic-provider-key-${index}`,
			false, 'openai', 'openai', { routeFanout: [2, 40, 40, 40, 40], upstreamBase });
		assert.equal(configuredRoutes, 162);
		const response = await app.request(path, {
			method: 'POST', headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
			body: textJsonResourceInput(path, operation, 'model'),
		}, { REQUEST_BODY_LOGGING: 'off' });
		const publicBody = await response.json() as { code?: string };
		await drainNodeBackgroundWork();
		const expectedSends = terminal === 'all-429' ? 3 : 2;
		assert.equal(received.length, expectedSends, 'outer and inner route loops share one physical POST ceiling');
		assert.deepEqual(received.map(row => row.model),
			terminal === 'all-429' ? ['private-model-0', 'private-model-0-1', 'private-model-1']
				: ['private-model-0', 'private-model-0-1']);
		assert.equal(new Set(received.map(row => row.credential)).size, expectedSends, 'each attempted route has a distinct credential');
		assert.ok(received.every(row => row.bytes > 0));
		assert.equal(response.status, 502);
		assert.equal(publicBody.code, terminal === 'all-429' ? 'gateway.dispatch_limit_exceeded' : 'upstream.server_error');
		assert.equal(batches(), 1);
	});
}

const socketNonTextResources = [
	['/v1/images/generations', 'images.generations', { model: MODEL_IDS[0], prompt: 'synthetic' }],
	['/v1/embeddings', 'embeddings', { model: MODEL_IDS[0], input: 'synthetic' }],
	['/v1/rerank', 'rerank', { model: MODEL_IDS[0], query: 'synthetic', documents: ['synthetic'] }],
] as const;
for (const [path, operation, input] of socketNonTextResources) for (const terminal of ['all-429', 'socket-reset'] as const) {
	it(`public ${path} bounds deep route fanout over real sockets: ${terminal}`, { timeout: 10000 }, async t => {
		const received: Array<{ credential: string | undefined; bytes: number }> = [];
		const server = createServer(async (incoming, outgoing) => {
			const chunks: Uint8Array[] = [];
			for await (const chunk of incoming) chunks.push(chunk);
			const body = Buffer.concat(chunks);
			received.push({ credential: incoming.headers.authorization, bytes: body.length });
			if (terminal === 'socket-reset' && received.length === 2) {
				outgoing.destroy();
				return;
			}
			outgoing.writeHead(429, { 'Content-Type': 'application/json' });
			outgoing.end('{"error":{"message":"synthetic rate limit"}}');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		t.after(async () => {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		});
		const upstreamBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
		const nativeFetch = globalThis.fetch.bind(globalThis);
		t.mock.method(globalThis, 'fetch', (target: RequestInfo | URL, init?: RequestInit) => {
			assert.equal(new URL(target instanceof Request ? target.url : String(target)).origin, new URL(upstreamBase).origin);
			return nativeFetch(target, init);
		});
		for (const name of ['log', 'warn', 'error'] as const) t.mock.method(console, name, () => {});
		const { app, batches, configuredRoutes } = await fixture(operation,
			index => `synthetic-provider-key-${index}`, true, 'openai', 'openai',
			{ routeFanout: [40, 0, 0, 0, 0], upstreamBase });
		assert.equal(configuredRoutes, 40);
		const response = await app.request(path, {
			method: 'POST', headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
			body: JSON.stringify(input),
		}, { REQUEST_BODY_LOGGING: 'off' });
		const publicBody = await response.json() as { code?: string };
		await drainNodeBackgroundWork();
		assert.equal(received.length, terminal === 'all-429' ? 3 : 2,
			`all nested route candidates share one physical POST ceiling: ${JSON.stringify({ status: response.status, publicBody })}`);
		assert.equal(new Set(received.map(row => row.credential)).size, received.length);
		assert.ok(received.every(row => row.bytes > 0));
		assert.equal(response.status, 502);
		assert.equal(publicBody.code, terminal === 'all-429' ? 'gateway.dispatch_limit_exceeded' : 'upstream.server_error');
		assert.equal(batches(), 1);
	});
}
