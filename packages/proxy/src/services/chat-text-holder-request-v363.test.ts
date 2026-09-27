import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import type { FinalChatQuoteInput } from './chat-final-quote-input';
import type { RouteResult } from './model-router';
import type { CompleteFlatTextQuoteV360 } from './postgres-complete-chat-quote-v360';
import { ChatTextHolderRequestRejectedError,
	createChatTextHolderRequestV363 } from './chat-text-holder-request-v363';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const finalBodyUtf8 = '{"messages":[{"content":"hello","role":"user"}],"model":"model-a","models":["model-a","model-b"]}';
const attemptNonce = '22222222-2222-4222-8222-222222222222';

function fixture(body = finalBodyUtf8) {
	const modelIds = Object.freeze(['model-a', 'model-b']);
	const quote: CompleteFlatTextQuoteV360 = Object.freeze({
		quoteId: '11111111-1111-4111-8111-111111111111',
		requestId: 'request-holder', finalBodySha256: sha(body), modelIds,
		routeCount: 2, credentialClass: 'platform',
		maxPerAttemptCeilingMicros: 30_001,
		threeAttemptCeilingMicros: 90_003,
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
	});
	const finalQuoteInput: FinalChatQuoteInput = Object.freeze({
		requestId: quote.requestId, originalBodySha256: 'a'.repeat(64),
		finalBodyUtf8: body, finalBodySha256: sha(body), modelIds,
		assertCurrent() {},
	});
	const selectedRoute = {
		targetId: 'route-b', gatewayCandidateIndex: 1,
		gatewayModelId: 'model-b', providerId: 'provider-b',
		providerApiKey: 'PLAIN_PROVIDER_SECRET_SHOULD_NEVER_CROSS',
		providerEndpoints: { openai: { base: 'https://secret-host.invalid/v1' } },
		providerKeyLabel: 'SECRET_LABEL_SHOULD_NEVER_CROSS',
	} as RouteResult;
	return { quote, finalQuoteInput, selectedRoute, attemptNonce };
}

it('serializes only the quoted body and selection IDs, even when the route contains plaintext', () => {
	const input = fixture();
	const request = createChatTextHolderRequestV363(input);
	assert.deepEqual(Object.keys(request), [
		'requestId', 'quoteId', 'attemptNonce', 'candidateIndex',
		'routeTargetId', 'finalBodyUtf8',
	]);
	assert.equal(request.finalBodyUtf8, finalBodyUtf8);
	assert.equal(request.candidateIndex, 1);
	assert.equal(Object.isFrozen(request), true);
	const serialized = JSON.stringify(request);
	for (const forbidden of [input.selectedRoute.providerApiKey,
		'secret-host.invalid', 'SECRET_LABEL_SHOULD_NEVER_CROSS',
		'providerApiKey', 'providerEndpoints', 'upstreamUrlSha256',
		'outboundBodySha256', 'providerCiphertextSha256']) {
		assert.equal(serialized.includes(forbidden), false, forbidden);
	}
});

it('rejects stale, malformed, and mutated quote or final-body identity', () => {
	const base = fixture();
	const invalid = [
		{ ...base, quote: { ...base.quote, expiresAt: new Date(Date.now() - 1_000).toISOString() } },
		{ ...base, quote: { ...base.quote, quoteId: 'not-a-uuid' } },
		{ ...base, quote: { ...base.quote, requestId: 'other-request' } },
		{ ...base, quote: { ...base.quote, modelIds: ['model-a', 'other-model'] } },
		{ ...base, quote: { ...base.quote, modelIds: ['model-a', 'model-a'] } },
		{ ...base, finalQuoteInput: { ...base.finalQuoteInput,
			finalBodyUtf8: base.finalQuoteInput.finalBodyUtf8.replace('hello', 'changed') } },
		fixture('not-json'),
		{ ...base, finalQuoteInput: { ...base.finalQuoteInput,
			finalBodySha256: '0'.repeat(64) } },
		{ ...base, attemptNonce: 'not-a-uuid' },
		{ ...base, selectedRoute: { ...base.selectedRoute, gatewayCandidateIndex: 9 } },
		{ ...base, selectedRoute: { ...base.selectedRoute, gatewayModelId: 'model-a' } },
		{ ...base, selectedRoute: { ...base.selectedRoute, targetId: '' } },
	] as const;
	for (const value of invalid) {
		assert.throws(() => createChatTextHolderRequestV363(value),
			ChatTextHolderRequestRejectedError);
	}
});

it('rejects an oversized exact UTF-8 final body before it can cross the holder boundary', () => {
	const oversized = JSON.stringify({
		model: 'model-a', models: ['model-a', 'model-b'],
		messages: [{ role: 'user', content: 'x'.repeat(1_048_576) }],
	});
	assert.ok(new TextEncoder().encode(oversized).byteLength > 1_048_576);
	assert.throws(() => createChatTextHolderRequestV363(fixture(oversized)),
		ChatTextHolderRequestRejectedError);
});
