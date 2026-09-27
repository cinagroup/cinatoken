import { createHash, randomUUID } from 'node:crypto';
import {
	applyVertexOpenAiModelPrefix,
	decryptProviderApiKeyReadOnly,
	resolveUpstreamEndpoint,
} from '@octafuse/core';
import type { RouteResult } from './model-router';
import type { CompleteFlatTextQuoteV360 } from './postgres-complete-chat-quote-v360';
import type { ChatTextHolderRequestV363 } from './chat-text-holder-request-v363';
import type { FinalChatQuoteInput } from './chat-final-quote-input';
import { canonicalChatJsonSha256 } from './chat-final-quote-input';
import {
	createReviewOnlyTextGrantGateV361,
	type CommittedTextGrantReceiptV361,
	type TextGrantClaimRequestV361,
} from './chat-text-grant-egress-contract-v361';
import { buildRouteRequestBody } from './route-default-params';
import { ensureOpenAiStreamIncludesUsage } from './egress/openai-stream-usage-request';
import { assertTextUpstreamHttpUrl } from './egress/text-upstream-url';
import { createOwnedJsonUploadBody } from './egress/owned-json-upload-body';
import { captureTextRouteIdentity, createPreparedTextAttempt } from './egress/prepared-text-attempt';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
// v362 grants at most 30 seconds to start and fixes the hold recovery lease at
// 15 minutes. Start this monotonic guard before asking for the grant: slow
// grant, custody or send-start close ACKs all consume the same local window.
const MAX_UNRENEWED_STREAM_MS = 14 * 60_000;
const BODY_FIELDS = new Set([
	'model', 'models', 'messages', 'max_tokens', 'max_completion_tokens',
	'stream', 'temperature', 'top_p', 'presence_penalty', 'frequency_penalty',
	'seed', 'stop', 'user',
]);
const ENVELOPE_KEYS = Object.freeze([
	'requestId', 'quoteId', 'attemptNonce', 'candidateIndex',
	'routeTargetId', 'finalBodyUtf8',
] as const);

export class PrivateCompleteTextHolderRejectedError extends Error {
	constructor() {
		super('Private complete text attempt was not authorized for physical send');
		this.name = 'PrivateCompleteTextHolderRejectedError';
	}
}

export type PrivateCompleteTextHolderPortsV365 = Readonly<{
	/** Dedicated read role; return only a committed quote for the requested ID. */
	loadQuote(quoteId: string): Promise<CompleteFlatTextQuoteV360 | null>;
	/** Dedicated read role; return the live selected route with ciphertext, never plaintext. */
	loadRoute(input: Readonly<{ quoteId: string; candidateIndex: number; routeTargetId: string }>): Promise<RouteResult | null>;
	/** Separate private credential read; its stored bytes must equal the route ciphertext. */
	loadProviderCiphertext(providerId: string): Promise<string | null>;
	/** Holder-only KEK. It must not be bound in the public gateway Worker. */
	providerEncryptionSecret: string;
	/** Dedicated v362 granter client. It must wait for transaction COMMIT and connection close. */
	grantAttempt(attemptNonce: string, claim: TextGrantClaimRequestV361): Promise<unknown>;
	/** Dedicated v365 direct LOGIN client. A replay cannot renew this right. */
	claimSendCustody(grantId: string, holderRunId: string): Promise<unknown>;
	/** A second direct LOGIN call, acknowledged after COMMIT and connection close. */
	recordSendStart(grantId: string, holderRunId: string,
		expectedEpoch: number, uploadSha256: string): Promise<unknown>;
	/** Optional v367 direct LOGIN client; only a COMMIT and close acknowledged new epoch extends reading. */
	renewHolds?(grantId: string, holderRunId: string, sendStartId: string,
		expectedEpoch: number): Promise<unknown>;
	/** Injectable only for local verification; production supplies global fetch. */
	fetchUpstream?: typeof fetch;
	nowMs?: () => number;
	newHolderRunId?: () => string;
	/** Test seam; production can only shorten the conservative lease guard. */
	maxUnrenewedStreamMs?: number;
}>;

