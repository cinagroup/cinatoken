import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { it } from 'node:test';
import { encryptSharedKeySecret } from '@octafuse/core';
import type { RouteResult } from './model-router';
import type { CompleteFlatTextQuoteV360 } from './postgres-complete-chat-quote-v360';
import type { ChatTextHolderRequestV363 } from './chat-text-holder-request-v363';
import type { TextGrantClaimRequestV361 } from './chat-text-grant-egress-contract-v361';
import {
	createPrivateCompleteTextHolderV365,
	type PrivateCompleteTextHolderPortsV365,
} from './private-complete-text-holder-v365';

const SECRET = 'synthetic-provider-kek-for-holder-verification-v365';
const BEARER = 'synthetic-platform-provider-bearer-v365';
const ATTEMPT_NONCE = '99999999-9999-9999-9999-999999999999';
const HOLDER_RUN_ID = '88888888-8888-8888-8888-888888888888';
const GRANT_ID = '77777777-7777-7777-7777-777777777777';
const START_ID = '66666666-6666-6666-6666-666666666666';
const BODY = '{"max_completion_tokens":300,"messages":[{"content":"hello","role":"user"}],"model":"model-a","models":["model-a","model-b"],"stream":true}';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const renewalReceipt = (grantId: string, holderRunId: string,
	sendStartId: string, expectedEpoch: number) => ({
	status: 'renewal_recorded', commitAcknowledged: true, closeAcknowledged: true,
	grantId, holderRunId, sendStartId, leaseEpoch: expectedEpoch + 1,
	leaseUntil: new Date(Date.now() + 60_000).toISOString(),
});

