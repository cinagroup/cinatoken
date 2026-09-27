import { createHash } from 'node:crypto';
import type { FinalChatQuoteSnapshot } from './chat-final-quote-input';
import type { RouteResult } from './model-router';
import type { CompleteFlatTextQuoteV360 } from './postgres-complete-chat-quote-v360';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_FINAL_BODY_BYTES = 1_048_576;

/** Only identifiers and the exact quoted public body cross to a future holder. */
export type ChatTextHolderRequestV363 = Readonly<{
	requestId: string;
	quoteId: string;
	attemptNonce: string;
	candidateIndex: number;
	routeTargetId: string;
	finalBodyUtf8: string;
}>;

export class ChatTextHolderRequestRejectedError extends Error {
	constructor() {
		super('Complete Chat holder request does not match the quoted candidate');
		this.name = 'ChatTextHolderRequestRejectedError';
	}
}

/**
 * Review-only local envelope. It carries no credential, URL, provider DTO, or
 * authoritative wire digest. The independent holder must load the committed
 * quote/route itself and create the v362 claim from its own frozen upload.
 */
export function createChatTextHolderRequestV363(params: {
	quote: CompleteFlatTextQuoteV360;
	finalQuoteInput: FinalChatQuoteSnapshot;
	selectedRoute: Pick<RouteResult, 'targetId' | 'gatewayCandidateIndex' | 'gatewayModelId'>;
	attemptNonce: string;
}): ChatTextHolderRequestV363 {
	const { quote, finalQuoteInput: input, selectedRoute: route, attemptNonce } = params;
	const index = route.gatewayCandidateIndex;
	if (typeof quote.requestId !== 'string' || quote.requestId.length < 1
		|| quote.requestId.length > 128
		|| typeof quote.quoteId !== 'string' || !UUID.test(quote.quoteId)
		|| typeof attemptNonce !== 'string' || !UUID.test(attemptNonce)
		|| quote.credentialClass !== 'platform'
		|| !Array.isArray(quote.modelIds) || quote.modelIds.length < 1
		|| quote.modelIds.length > 8
		|| quote.modelIds.some(model => typeof model !== 'string'
			|| model.length < 1 || model.length > 240 || model.trim() !== model)
		|| new Set(quote.modelIds).size !== quote.modelIds.length
		|| typeof quote.expiresAt !== 'string'
		|| !Number.isFinite(Date.parse(quote.expiresAt))
		|| Date.parse(quote.expiresAt) <= Date.now()
		|| input.requestId !== quote.requestId
		|| typeof input.finalBodyUtf8 !== 'string'
		|| input.finalBodyUtf8.length > MAX_FINAL_BODY_BYTES
		|| typeof input.finalBodySha256 !== 'string'
		|| !SHA256.test(input.finalBodySha256)
		|| input.finalBodySha256 !== quote.finalBodySha256
		|| !Array.isArray(input.modelIds)
		|| input.modelIds.length !== quote.modelIds.length
		|| input.modelIds.some((model, i) => model !== quote.modelIds[i])
		|| !Number.isSafeInteger(index) || index! < 0
		|| index! >= quote.modelIds.length
		|| route.gatewayModelId !== quote.modelIds[index!]
		|| typeof route.targetId !== 'string'
		|| route.targetId.length < 1 || route.targetId.length > 512) {
		throw new ChatTextHolderRequestRejectedError();
	}
	const bodyBytes = new TextEncoder().encode(input.finalBodyUtf8);
	if (bodyBytes.byteLength < 2 || bodyBytes.byteLength > MAX_FINAL_BODY_BYTES
		|| createHash('sha256').update(bodyBytes).digest('hex') !== quote.finalBodySha256) {
		throw new ChatTextHolderRequestRejectedError();
	}
	let body: unknown;
	try { body = JSON.parse(input.finalBodyUtf8) as unknown; }
	catch { throw new ChatTextHolderRequestRejectedError(); }
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw new ChatTextHolderRequestRejectedError();
	}
	const parsed = body as Record<string, unknown>;
	if (parsed.model !== quote.modelIds[0]
		|| !Array.isArray(parsed.models)
		|| parsed.models.length !== quote.modelIds.length
		|| parsed.models.some((model, i) => model !== quote.modelIds[i])) {
		throw new ChatTextHolderRequestRejectedError();
	}
	return Object.freeze({
		requestId: quote.requestId,
		quoteId: quote.quoteId,
		attemptNonce,
		candidateIndex: index!,
		routeTargetId: route.targetId,
		finalBodyUtf8: input.finalBodyUtf8,
	});
}