function reject(): never { throw new PrivateCompleteTextHolderRejectedError(); }
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function envelope(value: unknown): ChatTextHolderRequestV363 {
	if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
	const row = value as Record<string, unknown>;
	if (Object.keys(row).length !== ENVELOPE_KEYS.length
		|| ENVELOPE_KEYS.some(key => !Object.hasOwn(row, key))
		|| typeof row.requestId !== 'string' || row.requestId.length < 1 || row.requestId.length > 128
		|| typeof row.quoteId !== 'string' || !UUID.test(row.quoteId)
		|| typeof row.attemptNonce !== 'string' || !UUID.test(row.attemptNonce)
		|| !Number.isSafeInteger(row.candidateIndex)
		|| (row.candidateIndex as number) < 0 || (row.candidateIndex as number) > 7
		|| typeof row.routeTargetId !== 'string' || row.routeTargetId.length < 1
		|| row.routeTargetId.length > 512
		|| typeof row.finalBodyUtf8 !== 'string') reject();
	const bytes = new TextEncoder().encode(row.finalBodyUtf8 as string);
	if (bytes.length < 2 || bytes.length > 1_048_576) reject();
	return Object.freeze(Object.fromEntries(ENVELOPE_KEYS.map(key => [key, row[key]]))) as ChatTextHolderRequestV363;
}

function checkedQuote(request: ChatTextHolderRequestV363,
	quote: CompleteFlatTextQuoteV360 | null, nowMs: number): FinalChatQuoteInput {
	if (!quote || quote.quoteId !== request.quoteId || quote.requestId !== request.requestId
		|| quote.credentialClass !== 'platform' || !SHA256.test(quote.finalBodySha256)
		|| !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= nowMs
		|| !Array.isArray(quote.modelIds) || quote.modelIds.length < 1 || quote.modelIds.length > 8
		|| quote.modelIds.some(id => typeof id !== 'string' || id.length < 1 || id.length > 240)
		|| new Set(quote.modelIds).size !== quote.modelIds.length
		|| request.candidateIndex >= quote.modelIds.length
		|| sha256(request.finalBodyUtf8) !== quote.finalBodySha256) reject();
	let parsed: unknown;
	try { parsed = JSON.parse(request.finalBodyUtf8); } catch { reject(); }
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) reject();
	const body = parsed as Record<string, unknown>;
	if (Object.keys(body).some(key => !BODY_FIELDS.has(key))
		|| body.model !== quote.modelIds[0]
		|| !Array.isArray(body.models) || body.models.length !== quote.modelIds.length
		|| body.models.some((model, i) => model !== quote.modelIds[i])
		|| !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 1024
		|| body.messages.some(message => !message || typeof message !== 'object' || Array.isArray(message)
			|| !['system', 'developer', 'user', 'assistant'].includes((message as Record<string, unknown>).role as string)
			|| typeof (message as Record<string, unknown>).content !== 'string'
			|| Object.keys(message as object).some(key => key !== 'role' && key !== 'content'))
		|| (body.stream !== undefined && typeof body.stream !== 'boolean')) reject();
	return Object.freeze({
		requestId: quote.requestId,
		originalBodySha256: '0'.repeat(64),
		finalBodyUtf8: request.finalBodyUtf8,
		finalBodySha256: quote.finalBodySha256,
		modelIds: Object.freeze([...quote.modelIds]),
		assertCurrent() { reject(); },
	});
}

function checkedRoute(request: ChatTextHolderRequestV363,
	quote: CompleteFlatTextQuoteV360, value: RouteResult | null): RouteResult {
	if (!value || value.targetId !== request.routeTargetId
		|| value.gatewayCandidateIndex !== request.candidateIndex
		|| value.gatewayModelId !== quote.modelIds[request.candidateIndex]
		|| value.providerSharedChannelType !== null
		|| value.gatewayPrivateByokFallback === true
		|| value.providerKeyId !== value.providerId
		|| value.upstreamProtocol !== 'openai' || value.upstreamOperation !== 'chat'
		|| value.adapter !== 'passthrough' || value.priceOverrideRaw !== null
		|| value.customParams !== null || !value.endpoint?.id
		|| typeof value.providerApiKey !== 'string'
		|| !value.providerApiKey.startsWith('enc:v2:')
		|| value.gatewayTextSpeed !== undefined
		|| value.gatewayRequestedServiceTier !== undefined
		|| value.gatewayServiceTier !== undefined) reject();
	// A private DB adapter must return plain data. Clone before any await so later
	// mutation cannot swap endpoint or ciphertext after the grant claim is made.
	try { return structuredClone(value); } catch { reject(); }
}