async function loopback(handler: Parameters<typeof createServer>[0]) {
	const server = createServer(handler);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	return {
		server,
		base: `http://127.0.0.1:${address.port}/v1`,
		close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
	};
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(base: string, finalBodyUtf8 = BODY) {
	const ciphertext = await encryptSharedKeySecret(BEARER, SECRET, 'cinatoken:provider-key:provider-b');
	const quote: CompleteFlatTextQuoteV360 = Object.freeze({
		quoteId: '11111111-1111-1111-1111-111111111111',
		requestId: 'holder-request-1', finalBodySha256: sha(finalBodyUtf8),
		modelIds: Object.freeze(['model-a', 'model-b']), routeCount: 2,
		credentialClass: 'platform', maxPerAttemptCeilingMicros: 30_001,
		threeAttemptCeilingMicros: 90_003,
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
	});
	const request: ChatTextHolderRequestV363 = Object.freeze({
		requestId: quote.requestId, quoteId: quote.quoteId,
		attemptNonce: ATTEMPT_NONCE, candidateIndex: 1,
		routeTargetId: 'route-b', finalBodyUtf8,
	});
	const route = {
		targetId: 'route-b', providerId: 'provider-b', providerKeyId: 'provider-b',
		providerModelName: 'private-b', gatewayCandidateIndex: 1,
		gatewayModelId: 'model-b', upstreamProtocol: 'openai',
		upstreamOperation: 'chat', adapter: 'passthrough',
		providerEndpoints: { openai: { base } }, providerApiKey: ciphertext,
		providerSharedChannelType: null, priceOverrideRaw: null,
		customParams: null, endpoint: { id: 'endpoint-b' },
	} as RouteResult;
	return { quote, request, route, ciphertext };
}

function setup(f: Fixture, changes: Partial<PrivateCompleteTextHolderPortsV365> = {}) {
	const events: string[] = [];
	const ports: PrivateCompleteTextHolderPortsV365 = {
		providerEncryptionSecret: SECRET,
		newHolderRunId: () => HOLDER_RUN_ID,
		async loadQuote() { events.push('quote'); return f.quote; },
		async loadRoute() { events.push('route'); return f.route; },
		async loadProviderCiphertext() { events.push('ciphertext'); return f.ciphertext; },
		async grantAttempt(nonce: string, claim: TextGrantClaimRequestV361) {
			events.push('grant');
			assert.equal(nonce, ATTEMPT_NONCE);
			return {
				...claim, status: 'committed', commitAcknowledged: true,
				grantId: GRANT_ID, attemptNumber: 1,
				manifestSourceGeneration: 7, currentSourceGeneration: 7,
				manifestAttestedSourceSha256: 'a'.repeat(64),
				currentAttestedSourceSha256: 'a'.repeat(64),
				manifestSourceSha256: 'b'.repeat(64),
				expiresAt: new Date(Date.now() + 30_000).toISOString(),
			};
		},
		async claimSendCustody(grantId: string, holderRunId: string) {
			events.push('custody');
			assert.equal(grantId, GRANT_ID);
			assert.equal(holderRunId, HOLDER_RUN_ID);
			return {
				status: 'custody_claim_recorded', commitAcknowledged: true,
				grantId, holderRunId, leaseEpoch: 1,
				leaseUntil: new Date(Date.now() + 20_000).toISOString(),
			};
		},
		async recordSendStart(grantId: string, holderRunId: string, epoch: number, uploadSha256: string) {
			events.push('send-start');
			assert.equal(grantId, GRANT_ID);
			assert.equal(holderRunId, HOLDER_RUN_ID);
			assert.equal(epoch, 1);
			assert.match(uploadSha256, /^[0-9a-f]{64}$/u);
			return {
				status: 'start_recorded', commitAcknowledged: true,
				sendStartId: START_ID, grantId, holderRunId,
				leaseEpoch: epoch, uploadSha256,
				expiresAt: new Date(Date.now() + 10_000).toISOString(),
			};
		},
		...changes,
	};
	return { holder: createPrivateCompleteTextHolderV365(ports), events, ports };
}

it('holder privately freezes exact OpenAI wire and returns one raw streaming loopback response', async () => {
	let posts = 0;
	const target = await loopback(async (req, res) => {
		posts += 1;
		assert.equal(req.method, 'POST');
		assert.equal(req.headers.authorization, `Bearer ${BEARER}`);
		assert.equal(req.url, '/v1/chat/completions');
		let raw = '';
		for await (const chunk of req) raw += chunk.toString();
		const body = JSON.parse(raw) as Record<string, unknown>;
		assert.equal(body.model, 'private-b');
		assert.equal(body.models, undefined);
		assert.deepEqual(body.stream_options, { include_usage: true });
		assert.equal((body.messages as Array<{ content: string }>)[0]?.content, 'hello');
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.write('data: first\n\n');
		setTimeout(() => res.end('data: second\n\n'), 5);
	});
	try {
		const f = await fixture(target.base);
		const { holder, events } = setup(f);
		const response = await holder.run(f.request, new AbortController().signal);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('content-type'), 'text/event-stream');
		assert.equal(await response.text(), 'data: first\n\ndata: second\n\n');
		assert.equal(posts, 1);
		assert.deepEqual(events, ['quote', 'route', 'ciphertext', 'grant', 'custody', 'send-start']);
		await assert.rejects(holder.run(f.request, new AbortController().signal));
		assert.equal(posts, 1);
	} finally { await target.close(); }
});

it('early response headers do not tear down a still streaming request upload', async () => {
	const message = 'x'.repeat(700_000);
	const largeBody = BODY.replace('hello', message);
	let receivedBytes = 0;
	let posts = 0;
	const target = await loopback((req, res) => {
		posts += 1;
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.flushHeaders();
		req.on('data', chunk => { receivedBytes += (chunk as Buffer).byteLength; });
		req.on('end', () => res.end('data: complete\n\n'));
	});
	try {
		const f = await fixture(target.base, largeBody);
		const { holder } = setup(f);
		const response = await holder.run(f.request, new AbortController().signal);
		assert.equal(await response.text(), 'data: complete\n\n');
		assert.equal(posts, 1);
		assert.ok(receivedBytes >= message.length);
	} finally { await target.close(); }
});

