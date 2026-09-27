import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import type { RouteResult } from './model-router';
import type { CompleteFlatTextQuoteV360 } from './postgres-complete-chat-quote-v360';
import type { FinalChatQuoteInput } from './chat-final-quote-input';
import {
	createPreparedTextAttempt,
	captureTextRouteIdentity,
	type PreparedTextAttempt,
} from './egress/prepared-text-attempt';
import {
	createReviewOnlyTextGrantGateV361,
	type CommittedTextGrantReceiptV361,
	type TextGrantClaimRequestV361,
} from './chat-text-grant-egress-contract-v361';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const now = Date.parse('2026-09-25T12:00:00.000Z');
const finalBodyUtf8 = '{"messages":[],"model":"model-a","models":["model-a","model-b"]}';
const quote: CompleteFlatTextQuoteV360 = Object.freeze({
	quoteId: '11111111-1111-1111-1111-111111111111',
	requestId: 'request-1',
	finalBodySha256: sha(finalBodyUtf8),
	modelIds: Object.freeze(['model-a', 'model-b']),
	routeCount: 3,
	credentialClass: 'platform',
	maxPerAttemptCeilingMicros: 30_001,
	threeAttemptCeilingMicros: 90_003,
	expiresAt: new Date(now + 60_000).toISOString(),
});
const finalQuoteInput: FinalChatQuoteInput = Object.freeze({
	requestId: quote.requestId, originalBodySha256: 'a'.repeat(64),
	finalBodyUtf8, finalBodySha256: quote.finalBodySha256,
	modelIds: quote.modelIds, assertCurrent() {},
});

function route(): RouteResult {
	return {
		targetId: 'route-b',
		providerId: 'provider-b',
		providerModelName: 'private-b',
		gatewayCandidateIndex: 1,
		gatewayModelId: 'model-b',
		upstreamProtocol: 'openai',
		upstreamOperation: 'chat',
		adapter: 'passthrough',
		providerEndpoints: { openai: { base: 'https://example.test/v1' } },
		providerApiKey: 'enc:v2:provider-secret-ciphertext',
		providerSharedChannelType: null,
		providerKeyId: 'provider-b',
		priceOverrideRaw: null,
		customParams: null,
		endpoint: { id: 'endpoint-b' },
	} as RouteResult;
}

function prepared(selected: RouteResult): PreparedTextAttempt {
	return createPreparedTextAttempt({
		routeIdentity: captureTextRouteIdentity(selected),
		url: 'https://example.test/v1/chat/completions',
		method: 'POST',
		headers: { Authorization: 'Bearer actual-plain-secret' },
		outboundBodySha256: sha('{"model":"private-b","messages":[]}'),
		outboundBodyCanonicalSha256: sha('{"messages":[],"model":"private-b"}'),
		outboundBodyBytes: Buffer.byteLength('{"model":"private-b","messages":[]}'),
	});
}

function receipt(claim: TextGrantClaimRequestV361): CommittedTextGrantReceiptV361 {
	return {
		...claim,
		status: 'committed',
		commitAcknowledged: true,
		grantId: '22222222-2222-2222-2222-222222222222',
		attemptNumber: 1,
		manifestSourceGeneration: 7,
		currentSourceGeneration: 7,
		manifestAttestedSourceSha256: 'a'.repeat(64),
		currentAttestedSourceSha256: 'a'.repeat(64),
		manifestSourceSha256: 'b'.repeat(64),
		expiresAt: new Date(now + 30_000).toISOString(),
	};
}

