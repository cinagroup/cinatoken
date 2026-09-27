import { createHash } from 'node:crypto';
import type { RouteResult } from './model-router';
import type { CompleteFlatTextQuoteV360 } from './postgres-complete-chat-quote-v360';
import type { FinalChatQuoteInput } from './chat-final-quote-input';
import { assertFlatTextWireBodyMatchesQuoteV362 } from './chat-flat-text-wire-proof-v362';
import {
	preparedTextAttemptMatchesRoute,
	type PreparedTextAttempt,
} from './egress/prepared-text-attempt';

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

/**
 * Review-only shape for a future broker call. The broker must derive the
 * manifest, current source revision, reservation, and amount in PostgreSQL.
 * Echoing these Worker fields without that transaction is not authorization.
 */
export type TextGrantClaimRequestV361 = Readonly<{
	requestId: string;
	quoteId: string;
	finalBodySha256: string;
	candidateIndex: number;
	modelId: string;
	routeTargetId: string;
	providerId: string;
	endpointId: string;
	credentialClass: 'platform';
	credentialId: string;
	providerCiphertextSha256: string;
	preparedRouteSourceSha256: string;
	method: 'POST';
	upstreamUrlSha256: string;
	outboundBodySha256: string;
	outboundBodyCanonicalSha256: string;
	outboundBodyBytes: number;
	credentialFingerprintSha256: string;
}>;

/**
 * A broker response can be accepted only after its transaction COMMIT and
 * connection close have both been acknowledged. The broker must produce the
 * two source revisions itself while locking the manifest and live source.
 */
export type CommittedTextGrantReceiptV361 = TextGrantClaimRequestV361 & Readonly<{
	status: 'committed';
	commitAcknowledged: true;
	grantId: string;
	attemptNumber: number;
	manifestSourceGeneration: number;
	currentSourceGeneration: number;
	manifestAttestedSourceSha256: string;
	currentAttestedSourceSha256: string;
	manifestSourceSha256: string;
	expiresAt: string;
}>;