it('caller cancellation after headers stops the raw upstream stream', async () => {
	let closeObserved!: () => void;
	const closed = new Promise<void>(resolve => { closeObserved = resolve; });
	const target = await loopback(async (req, res) => {
		for await (const _chunk of req) { /* consume the bounded upload */ }
		res.on('close', closeObserved);
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.write('data: first\n\n');
	});
	try {
		const f = await fixture(target.base);
		const { holder } = setup(f);
		const abort = new AbortController();
		const response = await holder.run(f.request, abort.signal);
		const reader = response.body!.getReader();
		const first = await reader.read();
		assert.equal(new TextDecoder().decode(first.value), 'data: first\n\n');
		abort.abort();
		await assert.rejects(reader.read());
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				closed,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error(
						'upstream stream did not close after cancellation')), 1500);
				}),
			]);
		} finally { if (timer) clearTimeout(timer); }
	} finally { await target.close(); }
});

it('stops an unrenewed streaming response before the local hold guard expires', async () => {
	let posts = 0;
	let closeObserved!: () => void;
	const closed = new Promise<void>(resolve => { closeObserved = resolve; });
	const target = await loopback(async (req, res) => {
		posts += 1;
		for await (const _chunk of req) { /* consume the bounded upload */ }
		res.on('close', closeObserved);
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.write('data: first\n\n');
	});
	try {
		const f = await fixture(target.base);
		const { holder } = setup(f, { maxUnrenewedStreamMs: 350 });
		const response = await holder.run(f.request, new AbortController().signal);
		const reader = response.body!.getReader();
		assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
		await assert.rejects(reader.read());
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				closed,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error(
						'upstream stream did not close at the lease guard')), 1500);
				}),
			]);
		} finally { if (timer) clearTimeout(timer); }
		assert.equal(posts, 1);
	} finally { await target.close(); }
});

it('crosses the initial local stream deadline only after acknowledged all-hold renewal', async () => {
	let posts = 0;
	const target = await loopback(async (req, res) => {
		posts += 1;
		for await (const _chunk of req) { /* consume the bounded upload */ }
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.write('data: first\n\n');
		setTimeout(() => res.end('data: after-initial-deadline\n\n'), 470);
	});
	try {
		const f = await fixture(target.base);
		const epochs: number[] = [];
		const { holder, events } = setup(f, {
			maxUnrenewedStreamMs: 260,
			async renewHolds(grantId, holderRunId, sendStartId, expectedEpoch) {
				assert.equal(grantId, GRANT_ID);
				assert.equal(holderRunId, HOLDER_RUN_ID);
				assert.equal(sendStartId, START_ID);
				epochs.push(expectedEpoch);
				return renewalReceipt(grantId, holderRunId, sendStartId, expectedEpoch);
			},
		});
		const response = await holder.run(f.request, new AbortController().signal);
		assert.equal(await response.text(), 'data: first\n\ndata: after-initial-deadline\n\n');
		assert.equal(posts, 1);
		assert.deepEqual(epochs, epochs.map((_epoch, index) => index + 1));
		assert.ok(epochs.length >= 2);
		assert.equal(events.filter(event => event === 'send-start').length, 1);
		await assert.rejects(holder.run(f.request, new AbortController().signal));
	} finally { await target.close(); }
});

it('stops upstream reading when renewal COMMIT or close ACK is unknown', async () => {
	let posts = 0;
	const closes: Promise<void>[] = [];
	const target = await loopback(async (req, res) => {
		posts += 1;
		for await (const _chunk of req) { /* consume the bounded upload */ }
		closes.push(new Promise(resolve => { res.once('close', resolve); }));
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.write('data: first\n\n');
	});
	try {
		const f = await fixture(target.base);
		for (const kind of ['unknown COMMIT', 'unknown close ACK']) {
			let calls = 0;
			const { holder } = setup(f, {
				maxUnrenewedStreamMs: 260,
				async renewHolds(grantId, holderRunId, sendStartId, expectedEpoch) {
					calls += 1;
					if (kind === 'unknown COMMIT') throw new Error('COMMIT unknown');
					return { ...renewalReceipt(grantId, holderRunId, sendStartId, expectedEpoch),
						closeAcknowledged: false };
				},
			});
			const response = await holder.run(f.request, new AbortController().signal);
			const reader = response.body!.getReader();
			assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
			await assert.rejects(reader.read(), kind);
			assert.equal(calls, 1);
		}
		assert.equal(posts, 2);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.all(closes),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error(
						'provider streams stayed open after unknown renewal ACK')), 1500);
				}),
			]);
		} finally { if (timer) clearTimeout(timer); }
	} finally { await target.close(); }
});

