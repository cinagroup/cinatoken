import { createHash } from 'node:crypto';
import { applyVertexOpenAiModelPrefix, resolveUpstreamEndpoint } from '@octafuse/core';
import type { FinalChatQuoteInput } from './chat-final-quote-input';
import { canonicalChatJsonSha256 } from './chat-final-quote-input';
import type { CompleteFlatTextQuoteV360 } from './postgres-complete-chat-quote-v360';
import type { RouteResult } from './model-router';
import type { PreparedTextAttempt } from './egress/prepared-text-attempt';
import { buildRouteRequestBody } from './route-default-params';
import { ensureOpenAiStreamIncludesUsage } from './egress/openai-stream-usage-request';
import { assertTextUpstreamHttpUrl } from './egress/text-upstream-url';
import { createJsonUploadBody } from './egress/json-upload-body';

const BODY_FIELDS = new Set([
	'model', 'models', 'messages', 'max_tokens', 'max_completion_tokens',
	'stream', 'temperature', 'top_p', 'presence_penalty', 'frequency_penalty',
	'seed', 'stop', 'user',
]);
const SHA256 = /^[0-9a-f]{64}$/u;

export class ChatFlatTextWireProofError extends Error {
	constructor() {
		super('Prepared Chat body differs from the committed flat-text quote');
		this.name = 'ChatFlatTextWireProofError';
	}
}

/**
 * Verify the local OpenAI driver's public-body -> frozen-upload transformation
 * for the v360 strict subset. This is a same-Worker consistency proof. A future
 * independent holder must recompute it from quote bytes and its own upload.
 */
export async function assertFlatTextWireBodyMatchesQuoteV362(params: {
	input: FinalChatQuoteInput;
	quote: CompleteFlatTextQuoteV360;
	route: RouteResult;
	prepared: PreparedTextAttempt;
}): Promise<void> {
	const { input, quote, route, prepared } = params;
	const index = route.gatewayCandidateIndex;
	if (input.requestId !== quote.requestId
		|| input.finalBodySha256 !== quote.finalBodySha256
		|| createHash('sha256').update(input.finalBodyUtf8).digest('hex') !== quote.finalBodySha256
		|| input.modelIds.length !== quote.modelIds.length
		|| input.modelIds.some((model, i) => model !== quote.modelIds[i])
		|| !Number.isSafeInteger(index) || index! < 0 || index! >= quote.modelIds.length
		|| route.gatewayModelId !== quote.modelIds[index!]
		|| route.upstreamProtocol !== 'openai' || route.upstreamOperation !== 'chat'
		|| route.adapter !== 'passthrough' || route.customParams !== null
		|| typeof prepared.outboundBodyCanonicalSha256 !== 'string'
		|| !SHA256.test(prepared.outboundBodyCanonicalSha256)) {
		throw new ChatFlatTextWireProofError();
	}
	let body: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(input.finalBodyUtf8);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('not an object');
		}
		body = parsed as Record<string, unknown>;
	} catch { throw new ChatFlatTextWireProofError(); }
	if (Object.keys(body).some(key => !BODY_FIELDS.has(key))
		|| body.model !== quote.modelIds[0]
		|| !Array.isArray(body.models)
		|| body.models.length !== quote.modelIds.length
		|| body.models.some((model, i) => model !== quote.modelIds[i])) {
		throw new ChatFlatTextWireProofError();
	}
	try {
		const url = resolveUpstreamEndpoint('openai', 'chat', route.providerEndpoints, {
			providerId: route.providerId,
		});
		assertTextUpstreamHttpUrl(url);
		const upstreamBody = { ...body };
		delete upstreamBody.models;
		const expected = ensureOpenAiStreamIncludesUsage({
			...buildRouteRequestBody(route, upstreamBody),
			model: applyVertexOpenAiModelPrefix(url, route.providerModelName),
		});
		if (await canonicalChatJsonSha256(expected)
			!== prepared.outboundBodyCanonicalSha256) {
			throw new ChatFlatTextWireProofError();
		}
		if (createHash('sha256').update(url).digest('hex') !== prepared.upstreamUrlSha256) {
			throw new ChatFlatTextWireProofError();
		}
		const expectedUpload = createJsonUploadBody(expected, new AbortController().signal, () => {});
		try {
			// Canonical final bytes lose the caller's object insertion order. The
			// real driver's raw hash is tied to its own frozen snapshot, but a
			// separate holder must hash its own upload before physical send.
			if (expectedUpload.contentLength !== prepared.outboundBodyBytes) {
				throw new ChatFlatTextWireProofError();
			}
		} finally { expectedUpload.dispose(); }
	} catch (error) {
		if (error instanceof ChatFlatTextWireProofError) throw error;
		throw new ChatFlatTextWireProofError();
	}
}
