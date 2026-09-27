import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { encryptSharedKeySecret } from '@octafuse/core';
import type { RouteResult } from './model-router';
import type { ModelFallbackPlanResult } from './model-fallback-plan';
import {
	createFinalChatQuoteInput,
	originalChatBodySha256,
} from './chat-final-quote-input';
import { parseOpenAiModelFallbacks } from './model-fallbacks';
import { createObservedPrivateCompleteTextHolderV384 } from './private-complete-text-observed-holder-v384';
import { createPrivateCompleteTextHolderV365 } from './private-complete-text-holder-v365';
import {
	createCompleteChatHolderDispatchV385,
	type CompleteChatHolderDispatchInputV385,
} from './complete-chat-holder-dispatch-v385';

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const secret = 'private-holder-only-synthetic-provider-kek-v385';
const bearer = 'synthetic-platform-provider-bearer-v385';
const attemptNonce = '11111111-1111-4111-8111-111111111111';
const quoteId = '22222222-2222-4222-8222-222222222222';
const grantId = '33333333-3333-4333-8333-333333333333';
const holderRunId = '44444444-4444-4444-8444-444444444444';
const sendStartId = '55555555-5555-4555-8555-555555555555';

async function fixture(base: string) {
	const raw = '{"model":"test-model","messages":[{"role":"user","content":"hello"}],"stream":true}';
	const body = JSON.parse(raw) as Record<string, unknown>;
	const parsedResult = parseOpenAiModelFallbacks(body);
	assert.equal(parsedResult.ok, true);
	if (!parsedResult.ok) throw new Error('fixture parser rejected body');
	const parsed = parsedResult.value;
	const ciphertext = await encryptSharedKeySecret(bearer, secret,
		'cinatoken:provider-key:private-provider-v385');
	const route = {
		targetId: 'route-v385', providerId: 'private-provider-v385',
		providerKeyId: 'private-provider-v385', providerModelName: 'upstream-model-v385',
		gatewayCandidateIndex: 0, gatewayModelId: 'test-model',
		upstreamProtocol: 'openai', upstreamOperation: 'chat', adapter: 'passthrough',
		providerEndpoints: { openai: { base } }, providerApiKey: ciphertext,
		providerSharedChannelType: null, priceOverrideRaw: null, customParams: null,
		endpoint: { id: 'endpoint-v385' },
	} as RouteResult;
	const plan = {
		ok: true,
		candidates: [{ requestedModelId: 'test-model', baseModelId: 'test-model',
			upstreamBody: parsed.upstreamBody, routes: [route] }],
		endpointPartition: 'model', globalRoutes: [],
	} as unknown as Extract<ModelFallbackPlanResult, { ok: true }>;
	const bytes = new TextEncoder().encode(raw);
	const finalQuoteInput = await createFinalChatQuoteInput({
		requestId: 'actual-chat-request-v385',
		originalBodySha256: await originalChatBodySha256(bytes.buffer as ArrayBuffer),
		finalBody: body, parsed, plan,
	});
	const quote = Object.freeze({
		quoteId, requestId: finalQuoteInput.requestId,
		finalBodySha256: finalQuoteInput.finalBodySha256,
		modelIds: Object.freeze(['test-model']), routeCount: 1,
		credentialClass: 'platform' as const, maxPerAttemptCeilingMicros: 30_001,
		threeAttemptCeilingMicros: 90_003,
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
	});
	const admission = Object.freeze({
		status: 'admitted' as const, quoteId, requestId: quote.requestId,
		finalBodySha256: quote.finalBodySha256,
		reservedMicros: quote.threeAttemptCeilingMicros,
		ordinary: 'reserved' as const, guardrailCount: 0,
		expiresAt: new Date(Date.now() + 55_000).toISOString(),
	});
	const input: CompleteChatHolderDispatchInputV385 = {
		finalQuoteInput, currentBody: body, parsed, plan, selectedRoute: route,
		guardrailIntents: [], bearer: 'sk-local-v385-actual-chat-bearer',
		identity: { apiKeyId: 'key-v385', userId: 'user-v385',
			workspaceId: 'workspace-v385', budgetEpoch: 0 },
		runtimeClient: { driver: 'postgres' } as CompleteChatHolderDispatchInputV385['runtimeClient'],
		runtimeConnectionString: 'postgres://runtime:secret@localhost/test',
		capabilityConnectionString: 'postgres://cap:secret@localhost/test',
		quoteConnectionString: 'postgres://quote:secret@localhost/test',
		admissionConnectionString: 'postgres://admission:secret@localhost/test',
		holderBinding: { async fetch() { throw new Error('unconfigured holder binding'); } },
		signal: new AbortController().signal,
	};
	return { input, quote, admission, route, ciphertext };
}