function checkedCustody(value: unknown, grant: CommittedTextGrantReceiptV361,
	holderRunId: string, nowMs: number): Readonly<{ leaseEpoch: number; leaseUntil: string }> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
	const receipt = value as Record<string, unknown>;
	if (receipt.status !== 'custody_claim_recorded' || receipt.commitAcknowledged !== true
		|| receipt.grantId !== grant.grantId || receipt.holderRunId !== holderRunId
		|| receipt.leaseEpoch !== 1
		|| typeof receipt.leaseUntil !== 'string'
		|| !Number.isFinite(Date.parse(receipt.leaseUntil))
		|| Date.parse(receipt.leaseUntil) <= nowMs) reject();
	return Object.freeze({ leaseEpoch: 1, leaseUntil: receipt.leaseUntil as string });
}

function checkedSendStart(value: unknown, grant: CommittedTextGrantReceiptV361,
	holderRunId: string, leaseEpoch: number, leaseUntil: string, nowMs: number): string {
	if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
	const receipt = value as Record<string, unknown>;
	if (receipt.status !== 'start_recorded' || receipt.commitAcknowledged !== true
		|| typeof receipt.sendStartId !== 'string' || !UUID.test(receipt.sendStartId)
		|| receipt.grantId !== grant.grantId
		|| receipt.holderRunId !== holderRunId
		|| receipt.leaseEpoch !== leaseEpoch
		|| receipt.uploadSha256 !== grant.outboundBodySha256
		|| typeof receipt.expiresAt !== 'string'
		|| !Number.isFinite(Date.parse(receipt.expiresAt))
		|| Date.parse(receipt.expiresAt) <= nowMs
		|| Date.parse(receipt.expiresAt) > Date.parse(leaseUntil)
		|| Date.parse(receipt.expiresAt) > Date.parse(grant.expiresAt)) reject();
	return receipt.sendStartId as string;
}

function checkedRenewal(value: unknown, grantId: string, holderRunId: string,
	sendStartId: string, expectedEpoch: number, priorLeaseUntil: string,
	nowMs: number): Readonly<{ leaseEpoch: number; leaseUntil: string }> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
	const receipt = value as Record<string, unknown>;
	if (receipt.status !== 'renewal_recorded' || receipt.commitAcknowledged !== true
		|| receipt.closeAcknowledged !== true || receipt.grantId !== grantId
		|| receipt.holderRunId !== holderRunId || receipt.sendStartId !== sendStartId
		|| receipt.leaseEpoch !== expectedEpoch + 1
		|| typeof receipt.leaseUntil !== 'string'
		|| !Number.isFinite(Date.parse(receipt.leaseUntil))
		|| Date.parse(receipt.leaseUntil) <= Date.parse(priorLeaseUntil)
		|| Date.parse(receipt.leaseUntil) <= nowMs) reject();
	return Object.freeze({
		leaseEpoch: receipt.leaseEpoch as number,
		leaseUntil: receipt.leaseUntil as string,
	});
}

type RenewableLeaseGuard = Readonly<{
	signal: AbortSignal;
	ensureLive(): void;
	confirmInitialLease(leaseUntil: string): void;
	start(grantId: string, holderRunId: string, sendStartId: string,
		epoch: number, leaseUntil: string): void;
	abort(): void;
	stop(): void;
}>;

