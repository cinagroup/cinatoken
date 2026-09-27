import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import type { RouteResult } from './model-router';
import type { FinalChatQuoteInput } from './chat-final-quote-input';
import type { CompleteFlatTextQuoteV360 } from './postgres-complete-chat-quote-v360';
import type { PreparedTextAttempt } from './egress/prepared-text-attempt';
import { dispatchOpenAiRoute } from './egress/openai-driver';
import { assertFlatTextWireBodyMatchesQuoteV362,
	ChatFlatTextWireProofError } from './chat-flat-text-wire-proof-v362';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const finalBodyUtf8 = '{"max_completion_tokens":300,"messages":[{"content":"hello","role":"user"}],"model":"model-a","models":["model-a","model-b"],"stream":true}';
const quote: CompleteFlatTextQuoteV360 = Object.freeze({
	quoteId: '11111111-1111-1111-1111-111111111111',
	requestId: 'request-wire-proof', finalBodySha256: sha(finalBodyUtf8),
	modelIds: Object.freeze(['model-a', 'model-b']), routeCount: 2,
	credentialClass: 'platform', maxPerAttemptCeilingMicros: 30_001,
	threeAttemptCeilingMicros: 90_003,
	expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
const input: FinalChatQuoteInput = Object.freeze({
	requestId: quote.requestId, originalBodySha256: 'a'.repeat(64),
	finalBodyUtf8, finalBodySha256: quote.finalBodySha256,
	modelIds: quote.modelIds, assertCurrent() {},
});
const route = {
	targetId: 'route-b', providerId: 'provider-b', providerKeyId: 'provider-b',
	providerModelName: 'private-b', gatewayCandidateIndex: 1,
	gatewayModelId: 'model-b', upstreamProtocol: 'openai',
	upstreamOperation: 'chat', adapter: 'passthrough',
	providerEndpoints: { openai: { base: 'https://example.test/v1' } },
	providerApiKey: 'test-upstream-secret', customParams: null,
	endpoint: { id: 'endpoint-b' },
} as RouteResult;

async function driverPrepared(body: Record<string, unknown>): Promise<PreparedTextAttempt> {
	const stop = new Error('stop before fetch');
	let prepared: PreparedTextAttempt | undefined;
	await assert.rejects(dispatchOpenAiRoute(route, body, undefined, null, undefined,
		async value => { prepared = value; throw stop; }), error => error === stop);
	assert.ok(prepared, 'the real OpenAI driver prepared the frozen upload before fetch');
	return prepared;
}

it('matches the real driver snapshot after fallback model replacement and stream usage injection', async () => {
	const prepared = await driverPrepared({
		model: 'model-b', stream: true, max_completion_tokens: 300,
		messages: [{ role: 'user', content: 'hello' }],
	});
	assert.match(prepared.outboundBodyCanonicalSha256 ?? '', /^[0-9a-f]{64}$/u);
	assert.notEqual(prepared.outboundBodySha256, quote.finalBodySha256);
	await assertFlatTextWireBodyMatchesQuoteV362({ input, quote, route, prepared });
});

it('rejects a real driver upload with altered message content before a grant claim', async () => {
	const prepared = await driverPrepared({
		model: 'model-b', stream: true, max_completion_tokens: 300,
		messages: [{ role: 'user', content: 'altered' }],
	});
	await assert.rejects(
		assertFlatTextWireBodyMatchesQuoteV362({ input, quote, route, prepared }),
		ChatFlatTextWireProofError,
	);
});

it('rejects forged length and URL fields even with the expected semantic digest', async () => {
	const real = await driverPrepared({
		model: 'model-b', stream: true, max_completion_tokens: 300,
		messages: [{ role: 'user', content: 'hello' }],
	});
	const forgeries: Array<[string, PreparedTextAttempt]> = [
		['byte length', Object.freeze({ ...real, outboundBodyBytes: real.outboundBodyBytes + 1 })],
		['URL', Object.freeze({ ...real, upstreamUrlSha256: '0'.repeat(64) })],
	];
	for (const [name, prepared] of forgeries) {
		await assert.rejects(
			assertFlatTextWireBodyMatchesQuoteV362({ input, quote, route, prepared }),
			ChatFlatTextWireProofError,
			name,
		);
	}
});

it('shows why an independent holder must verify raw upload bytes', async () => {
	const real = await driverPrepared({
		model: 'model-b', stream: true, max_completion_tokens: 300,
		messages: [{ role: 'user', content: 'hello' }],
	});
	const forged = Object.freeze({ ...real, outboundBodySha256: '0'.repeat(64) });
	assert.notEqual(forged.outboundBodySha256, real.outboundBodySha256);
	await assertFlatTextWireBodyMatchesQuoteV362({ input, quote, route, prepared: forged });
});