export class TextGrantEgressRejectedError extends Error {
	constructor() {
		super('Text grant was not confirmed for the prepared physical attempt');
		this.name = 'TextGrantEgressRejectedError';
	}
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function prepareClaim(
	quote: CompleteFlatTextQuoteV360,
	route: RouteResult,
	prepared: unknown,
	nowMs: number,
): TextGrantClaimRequestV361 {
	const index = route.gatewayCandidateIndex;
	if (!Number.isSafeInteger(nowMs) || Date.parse(quote.expiresAt) <= nowMs
		|| !preparedTextAttemptMatchesRoute(prepared, route)
		|| !Number.isSafeInteger(index) || index! < 0 || index! >= quote.modelIds.length
		|| route.gatewayModelId !== quote.modelIds[index!]
		|| route.providerSharedChannelType !== null
		|| route.gatewayPrivateByokFallback === true
		|| route.providerKeyId !== route.providerId
		|| route.upstreamProtocol !== 'openai' || route.upstreamOperation !== 'chat'
		|| route.adapter !== 'passthrough'
		|| route.priceOverrideRaw !== null || route.customParams !== null
		|| !route.endpoint?.id
		|| !route.providerApiKey.startsWith('enc:v2:')
		|| prepared.credentialBindings.length !== 1
		|| typeof prepared.outboundBodyCanonicalSha256 !== 'string'
		|| !SHA256.test(prepared.outboundBodyCanonicalSha256)
		|| prepared.credentialBindings[0]?.location !== 'authorization-bearer') {
		throw new TextGrantEgressRejectedError();
	}
	return Object.freeze({
		requestId: quote.requestId,
		quoteId: quote.quoteId,
		finalBodySha256: quote.finalBodySha256,
		candidateIndex: index!,
		modelId: quote.modelIds[index!]!,
		routeTargetId: route.targetId,
		providerId: route.providerId,
		endpointId: route.endpoint.id,
		credentialClass: 'platform' as const,
		credentialId: route.providerId,
		providerCiphertextSha256: sha256(route.providerApiKey),
		preparedRouteSourceSha256: prepared.routeIdentity.routeSourceSha256,
		method: prepared.method,
		upstreamUrlSha256: prepared.upstreamUrlSha256,
		outboundBodySha256: prepared.outboundBodySha256,
		outboundBodyCanonicalSha256: prepared.outboundBodyCanonicalSha256,
		outboundBodyBytes: prepared.outboundBodyBytes,
		credentialFingerprintSha256: prepared.credentialFingerprintSha256,
	});
}

function checkedReceipt(
	value: unknown,
	claim: TextGrantClaimRequestV361,
	quote: CompleteFlatTextQuoteV360,
	nowMs: number,
): CommittedTextGrantReceiptV361 {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TextGrantEgressRejectedError();
	}
	const receipt = value as Partial<CommittedTextGrantReceiptV361>;
	for (const key of Object.keys(claim) as Array<keyof TextGrantClaimRequestV361>) {
		if (receipt[key] !== claim[key]) throw new TextGrantEgressRejectedError();
	}
	if (receipt.status !== 'committed' || receipt.commitAcknowledged !== true
		|| typeof receipt.grantId !== 'string' || !UUID.test(receipt.grantId)
		|| !Number.isSafeInteger(receipt.attemptNumber)
		|| (receipt.attemptNumber ?? 0) < 1 || (receipt.attemptNumber ?? 4) > 3
		|| !Number.isSafeInteger(receipt.manifestSourceGeneration)
		|| (receipt.manifestSourceGeneration ?? 0) < 1
		|| receipt.currentSourceGeneration !== receipt.manifestSourceGeneration
		|| typeof receipt.manifestAttestedSourceSha256 !== 'string'
		|| !SHA256.test(receipt.manifestAttestedSourceSha256)
		|| receipt.currentAttestedSourceSha256 !== receipt.manifestAttestedSourceSha256
		|| typeof receipt.manifestSourceSha256 !== 'string'
		|| !SHA256.test(receipt.manifestSourceSha256)
		|| typeof receipt.expiresAt !== 'string'
		|| !Number.isFinite(Date.parse(receipt.expiresAt))
		|| Date.parse(receipt.expiresAt) <= nowMs
		|| Date.parse(receipt.expiresAt) > Date.parse(quote.expiresAt)) {
		throw new TextGrantEgressRejectedError();
	}
	return Object.freeze({ ...claim,
		status: 'committed' as const,
		commitAcknowledged: true as const,
		grantId: receipt.grantId,
		attemptNumber: receipt.attemptNumber!,
		manifestSourceGeneration: receipt.manifestSourceGeneration!,
		currentSourceGeneration: receipt.currentSourceGeneration!,
		manifestAttestedSourceSha256: receipt.manifestAttestedSourceSha256,
		currentAttestedSourceSha256: receipt.currentAttestedSourceSha256!,
		manifestSourceSha256: receipt.manifestSourceSha256,
		expiresAt: receipt.expiresAt,
	});
}

/**
 * An unused local composition boundary. The one-shot latch is entered before
 * the broker await; an unknown COMMIT/close ACK, denial, or malformed receipt
 * leaves it closed. The physical sender still needs independent control of
 * the actual secret and must validate the wire identity before its own fetch.
 */
export function createReviewOnlyTextGrantGateV361(params: {
	quote: CompleteFlatTextQuoteV360;
	finalQuoteInput: FinalChatQuoteInput;
	claim: (request: TextGrantClaimRequestV361) => Promise<unknown>;
	nowMs?: () => number;
	signal?: AbortSignal;
}): Readonly<{
	run<T>(route: RouteResult, prepared: unknown,
		send: (receipt: CommittedTextGrantReceiptV361) => Promise<T>): Promise<T>;
}> {
	let entered = false;
	const clock = params.nowMs ?? Date.now;
	return Object.freeze({
		async run<T>(route: RouteResult, prepared: unknown,
			send: (receipt: CommittedTextGrantReceiptV361) => Promise<T>): Promise<T> {
			if (entered) throw new TextGrantEgressRejectedError();
			entered = true;
			if (params.signal?.aborted) throw new TextGrantEgressRejectedError();
			const claim = prepareClaim(params.quote, route, prepared, clock());
			await assertFlatTextWireBodyMatchesQuoteV362({
				input: params.finalQuoteInput, quote: params.quote,
				route, prepared: prepared as PreparedTextAttempt,
			});
			const response = await params.claim(claim);
			const receipt = checkedReceipt(response, claim, params.quote, clock());
			if (params.signal?.aborted
				|| !preparedTextAttemptMatchesRoute(prepared, route)
				|| Date.parse(receipt.expiresAt) <= clock()) {
				throw new TextGrantEgressRejectedError();
			}
			return send(receipt);
		},
	});
}
