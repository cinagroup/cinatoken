import { randomUUID } from 'node:crypto';
import type { GuardrailBudgetIntent, PostgresDatabaseClient } from '@octafuse/core';
import type { FinalChatQuoteSnapshot } from './chat-final-quote-input';
import { authenticatePostgresPersonalKeyV395 } from './postgres-personal-key-auth-v395';
import { issuePostgresCompleteChatQuoteV360 } from './postgres-complete-chat-quote-v360';
import { readPostgresCompleteTextRoutingProjectionV396 } from './postgres-complete-text-routing-projection-v396';
import { prepareCredentialFreeRouteAttemptsV398 } from './credential-free-route-attempts-v398';
import { createPostgresCompleteTextStickyRoutingV398 } from './postgres-complete-text-sticky-routing-v398';
import { admitPostgresCompleteChatQuoteV361 } from './postgres-complete-chat-admission-v361';
import { createChatTextHolderRequestV363 } from './chat-text-holder-request-v363';
import type { OpenRouterSessionRouting } from './openrouter-session-routing';

export type CredentialFreeCompleteChatInputV400 = Readonly<{
	finalQuoteInput: FinalChatQuoteSnapshot; bearer: string;
	guardrailIntents: readonly GuardrailBudgetIntent[];
	runtimeClient: PostgresDatabaseClient; runtimeConnectionString: string;
	authConnectionString: string; capabilityConnectionString: string;
	quoteConnectionString: string; projectorConnectionString: string;
	stickyConnectionString: string; admissionConnectionString: string;
	sessionRouting?: OpenRouterSessionRouting;
	holderBinding: Readonly<{ fetch(request: Request): Promise<Response> }>;
	signal: AbortSignal;
}>;
export type CredentialFreeCompleteChatPortsV400 = Readonly<{
	authenticate?: typeof authenticatePostgresPersonalKeyV395;
	issueQuote?: typeof issuePostgresCompleteChatQuoteV360;
	project?: typeof readPostgresCompleteTextRoutingProjectionV396;
	prepare?: typeof prepareCredentialFreeRouteAttemptsV398;
	admit?: typeof admitPostgresCompleteChatQuoteV361;
	newAttemptNonce?: () => string;
}>;
export class CredentialFreeCompleteChatRejectedV400 extends Error {
	constructor() { super('Credential-free complete Chat dispatch rejected'); this.name = 'CredentialFreeCompleteChatRejectedV400'; }
}
function reject(): never { throw new CredentialFreeCompleteChatRejectedV400(); }
const sameModels = (left: readonly string[], right: readonly string[]) => left.length === right.length
	&& left.every((model, index) => model === right[index]);

/**
 * Review-only default-platform Chat seam. Real role clients authenticate, quote,
 * project, prepare and admit before a single identifier-only holder handoff.
 * The private holder still owns credential reads and grant/custody/send-start.
 * This factory is not registered by the public Chat handler or a fallback loop.
 */