function createRenewableLeaseGuard(maxLocalMs: number, nowMs: () => number,
	callerSignal: AbortSignal, renewHolds: NonNullable<PrivateCompleteTextHolderPortsV365['renewHolds']>): RenewableLeaseGuard {
	const controller = new AbortController();
	let active = true;
	let deadline = performance.now() + maxLocalMs;
	let expiryTimer: ReturnType<typeof setTimeout> | undefined;
	let renewalTimer: ReturnType<typeof setTimeout> | undefined;
	let identity: Readonly<{ grantId: string; holderRunId: string; sendStartId: string }> | undefined;
	let epoch = 1;
	let leaseUntil = '';
	const clearTimers = () => {
		if (expiryTimer) clearTimeout(expiryTimer);
		if (renewalTimer) clearTimeout(renewalTimer);
		expiryTimer = undefined;
		renewalTimer = undefined;
	};
	const stop = () => {
		if (!active) return;
		active = false;
		clearTimers();
		callerSignal.removeEventListener('abort', abort);
	};
	const abort = () => {
		if (!active) return;
		stop();
		controller.abort();
	};
	const ensureLive = () => {
		if (!active || callerSignal.aborted || performance.now() >= deadline) {
			abort();
			reject();
		}
	};
	const armExpiry = () => {
		if (expiryTimer) clearTimeout(expiryTimer);
		const remaining = deadline - performance.now();
		if (remaining <= 0) { abort(); return; }
		expiryTimer = setTimeout(abort, remaining);
	};
	const scheduleRenewal = () => {
		if (!active || !identity) return;
		const remaining = deadline - performance.now();
		if (remaining <= 0) { abort(); return; }
		renewalTimer = setTimeout(() => { void attemptRenewal(); }, Math.max(1, Math.floor(remaining / 2)));
	};
	const attemptRenewal = async () => {
		if (!identity || !active) return;
		try {
			ensureLive();
			const { grantId, holderRunId, sendStartId } = identity;
			const next = checkedRenewal(
				await renewHolds(grantId, holderRunId, sendStartId, epoch),
				grantId, holderRunId, sendStartId, epoch, leaseUntil, nowMs(),
			);
			ensureLive();
			const nextDeadline = Math.min(performance.now() + maxLocalMs,
				performance.now() + Date.parse(next.leaseUntil) - nowMs());
			if (nextDeadline <= deadline) reject();
			epoch = next.leaseEpoch;
			leaseUntil = next.leaseUntil;
			deadline = nextDeadline;
			armExpiry();
			scheduleRenewal();
		} catch { abort(); }
	};
	callerSignal.addEventListener('abort', abort, { once: true });
	armExpiry();
	return Object.freeze({
		signal: controller.signal, ensureLive, abort, stop,
		confirmInitialLease(initialLeaseUntil: string) {
			ensureLive();
			deadline = Math.min(deadline,
				performance.now() + Date.parse(initialLeaseUntil) - nowMs());
			armExpiry();
			ensureLive();
		},
		start(grantId: string, holderRunId: string, sendStartId: string,
			initialEpoch: number, initialLeaseUntil: string) {
			ensureLive();
			identity = Object.freeze({ grantId, holderRunId, sendStartId });
			epoch = initialEpoch;
			leaseUntil = initialLeaseUntil;
			scheduleRenewal();
		},
	});
}

function guardedRenewalResponse(response: Response, guard: RenewableLeaseGuard): Response {
	if (!response.body) { guard.stop(); return response; }
	const reader = response.body.getReader();
	let terminal = false;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (terminal) return;
			try {
				guard.ensureLive();
				const part = await reader.read();
				if (terminal) return;
				guard.ensureLive();
				if (part.done) {
					terminal = true; reader.releaseLock(); guard.stop(); controller.close();
				}
				else controller.enqueue(part.value);
			} catch (error) {
				if (!terminal) {
					terminal = true; reader.releaseLock(); guard.abort(); controller.error(error);
				}
			}
		},
		async cancel(reason) {
			if (terminal) return;
			terminal = true;
			// Let the real source cancellation finish before aborting its fetch.
			// Aborting first turns the source into an errored stream and makes
			// reader.cancel reject instead of confirming resource release.
			try { await reader.cancel(reason); }
			finally { reader.releaseLock(); guard.abort(); }
		},
	});
	return new Response(body, {
		status: response.status, statusText: response.statusText, headers: response.headers,
	});
}

/**
 * Default-unwired holder composition. The private ports are trust boundaries,
 * not gateway callbacks: production adapters must use holder-only DB roles and
 * secret bindings. One instance consumes one envelope even after an unknown ACK.
 */