it('rejects stale or replayed renewal receipts and expires a missed renewal', async () => {
	let posts = 0;
	const target = await loopback(async (req, res) => {
		posts += 1;
		for await (const _chunk of req) { /* consume the bounded upload */ }
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.write('data: first\n\n');
	});
	try {
		const f = await fixture(target.base);
		const cases: Array<[string, NonNullable<PrivateCompleteTextHolderPortsV365['renewHolds']>]> = [
			['replay', async (grantId, holderRunId, sendStartId, epoch) => ({
				...renewalReceipt(grantId, holderRunId, sendStartId, epoch),
				status: 'already_recorded',
			})],
			['stale epoch', async (grantId, holderRunId, sendStartId, epoch) => ({
				...renewalReceipt(grantId, holderRunId, sendStartId, epoch),
				leaseEpoch: epoch,
			})],
			['wrong run', async (grantId, _holderRunId, sendStartId, epoch) =>
				renewalReceipt(grantId, ATTEMPT_NONCE, sendStartId, epoch)],
			['missed', async () => new Promise(() => { /* no ACK */ })],
		];
		for (const [name, renewHolds] of cases) {
			const { holder } = setup(f, { maxUnrenewedStreamMs: 220, renewHolds });
			const response = await holder.run(f.request, new AbortController().signal);
			const reader = response.body!.getReader();
			assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
			await assert.rejects(reader.read(), name);
		}
		assert.equal(posts, cases.length);
	} finally { await target.close(); }
});

it('cancellation stops a renewable stream without another renewal or physical POST', async () => {
	let posts = 0;
	const target = await loopback(async (req, res) => {
		posts += 1;
		for await (const _chunk of req) { /* consume the bounded upload */ }
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.write('data: first\n\n');
	});
	try {
		const f = await fixture(target.base);
		const abort = new AbortController();
		let renewals = 0;
		const { holder } = setup(f, {
			maxUnrenewedStreamMs: 300,
			async renewHolds(grantId, holderRunId, sendStartId, expectedEpoch) {
				renewals += 1;
				return renewalReceipt(grantId, holderRunId, sendStartId, expectedEpoch);
			},
		});
		const response = await holder.run(f.request, abort.signal);
		const reader = response.body!.getReader();
		assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
		abort.abort();
		await assert.rejects(reader.read());
		await new Promise(resolve => setTimeout(resolve, 180));
		assert.equal(renewals, 0);
		assert.equal(posts, 1);
	} finally { await target.close(); }
});

it('direct body cancellation awaits real renewable HTTP cleanup without AbortError', async () => {
	let posts = 0;
	const closes: Promise<void>[] = [];
	const target = await loopback(async (req, res) => {
		posts += 1;
		for await (const _chunk of req) { /* consume the bounded upload */ }
		closes.push(new Promise(resolve => { res.once('close', resolve); }));
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.write('data: first\n\n');
	});
	try {
		const f = await fixture(target.base);
		let renewals = 0;
		for (const pendingRead of [false, true]) {
			const { holder } = setup(f, {
				maxUnrenewedStreamMs: 1000,
				async renewHolds(grantId, holderRunId, sendStartId, expectedEpoch) {
					renewals += 1;
					return renewalReceipt(grantId, holderRunId, sendStartId, expectedEpoch);
				},
			});
			const response = await holder.run(f.request, new AbortController().signal);
			if (pendingRead) {
				const reader = response.body!.getReader();
				await reader.read();
				const blocked = reader.read();
				await reader.cancel();
				assert.equal((await blocked).done, true);
				reader.releaseLock();
			} else await response.body!.cancel();
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([Promise.all(closes), new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('cancelled HTTP response stayed open')), 1500);
			})]);
		} finally { if (timer) clearTimeout(timer); }
		await new Promise(resolve => setTimeout(resolve, 550));
		assert.equal(renewals, 0);
		assert.equal(posts, 2);
	} finally { await target.close(); }
});