export function createCredentialFreeCompleteChatDispatchV400(input: CredentialFreeCompleteChatInputV400,
	ports: CredentialFreeCompleteChatPortsV400 = {}): Readonly<{ run(): Promise<Response> }> {
	// Capture the public bytes, identity inputs, ports and config synchronously.
	// The caller may subsequently reuse its mutable request/config containers.
	const original = input.finalQuoteInput;
	const snapshot: FinalChatQuoteSnapshot = Object.freeze({ requestId: original.requestId,
		originalBodySha256: original.originalBodySha256, finalBodyUtf8: original.finalBodyUtf8,
		finalBodySha256: original.finalBodySha256, modelIds: Object.freeze([...original.modelIds]) });
	const bearer = input.bearer, signal = input.signal;
	const runtimeClient: PostgresDatabaseClient = Object.freeze({ driver: input.runtimeClient.driver,
		raw: input.runtimeClient.raw, drizzle: input.runtimeClient.drizzle });
	const connections = Object.freeze({ runtimeConnectionString: input.runtimeConnectionString,
		authConnectionString: input.authConnectionString, capabilityConnectionString: input.capabilityConnectionString,
		quoteConnectionString: input.quoteConnectionString, projectorConnectionString: input.projectorConnectionString,
		stickyConnectionString: input.stickyConnectionString, admissionConnectionString: input.admissionConnectionString });
	const fetchHolder = input.holderBinding.fetch.bind(input.holderBinding);
	const sessionRouting = input.sessionRouting ? Object.freeze({ ...input.sessionRouting }) : undefined;
	const intentsJson = JSON.stringify(input.guardrailIntents);
	if (typeof intentsJson !== 'string' || intentsJson.length > 32_768) reject();
	const intents = JSON.parse(intentsJson) as GuardrailBudgetIntent[];
	if (!Array.isArray(intents) || intents.length > 7 || intents.some(intent => !intent || typeof intent !== 'object'
		|| Array.isArray(intent))) reject();
	const guardrailIntents = Object.freeze(intents.map(intent => Object.freeze(intent)));
	const authenticate = ports.authenticate ?? authenticatePostgresPersonalKeyV395;
	const issueQuote = ports.issueQuote ?? issuePostgresCompleteChatQuoteV360;
	const project = ports.project ?? readPostgresCompleteTextRoutingProjectionV396;
	const prepare = ports.prepare ?? prepareCredentialFreeRouteAttemptsV398;
	const admit = ports.admit ?? admitPostgresCompleteChatQuoteV361;
	const newAttemptNonce = ports.newAttemptNonce ?? randomUUID;
	let entered = false;
	return Object.freeze({ async run() {
		if (entered) reject(); entered = true;
		const live = (deadline = Number.POSITIVE_INFINITY) => { signal.throwIfAborted(); if (Date.now() >= deadline) reject(); };
		live();
		const authenticated = await authenticate({ authConnectionString: connections.authConnectionString, bearer, signal });
		live(); if (!authenticated) reject();
		const identity = Object.freeze({ apiKeyId: authenticated.keyId, userId: authenticated.userId,
			workspaceId: authenticated.workspaceId, budgetEpoch: authenticated.budgetEpoch,
			keyLimitEpoch: authenticated.keyLimitEpoch });
		const quote = await issueQuote({ runtimeClient, runtimeConnectionString: connections.runtimeConnectionString,
			capabilityConnectionString: connections.capabilityConnectionString, quoteConnectionString: connections.quoteConnectionString,
			bearer, identity, finalQuoteInput: snapshot });
		const quoteExpiry = Date.parse(quote.expiresAt);
		if (!Number.isFinite(quoteExpiry) || quote.requestId !== snapshot.requestId
			|| quote.finalBodySha256 !== snapshot.finalBodySha256 || quote.credentialClass !== 'platform'
			|| !sameModels(quote.modelIds, snapshot.modelIds)) reject();
		live(quoteExpiry);
		const projection = await project({ projectorConnectionString: connections.projectorConnectionString,
			quote, finalQuoteInput: snapshot, signal });
		const deadline = Math.min(quoteExpiry, Date.parse(projection.expiresAt));
		if (!Number.isFinite(deadline) || projection.quoteId !== quote.quoteId) reject();
		live(deadline);
		const prepared = await prepare({ projection, finalQuoteInput: snapshot, identity, sessionRouting, signal,
			createStickyPorts: context => createPostgresCompleteTextStickyRoutingV398({
				stickyConnectionString: connections.stickyConnectionString, context, signal }) });
		live(deadline);
		if (prepared.quoteId !== quote.quoteId || prepared.requestId !== snapshot.requestId
			|| prepared.finalBodySha256 !== snapshot.finalBodySha256 || prepared.routingEpoch !== projection.routingEpoch
			|| prepared.candidates.length !== snapshot.modelIds.length
			|| prepared.candidates.some((candidate, index) => candidate.candidateIndex !== index
				|| candidate.modelId !== snapshot.modelIds[index])) reject();
		// Request-level replay/unknown policy forbids automatic fallback after a
		// permitted send. Select once from the complete preflighted model list.
		const candidate = prepared.candidates.find(item => item.attempts.length > 0);
		if (!candidate) reject();
		const selected = candidate.attempts[0]!;
		const member = projection.candidates[candidate.candidateIndex]?.routes.find(route => route.targetId === selected.targetId);
		if (!member || member.providerId !== selected.providerId) reject();
		const envelope = createChatTextHolderRequestV363({ quote, finalQuoteInput: snapshot, attemptNonce: newAttemptNonce(),
			selectedRoute: { targetId: selected.targetId, gatewayCandidateIndex: candidate.candidateIndex, gatewayModelId: candidate.modelId } });
		const admission = await admit({ runtimeClient, runtimeConnectionString: connections.runtimeConnectionString,
			admissionConnectionString: connections.admissionConnectionString, quote, guardrailIntents });
		live(Math.min(deadline, Date.parse(admission.expiresAt)));
		if (!Number.isFinite(Date.parse(admission.expiresAt)) || Date.parse(admission.expiresAt) > quoteExpiry
			|| !['admitted', 'idempotent'].includes(admission.status) || admission.requestId !== snapshot.requestId
			|| admission.quoteId !== quote.quoteId || admission.finalBodySha256 !== snapshot.finalBodySha256
			|| admission.reservedMicros !== quote.threeAttemptCeilingMicros || admission.guardrailCount !== guardrailIntents.length
			|| !['reserved', 'unlimited'].includes(admission.ordinary)) reject();
		const response = await fetchHolder(new Request('https://holder.service.invalid/complete-text-attempt', {
			method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope) }));
		if (signal.aborted) { void response.body?.cancel().catch(() => undefined); signal.throwIfAborted(); }
		const streamed = (JSON.parse(snapshot.finalBodyUtf8) as Record<string, unknown>).stream === true;
		const expected = streamed ? 'text/event-stream' : 'application/json';
		const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
		if (response.status !== 200 || !response.body || (contentType !== expected && !contentType.startsWith(`${expected};`))) {
			void response.body?.cancel().catch(() => undefined); reject();
		}
		return new Response(response.body, { status: 200, headers: { 'Content-Type': expected, 'Cache-Control': 'no-store' } });
	} });
}