export function createPrivateCompleteTextHolderV365(ports: PrivateCompleteTextHolderPortsV365) {
	let entered = false;
	const clock = ports.nowMs ?? Date.now;
	const unrenewedStreamMs = ports.maxUnrenewedStreamMs ?? MAX_UNRENEWED_STREAM_MS;
	if (!Number.isSafeInteger(unrenewedStreamMs) || unrenewedStreamMs < 1
		|| unrenewedStreamMs > MAX_UNRENEWED_STREAM_MS) {
		throw new TypeError('Private complete text unrenewed stream bound invalid');
	}
	return Object.freeze({
		async run(untrustedRequest: unknown, signal: AbortSignal): Promise<Response> {
			if (entered) reject();
			entered = true;
			if (signal.aborted) reject();
			const request = envelope(untrustedRequest);
			const quote = await ports.loadQuote(request.quoteId);
			const input = checkedQuote(request, quote, clock());
			if (signal.aborted) reject();
			const route = checkedRoute(request, quote!, await ports.loadRoute({
				quoteId: request.quoteId, candidateIndex: request.candidateIndex,
				routeTargetId: request.routeTargetId,
			}));
			const ciphertext = await ports.loadProviderCiphertext(route.providerId);
			if (ciphertext !== route.providerApiKey || signal.aborted) reject();
			let bearer: string;
			try {
				bearer = await decryptProviderApiKeyReadOnly(
					route.providerId, ciphertext!, ports.providerEncryptionSecret,
				);
				if (!bearer || bearer === ciphertext || /[\r\n]/u.test(bearer)) reject();
			} catch { reject(); }
			if (signal.aborted) reject();
			const url = resolveUpstreamEndpoint('openai', 'chat', route.providerEndpoints,
				{ providerId: route.providerId });
			assertTextUpstreamHttpUrl(url);
			const body = JSON.parse(request.finalBodyUtf8) as Record<string, unknown>;
			delete body.models;
			const transformed = ensureOpenAiStreamIncludesUsage({
				...buildRouteRequestBody(route, body),
				model: applyVertexOpenAiModelPrefix(url, route.providerModelName),
			});
			const upload = createOwnedJsonUploadBody(transformed, signal);
			try {
				if (upload.contentLength > 2_097_152) reject();
				const headers = {
					'Content-Type': 'application/json',
					'Content-Length': String(upload.contentLength),
					Authorization: `Bearer ${bearer}`,
				};
				new Headers(headers);
				const prepared = createPreparedTextAttempt({
					routeIdentity: captureTextRouteIdentity(route),
					url, method: 'POST', headers,
					outboundBodySha256: await upload.digestSha256(),
					outboundBodyBytes: upload.contentLength,
					outboundBodyCanonicalSha256: await canonicalChatJsonSha256(upload.preparedSnapshot),
				});
				const renewable = ports.renewHolds
					? createRenewableLeaseGuard(unrenewedStreamMs, clock, signal, ports.renewHolds)
					: undefined;
				const leaseStop = renewable?.signal ?? AbortSignal.timeout(unrenewedStreamMs);
				const gate = createReviewOnlyTextGrantGateV361({
					quote: quote!, finalQuoteInput: input, nowMs: clock, signal,
					claim: claim => ports.grantAttempt(request.attemptNonce, claim),
				});
				try {
					return await gate.run(route, prepared, async grant => {
						if (signal.aborted || leaseStop.aborted) reject();
						const holderRunId = (ports.newHolderRunId ?? randomUUID)();
						if (!UUID.test(holderRunId) || holderRunId === request.attemptNonce) reject();
						const custody = checkedCustody(
							await ports.claimSendCustody(grant.grantId, holderRunId),
							grant, holderRunId, clock(),
						);
						renewable?.confirmInitialLease(custody.leaseUntil);
						if (signal.aborted || leaseStop.aborted
							|| Date.parse(grant.expiresAt) <= clock()) reject();
						const sendStart = await ports.recordSendStart(
							grant.grantId, holderRunId, custody.leaseEpoch,
							prepared.outboundBodySha256,
						);
						const sendStartId = checkedSendStart(sendStart, grant, holderRunId, custody.leaseEpoch,
							custody.leaseUntil, clock());
						renewable?.start(grant.grantId, holderRunId, sendStartId,
							custody.leaseEpoch, custody.leaseUntil);
						const physicalSignal = AbortSignal.any([signal, leaseStop]);
						if (physicalSignal.aborted || Date.parse(grant.expiresAt) <= clock()
							|| Date.parse(custody.leaseUntil) <= clock()) reject();
						// Exactly one physical POST. redirect:error prevents a second dispatch.
						const response = await (ports.fetchUpstream ?? fetch)(url, {
							method: 'POST', redirect: 'error', headers,
							body: upload.body, duplex: 'half', signal: physicalSignal,
						} as RequestInit & { duplex: 'half' });
						// Headers can precede request-body EOF. Keep the upload owner alive
						// until its stream has completed or transport has cancelled it.
						if (await upload.resourceCompletion !== 'confirmed') reject();
						renewable?.ensureLive();
						return renewable ? guardedRenewalResponse(response, renewable) : response;
					});
				} catch (error) {
					renewable?.abort();
					throw error;
				}
			} finally { upload.stop(); }
		},
	});
}