it('sends only after an acknowledged grant echoes quote, candidate, manifest and physical wire facts', async () => {
	const selected = route();
	const wire = prepared(selected);
	const events: string[] = [];
	const gate = createReviewOnlyTextGrantGateV361({
		quote, finalQuoteInput,
		nowMs: () => now,
		claim: async candidate => {
			events.push('claim');
			assert.equal(candidate.requestId, quote.requestId);
			assert.equal(candidate.quoteId, quote.quoteId);
			assert.equal(candidate.candidateIndex, 1);
			assert.equal(candidate.modelId, 'model-b');
			assert.equal(candidate.routeTargetId, 'route-b');
			assert.equal(candidate.providerId, 'provider-b');
			assert.equal(candidate.endpointId, 'endpoint-b');
			assert.equal(candidate.credentialId, 'provider-b');
			assert.equal(candidate.providerCiphertextSha256, sha(selected.providerApiKey));
			assert.equal(candidate.method, 'POST');
			assert.equal(candidate.upstreamUrlSha256, wire.upstreamUrlSha256);
			assert.equal(candidate.outboundBodySha256, wire.outboundBodySha256);
			assert.equal(candidate.outboundBodyCanonicalSha256, wire.outboundBodyCanonicalSha256);
			assert.equal(candidate.credentialFingerprintSha256, wire.credentialFingerprintSha256);
			assert.notEqual(candidate.outboundBodySha256, candidate.finalBodySha256);
			return receipt(candidate);
		},
	});
	const value = await gate.run(selected, wire, async proof => {
		events.push('send');
		assert.equal(Object.isFrozen(proof), true);
		return proof.grantId;
	});
	assert.equal(value, '22222222-2222-2222-2222-222222222222');
	assert.deepEqual(events, ['claim', 'send']);
	await assert.rejects(gate.run(selected, wire, async () => { events.push('second send'); }));
	assert.deepEqual(events, ['claim', 'send']);
});

it('rejects every changed identity, stale source, unconfirmed ACK, expiry and grant number before send', async () => {
	const mutationCases: Array<[string, (claim: TextGrantClaimRequestV361) => unknown]> = [
		['unknown ACK', claim => ({ ...receipt(claim), commitAcknowledged: false })],
		['missing ACK', claim => ({ ...receipt(claim), commitAcknowledged: undefined })],
		['request', claim => ({ ...receipt(claim), requestId: 'other-request' })],
		['quote', claim => ({ ...receipt(claim), quoteId: '33333333-3333-3333-3333-333333333333' })],
		['candidate', claim => ({ ...receipt(claim), candidateIndex: 0 })],
		['target', claim => ({ ...receipt(claim), routeTargetId: 'route-a' })],
		['provider', claim => ({ ...receipt(claim), providerId: 'provider-a' })],
		['endpoint', claim => ({ ...receipt(claim), endpointId: 'endpoint-a' })],
		['credential class', claim => ({ ...receipt(claim), credentialClass: 'byok' })],
		['credential id', claim => ({ ...receipt(claim), credentialId: 'other' })],
		['ciphertext', claim => ({ ...receipt(claim), providerCiphertextSha256: '0'.repeat(64) })],
		['route snapshot', claim => ({ ...receipt(claim), preparedRouteSourceSha256: '0'.repeat(64) })],
		['URL', claim => ({ ...receipt(claim), upstreamUrlSha256: '0'.repeat(64) })],
		['body', claim => ({ ...receipt(claim), outboundBodySha256: '0'.repeat(64) })],
		['semantic body', claim => ({ ...receipt(claim), outboundBodyCanonicalSha256: '0'.repeat(64) })],
		['body length', claim => ({ ...receipt(claim), outboundBodyBytes: claim.outboundBodyBytes + 1 })],
		['plain secret fingerprint', claim => ({ ...receipt(claim), credentialFingerprintSha256: '0'.repeat(64) })],
		['source generation', claim => ({ ...receipt(claim), currentSourceGeneration: 8 })],
		['source attestation', claim => ({ ...receipt(claim), currentAttestedSourceSha256: '0'.repeat(64) })],
		['first grant beyond three', claim => ({ ...receipt(claim), attemptNumber: 4 })],
		['expired grant', claim => ({ ...receipt(claim), expiresAt: new Date(now - 1).toISOString() })],
		['grant outlives quote', claim => ({ ...receipt(claim), expiresAt: new Date(now + 61_000).toISOString() })],
	];
	for (const [name, mutate] of mutationCases) {
		const selected = route();
		let sends = 0;
		const gate = createReviewOnlyTextGrantGateV361({ quote, finalQuoteInput, nowMs: () => now,
			claim: async claim => mutate(claim) });
		await assert.rejects(gate.run(selected, prepared(selected), async () => { sends += 1; }), name);
		assert.equal(sends, 0, name);
	}
});