it('does not deliver buffered bytes after a local deadline missed during suspension', async () => {
	let posts = 0;
	const target = await loopback(async (req, res) => {
		posts += 1;
		for await (const _chunk of req) { /* consume the bounded upload */ }
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.write('data: first\n\n');
		setTimeout(() => res.write('data: too-late\n\n'), 180);
	});
	try {
		const f = await fixture(target.base);
		let renewals = 0;
		const { holder } = setup(f, {
			maxUnrenewedStreamMs: 300,
			async renewHolds(grantId, holderRunId, sendStartId, expectedEpoch) {
				renewals += 1;
				return renewalReceipt(grantId, holderRunId, sendStartId, expectedEpoch);
			},
		});
		const response = await holder.run(f.request, new AbortController().signal);
		const reader = response.body!.getReader();
		assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
		const resumeAt = performance.now() + 360;
		while (performance.now() < resumeAt) { /* simulate an event loop suspension */ }
		await assert.rejects(reader.read());
		assert.equal(renewals, 0);
		assert.equal(posts, 1);
	} finally { await target.close(); }
});

it('counts a delayed custody claim against the same hold guard', async () => {
	let posts = 0;
	const target = await loopback((_req, res) => { posts += 1; res.end('unexpected'); });
	try {
		const f = await fixture(target.base);
		const ordinary = setup(f);
		const { holder, events } = setup(f, {
			maxUnrenewedStreamMs: 50,
			async claimSendCustody(grantId, holderRunId) {
				await new Promise(resolve => setTimeout(resolve, 150));
				return ordinary.ports.claimSendCustody(grantId, holderRunId);
			},
		});
		await assert.rejects(holder.run(f.request, new AbortController().signal));
		assert.equal(events.includes('send-start'), false);
		assert.equal(posts, 0);
	} finally { await target.close(); }
});

it('does not claim custody after a delayed grant exhausts the hold guard', async () => {
	let posts = 0;
	const target = await loopback((_req, res) => { posts += 1; res.end('unexpected'); });
	try {
		const f = await fixture(target.base);
		const ordinary = setup(f);
		const { holder, events } = setup(f, {
			maxUnrenewedStreamMs: 50,
			async grantAttempt(nonce, claim) {
				await new Promise(resolve => setTimeout(resolve, 150));
				return ordinary.ports.grantAttempt(nonce, claim);
			},
		});
		await assert.rejects(holder.run(f.request, new AbortController().signal));
		assert.equal(events.includes('custody'), false);
		assert.equal(posts, 0);
	} finally { await target.close(); }
});