test('actual final Chat input crosses quote/admission receipt ports and six-field private holder envelope once', async () => {
	let physicalPosts = 0;
	let uploadBody: Record<string, unknown> | undefined;
	const server = createServer(async (req, res) => {
		physicalPosts++;
		assert.equal(req.method, 'POST');
		assert.equal(req.url, '/v1/chat/completions');
		assert.equal(req.headers.authorization, `Bearer ${bearer}`);
		let bytes = '';
		for await (const chunk of req) bytes += chunk.toString();
		uploadBody = JSON.parse(bytes) as Record<string, unknown>;
		res.writeHead(200, { 'Content-Type': 'text/event-stream',
			'X-Private-Provider-Header': 'must-not-cross-binding' });
		res.end('data: {"answer":"hello"}\n\n');
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	try {
		const f = await fixture(`http://127.0.0.1:${address.port}/v1`);
		const events: string[] = [];
		const holder = createObservedPrivateCompleteTextHolderV384({
			providerEncryptionSecret: secret,
			newHolderRunId: () => holderRunId,
			async loadQuote(id) { events.push('private-quote'); assert.equal(id, quoteId); return f.quote; },
			async loadRoute({ routeTargetId }) {
				events.push('private-route'); assert.equal(routeTargetId, f.route.targetId); return f.route;
			},
			async loadProviderCiphertext(id) {
				events.push('private-secret'); assert.equal(id, f.route.providerId); return f.ciphertext;
			},
			async grantAttempt(nonce, claim) {
				events.push('grant'); assert.equal(nonce, attemptNonce);
				return { ...claim, status: 'committed', commitAcknowledged: true,
					grantId, attemptNumber: 1, manifestSourceGeneration: 7,
					currentSourceGeneration: 7,
					manifestAttestedSourceSha256: 'a'.repeat(64),
					currentAttestedSourceSha256: 'a'.repeat(64),
					manifestSourceSha256: 'b'.repeat(64),
					expiresAt: new Date(Date.now() + 30_000).toISOString() };
			},
			async claimSendCustody(id, run) {
				events.push('custody'); assert.equal(id, grantId); assert.equal(run, holderRunId);
				return { status: 'custody_claim_recorded', commitAcknowledged: true,
					grantId: id, holderRunId: run, leaseEpoch: 1,
					leaseUntil: new Date(Date.now() + 20_000).toISOString() };
			},
			async recordSendStart(id, run, epoch, uploadSha256) {
				events.push('send-start');
				return { status: 'start_recorded', commitAcknowledged: true,
					sendStartId, grantId: id, holderRunId: run, leaseEpoch: epoch,
					uploadSha256, expiresAt: new Date(Date.now() + 10_000).toISOString() };
			},
			async appendFetchInvokedFact(fact) {
				events.push('fact');
				const evidenceSha256 = sha(`{"observation": "fetch_invoked", "uploadSha256": "${fact.evidence.uploadSha256}"}`);
				return { status: 'fact_recorded', commitAcknowledged: true,
					factId: '66666666-6666-4666-8666-666666666666',
					grantId: fact.grantId, sourceKind: 'holder', kind: 'fetch_invoked',
					evidenceNonce: fact.evidenceNonce, evidenceSha256,
				} as const;
			},
		});
		const envelopeKeys = ['attemptNonce', 'candidateIndex', 'finalBodyUtf8',
			'quoteId', 'requestId', 'routeTargetId'];
		const binding = { async fetch(request: Request) {
			events.push('binding');
			assert.equal(request.url, 'https://holder.service.invalid/complete-text-attempt');
			assert.equal(request.method, 'POST');
			assert.equal(request.headers.get('Content-Type'), 'application/json');
			const payload = await request.json() as Record<string, unknown>;
			assert.deepEqual(Object.keys(payload).sort(), envelopeKeys);
			assert.equal(payload.requestId, f.input.finalQuoteInput.requestId);
			assert.equal(payload.finalBodyUtf8, f.input.finalQuoteInput.finalBodyUtf8);
			assert.equal(JSON.stringify(payload).includes(secret), false);
			assert.equal(JSON.stringify(payload).includes(bearer), false);
			return holder.run(payload, request.signal);
		} };
		const dispatch = createCompleteChatHolderDispatchV385({
			...f.input, holderBinding: binding,
		}, {
			newAttemptNonce: () => attemptNonce,
			async issueQuote(params) {
				events.push('quote');
				assert.equal(params.finalQuoteInput, f.input.finalQuoteInput);
				assert.equal(params.identity.apiKeyId, 'key-v385');
				return f.quote;
			},
			async admitQuote(params) {
				events.push('admission');
				assert.equal(params.quote, f.quote);
				assert.deepEqual(params.guardrailIntents, []);
				return f.admission;
			},
		});
		const response = await dispatch.run();
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('X-Private-Provider-Header'), null);
		assert.equal(response.headers.get('Cache-Control'), 'no-store');
		assert.equal(await response.text(), 'data: {"answer":"hello"}\n\n');
		assert.equal(physicalPosts, 1);
		assert.equal(uploadBody?.model, 'upstream-model-v385');
		assert.equal(uploadBody?.models, undefined);
		assert.deepEqual(uploadBody?.stream_options, { include_usage: true });
		assert.deepEqual(events, ['quote', 'admission', 'binding', 'private-quote',
			'private-route', 'private-secret', 'grant', 'custody', 'send-start', 'fact']);
		await assert.rejects(dispatch.run(), /already entered/u);
		assert.equal(physicalPosts, 1);
	} finally {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});

test('unknown admission acknowledgement and changed final plan never enter the holder binding', async () => {
	const f = await fixture('http://127.0.0.1:9/v1');
	const events: string[] = [];
	const holderBinding = { async fetch() {
		events.push('binding'); return new Response('unexpected');
	} };
	const uncertain = createCompleteChatHolderDispatchV385({ ...f.input, holderBinding }, {
		newAttemptNonce: () => attemptNonce,
		async issueQuote() { events.push('quote'); return f.quote; },
		async admitQuote() { events.push('admission'); throw new Error('COMMIT acknowledgement lost'); },
	});
	await assert.rejects(uncertain.run(), /COMMIT acknowledgement lost/u);
	await assert.rejects(uncertain.run(), /already entered/u);
	assert.deepEqual(events, ['quote', 'admission']);
	(f.input.plan.candidates[0]!.routes[0] as RouteResult).targetId = 'changed-route';
	const changed = createCompleteChatHolderDispatchV385({ ...f.input, holderBinding }, {
		async issueQuote() { events.push('unexpected-quote'); return f.quote; },
	});
	await assert.rejects(changed.run(), /changed after planning/u);
	assert.deepEqual(events, ['quote', 'admission']);
});

test('Guardrail intents changed during quote await are rejected before admission or Binding', async () => {
	const f = await fixture('http://127.0.0.1:9/v1');
	const intents = [{ workspaceId: 'workspace-v385', assignmentId: 'assignment-v385',
		guardrailId: 'guardrail-v385', guardrailVersion: 1,
		scopeType: 'user' as const, scopeId: 'user-v385',
		period: 'daily' as const,
		periodStart: '2026-09-26T00:00:00.000Z',
		periodEnd: '2026-09-27T00:00:00.000Z', limitMicros: 1_000_000 }];
	let admissions = 0, bindingCalls = 0;
	const dispatch = createCompleteChatHolderDispatchV385({ ...f.input,
		guardrailIntents: intents,
		holderBinding: { async fetch() {
			bindingCalls++; return new Response('unexpected');
		} },
	}, {
		newAttemptNonce: () => attemptNonce,
		async issueQuote() {
			intents[0]!.limitMicros = 2_000_000;
			return f.quote;
		},
		async admitQuote() { admissions++; return f.admission; },
	});
	await assert.rejects(dispatch.run(), /Guardrail intents changed/u);
	assert.equal(admissions, 0);
	assert.equal(bindingCalls, 0);
});

test('authenticated identity changed during quote await cannot reach admission or Binding', async () => {
	const f = await fixture('http://127.0.0.1:9/v1');
	const identity = { ...f.input.identity };
	let admissions = 0, bindingCalls = 0;
	const dispatch = createCompleteChatHolderDispatchV385({ ...f.input,
		identity,
		holderBinding: { async fetch() {
			bindingCalls++; return new Response('unexpected');
		} },
	}, {
		newAttemptNonce: () => attemptNonce,
		async issueQuote(params) {
			assert.equal(params.identity.apiKeyId, 'key-v385');
			identity.apiKeyId = 'mutated-key';
			return f.quote;
		},
		async admitQuote() { admissions++; return f.admission; },
	});
	await assert.rejects(dispatch.run(), /Authenticated Chat identity changed/u);
	assert.equal(admissions, 0);
	assert.equal(bindingCalls, 0);
});

test('post-admission Binding failure leaves holds unresolved and a new instance cannot re-send after a recorded grant', async () => {
	let physicalPosts = 0;
	const server = createServer(async (req, res) => {
		physicalPosts++;
		for await (const _chunk of req) { /* complete the owned upload */ }
		res.writeHead(200, { 'Content-Type': 'text/event-stream' });
		res.end('data: done\n\n');
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	try {
		const f = await fixture(`http://127.0.0.1:${address.port}/v1`);
		const holds = { ordinary: 'reserved', guardrail: 'reserved' };
		let durableGrant = false;
		let grantCalls = 0;
		let sendStarts = 0;
		const nonces = [attemptNonce, '77777777-7777-4777-8777-777777777777'];
		const holder = () => createPrivateCompleteTextHolderV365({
			providerEncryptionSecret: secret,
			newHolderRunId: () => holderRunId,
			async loadQuote() { return f.quote; },
			async loadRoute() { return f.route; },
			async loadProviderCiphertext() { return f.ciphertext; },
			async grantAttempt(_nonce, claim) {
				grantCalls++;
				if (durableGrant) return { status: 'pending_unknown' };
				durableGrant = true;
				holds.ordinary = 'dispatched_unknown';
				holds.guardrail = 'dispatched_unknown';
				return { ...claim, status: 'committed', commitAcknowledged: true,
					grantId, attemptNumber: 1, manifestSourceGeneration: 7,
					currentSourceGeneration: 7,
					manifestAttestedSourceSha256: 'a'.repeat(64),
					currentAttestedSourceSha256: 'a'.repeat(64),
					manifestSourceSha256: 'b'.repeat(64),
					expiresAt: new Date(Date.now() + 30_000).toISOString() };
			},
			async claimSendCustody(id, run) {
				return { status: 'custody_claim_recorded', commitAcknowledged: true,
					grantId: id, holderRunId: run, leaseEpoch: 1,
					leaseUntil: new Date(Date.now() + 20_000).toISOString() };
			},
			async recordSendStart(id, run, epoch, uploadSha256) {
				sendStarts++;
				return { status: 'start_recorded', commitAcknowledged: true,
					sendStartId, grantId: id, holderRunId: run, leaseEpoch: epoch,
					uploadSha256, expiresAt: new Date(Date.now() + 10_000).toISOString() };
			},
		});
		const ports = {
			newAttemptNonce: () => nonces.shift()!,
			async issueQuote() { return f.quote; },
			async admitQuote() { return f.admission; },
		};
		const firstHolder = holder();
		const first = createCompleteChatHolderDispatchV385({ ...f.input,
			holderBinding: { async fetch(request) {
				const response = await firstHolder.run(await request.json(), request.signal);
				await response.body?.cancel();
				throw new Error('Service Binding response lost after holder POST');
			} },
		}, ports);
		await assert.rejects(first.run(), /response lost/u);
		assert.deepEqual(holds, { ordinary: 'dispatched_unknown', guardrail: 'dispatched_unknown' });
		assert.equal(physicalPosts, 1);
		assert.equal(sendStarts, 1);
		const secondHolder = holder();
		const second = createCompleteChatHolderDispatchV385({ ...f.input,
			holderBinding: { async fetch(request) {
				return secondHolder.run(await request.json(), request.signal);
			} },
		}, ports);
		await assert.rejects(second.run());
		assert.equal(grantCalls, 2);
		assert.equal(sendStarts, 1);
		assert.equal(physicalPosts, 1);
		assert.deepEqual(holds, { ordinary: 'dispatched_unknown', guardrail: 'dispatched_unknown' });
	} finally {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});