it('unknown COMMIT or close outcome and concurrent reentry cannot create a physical send', async () => {
	const selected = route();
	let rejectClaim!: (reason: unknown) => void;
	const pending = new Promise<unknown>((_resolve, reject) => { rejectClaim = reject; });
	let enteredClaim!: () => void;
	const claimEntered = new Promise<void>(resolve => { enteredClaim = resolve; });
	let claimCalls = 0;
	let sends = 0;
	const gate = createReviewOnlyTextGrantGateV361({ quote, finalQuoteInput, nowMs: () => now,
		claim: () => { claimCalls += 1; enteredClaim(); return pending; } });
	const first = gate.run(selected, prepared(selected), async () => { sends += 1; });
	await claimEntered;
	await assert.rejects(gate.run(selected, prepared(selected), async () => { sends += 1; }));
	rejectClaim(new Error('COMMIT outcome or LOGIN cleanup unknown'));
	await assert.rejects(first);
	await assert.rejects(gate.run(selected, prepared(selected), async () => { sends += 1; }));
	assert.equal(claimCalls, 1);
	assert.equal(sends, 0);
});

it('rejects a mutated route, non-platform route, unknown candidate, stale prepared identity and abort', async () => {
	const cases: Array<[string, (route: RouteResult) => void]> = [
		['candidate', selected => { selected.gatewayCandidateIndex = 9; }],
		['model', selected => { selected.gatewayModelId = 'model-a'; }],
		['BYOK', selected => { selected.gatewayPrivateByokFallback = true; }],
		['shared key', selected => { selected.providerSharedChannelType = 'openai'; }],
		['provider key', selected => { selected.providerKeyId = 'key-a'; }],
		['runtime-decrypted platform key', selected => { selected.providerApiKey = 'actual-plain-secret'; }],
		['protocol', selected => { selected.upstreamProtocol = 'anthropic'; }],
		['credential rotation', selected => { selected.providerApiKey = 'enc:v2:rotated'; }],
		['URL revision', selected => { selected.providerEndpoints = { openai: { base: 'https://other.test/v1' } }; }],
	];
	for (const [name, mutate] of cases) {
		const selected = route();
		const wire = prepared(selected);
		mutate(selected);
		let claims = 0;
		let sends = 0;
		const gate = createReviewOnlyTextGrantGateV361({ quote, finalQuoteInput, nowMs: () => now,
			claim: async claim => { claims += 1; return receipt(claim); } });
		await assert.rejects(gate.run(selected, wire, async () => { sends += 1; }), name);
		assert.equal(claims, 0, name);
		assert.equal(sends, 0, name);
	}
	const selected = route();
	const abort = new AbortController();
	let sends = 0;
	const gate = createReviewOnlyTextGrantGateV361({ quote, finalQuoteInput, nowMs: () => now,
		signal: abort.signal,
		claim: async claim => { abort.abort(); return receipt(claim); } });
	await assert.rejects(gate.run(selected, prepared(selected), async () => { sends += 1; }));
	assert.equal(sends, 0);
});

it('counterexample: a same-Worker echo cannot prove the bearer belongs to the quoted ciphertext', async () => {
	const selected = route();
	const wrongSecret = createPreparedTextAttempt({
		routeIdentity: captureTextRouteIdentity(selected),
		url: 'https://example.test/v1/chat/completions',
		method: 'POST',
		headers: { Authorization: 'Bearer unrelated-plaintext-secret' },
		outboundBodySha256: sha('{"model":"private-b","messages":[]}'),
		outboundBodyCanonicalSha256: sha('{"messages":[],"model":"private-b"}'),
		outboundBodyBytes: Buffer.byteLength('{"model":"private-b","messages":[]}'),
	});
	assert.notEqual(wrongSecret.credentialBindings[0]?.sha256, sha('actual-plain-secret'));
	let localSendCalls = 0;
	const gate = createReviewOnlyTextGrantGateV361({ quote, finalQuoteInput, nowMs: () => now,
		claim: async claim => receipt(claim) });
	await gate.run(selected, wrongSecret, async () => {
		// This local success is deliberately a counterexample, not authorization.
		localSendCalls += 1;
	});
	assert.equal(localSendCalls, 1);
});