it('rejects wrong body, candidate, source, bearer and unknown grant/send-start ACK with zero POST', async () => {
	let posts = 0;
	const target = await loopback((_req, res) => { posts += 1; res.end('unexpected'); });
	try {
		const f = await fixture(target.base);
		const cases: Array<[string, ChatTextHolderRequestV363, Partial<PrivateCompleteTextHolderPortsV365>]> = [
			['body', { ...f.request, finalBodyUtf8: BODY.replace('hello', 'altered') }, {}],
			['candidate', { ...f.request, candidateIndex: 0 }, {}],
			['source', f.request, { grantAttempt: async (_nonce, claim) => ({
				...claim, status: 'committed', commitAcknowledged: true,
				grantId: GRANT_ID, attemptNumber: 1,
				manifestSourceGeneration: 7, currentSourceGeneration: 8,
				manifestAttestedSourceSha256: 'a'.repeat(64),
				currentAttestedSourceSha256: 'a'.repeat(64),
				manifestSourceSha256: 'b'.repeat(64),
				expiresAt: new Date(Date.now() + 30_000).toISOString(),
			}) }],
			['bearer', f.request, { providerEncryptionSecret: 'wrong-kek-for-private-holder-test-000000000000000' }],
			['grant lost COMMIT', f.request, { grantAttempt: async () => { throw new Error('COMMIT unknown'); } }],
			['grant lost close ACK', f.request, { grantAttempt: async (_nonce, claim) => ({
				...claim, status: 'committed', commitAcknowledged: false,
				grantId: GRANT_ID, attemptNumber: 1,
				manifestSourceGeneration: 7, currentSourceGeneration: 7,
				manifestAttestedSourceSha256: 'a'.repeat(64),
				currentAttestedSourceSha256: 'a'.repeat(64),
				manifestSourceSha256: 'b'.repeat(64),
				expiresAt: new Date(Date.now() + 30_000).toISOString(),
			}) }],
			['custody lost COMMIT', f.request, { claimSendCustody: async () => { throw new Error('COMMIT unknown'); } }],
			['custody lost close ACK', f.request, { claimSendCustody: async (grantId, holderRunId) => ({
				status: 'custody_claim_recorded', commitAcknowledged: false,
				grantId, holderRunId, leaseEpoch: 1,
				leaseUntil: new Date(Date.now() + 20_000).toISOString(),
			}) }],
			['send-start lost COMMIT', f.request, { recordSendStart: async () => { throw new Error('COMMIT unknown'); } }],
			['send-start exceeds custody', f.request, { recordSendStart: async (grantId, holderRunId, epoch, uploadSha256) => ({
				status: 'start_recorded', commitAcknowledged: true,
				sendStartId: START_ID, grantId, holderRunId,
				leaseEpoch: epoch, uploadSha256,
				expiresAt: new Date(Date.now() + 25_000).toISOString(),
			}) }],
			['send-start lost close ACK', f.request, { recordSendStart: async (grantId, holderRunId, epoch, uploadSha256) => ({
				status: 'start_recorded', commitAcknowledged: false,
				sendStartId: START_ID, grantId, holderRunId,
				leaseEpoch: epoch, uploadSha256,
				expiresAt: new Date(Date.now() + 20_000).toISOString(),
			}) }],
			['custody replay', f.request, { claimSendCustody: async () => ({ status: 'already_claimed_unknown' }) }],
			['send-start replay', f.request, { recordSendStart: async () => ({ status: 'already_possible_send' }) }],
		];
		for (const [name, request, changes] of cases) {
			const { holder } = setup(f, changes);
			await assert.rejects(holder.run(request, new AbortController().signal), name);
			assert.equal(posts, 0, name);
		}
	} finally { await target.close(); }
});

it('rejects pre-send cancellation and redirect without following to a second provider POST', async () => {
	let firstPosts = 0;
	let redirectedPosts = 0;
	const destination = await loopback((_req, res) => { redirectedPosts += 1; res.end('unexpected'); });
	const target = await loopback((_req, res) => {
		firstPosts += 1;
		res.writeHead(307, { Location: `${destination.base}/chat/completions` });
		res.end();
	});
	try {
		const f = await fixture(target.base);
		const abort = new AbortController();
		const { holder } = setup(f, {
			recordSendStart: async (grantId, holderRunId, epoch, uploadSha256) => {
				abort.abort();
				return { status: 'start_recorded', commitAcknowledged: true,
					sendStartId: START_ID, grantId, holderRunId,
					leaseEpoch: epoch, uploadSha256,
					expiresAt: new Date(Date.now() + 20_000).toISOString() };
			},
		});
		await assert.rejects(holder.run(f.request, abort.signal));
		assert.equal(firstPosts, 0);
		const retry = setup(f);
		await assert.rejects(retry.holder.run(f.request, new AbortController().signal));
		assert.equal(firstPosts, 1);
		assert.equal(redirectedPosts, 0);
	} finally { await target.close(); await destination.close(); }
});
