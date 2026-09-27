import { randomUUID } from 'node:crypto';
import type { GuardrailBudgetIntent, PostgresDatabaseClient } from '@octafuse/core';
import type { ModelFallbackPlanResult } from './model-fallback-plan';
import type { ParsedModelFallbacks } from './model-fallbacks';
import type { RouteResult } from './model-router';
import type { FinalChatQuoteInput } from './chat-final-quote-input';
import {
	issuePostgresCompleteChatQuoteV360,
	type CompleteFlatTextQuoteV360,
} from './postgres-complete-chat-quote-v360';
import {
	admitPostgresCompleteChatQuoteV361,
	type CompleteChatAdmissionV361,
} from './postgres-complete-chat-admission-v361';
import { createChatTextHolderRequestV363 } from './chat-text-holder-request-v363';

type Plan = Extract<ModelFallbackPlanResult, { ok: true }>;
type QuoteParams = Parameters<typeof issuePostgresCompleteChatQuoteV360>[0];
type AdmissionParams = Parameters<typeof admitPostgresCompleteChatQuoteV361>[0];
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const HOLDER_URL = 'https://holder.service.invalid/complete-text-attempt';

export class CompleteChatHolderDispatchRejectedV385 extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CompleteChatHolderDispatchRejectedV385';
	}
}

export type CompleteChatHolderDispatchInputV385 = Readonly<{
	/** The actual post-preset/post-Guardrail input captured by the Chat route. */
	finalQuoteInput: FinalChatQuoteInput;
	currentBody: Record<string, unknown>;
	parsed: ParsedModelFallbacks;
	plan: Plan;
	selectedRoute: RouteResult;
	guardrailIntents: readonly GuardrailBudgetIntent[];
	bearer: string;
	identity: QuoteParams['identity'];
	runtimeClient: PostgresDatabaseClient;
	runtimeConnectionString: string;
	capabilityConnectionString: string;
	quoteConnectionString: string;
	admissionConnectionString: string;
	holderBinding: Readonly<{ fetch(request: Request): Promise<Response> }>;
	signal: AbortSignal;
}>;

export type CompleteChatHolderDispatchPortsV385 = Readonly<{
	/** Production defaults use the dedicated v360 direct LOGIN clients. */
	issueQuote?: (params: QuoteParams) => Promise<CompleteFlatTextQuoteV360>;
	/** Production defaults use the no-amount v361 direct LOGIN client. */
	admitQuote?: (params: AdmissionParams) => Promise<CompleteChatAdmissionV361>;
	newAttemptNonce?: () => string;
}>;

function reject(message: string): never {
	throw new CompleteChatHolderDispatchRejectedV385(message);
}

function assertLive(input: CompleteChatHolderDispatchInputV385): void {
	if (input.signal.aborted) reject('Chat holder request was cancelled');
	input.finalQuoteInput.assertCurrent(input.currentBody, input.parsed, input.plan);
}

function checkedRoute(input: CompleteChatHolderDispatchInputV385): void {
	const route = input.selectedRoute;
	const index = route.gatewayCandidateIndex;
	if (!Number.isSafeInteger(index) || index! < 0
		|| index! >= input.plan.candidates.length
		|| input.plan.candidates.length !== input.finalQuoteInput.modelIds.length
		|| route.gatewayModelId !== input.finalQuoteInput.modelIds[index!]
		|| !input.plan.candidates[index!]!.routes.some(candidate =>
			candidate.targetId === route.targetId)) {
		reject('Selected holder route differs from the final Chat plan');
	}
}

function checkedQuote(quote: CompleteFlatTextQuoteV360,
	input: CompleteChatHolderDispatchInputV385): void {
	const captured = input.finalQuoteInput;
	if (!quote || !UUID.test(quote.quoteId)
		|| quote.requestId !== captured.requestId
		|| quote.finalBodySha256 !== captured.finalBodySha256
		|| quote.credentialClass !== 'platform'
		|| quote.modelIds.length !== captured.modelIds.length
		|| quote.modelIds.some((id, i) => id !== captured.modelIds[i])
		|| !Number.isSafeInteger(quote.threeAttemptCeilingMicros)
		|| quote.threeAttemptCeilingMicros < 1
		|| !Number.isFinite(Date.parse(quote.expiresAt))
		|| Date.parse(quote.expiresAt) <= Date.now()) {
		reject('Committed complete Chat quote differs from the request');
	}
}

function checkedAdmission(admission: CompleteChatAdmissionV361,
	quote: CompleteFlatTextQuoteV360,
	input: CompleteChatHolderDispatchInputV385): void {
	if (!admission || (admission.status !== 'admitted' && admission.status !== 'idempotent')
		|| admission.requestId !== input.finalQuoteInput.requestId
		|| admission.quoteId !== quote.quoteId
		|| admission.finalBodySha256 !== quote.finalBodySha256
		|| admission.reservedMicros !== quote.threeAttemptCeilingMicros
		|| admission.guardrailCount !== input.guardrailIntents.length
		|| (admission.ordinary !== 'reserved' && admission.ordinary !== 'unlimited')
		|| !Number.isFinite(Date.parse(admission.expiresAt))
		|| Date.parse(admission.expiresAt) <= Date.now()
		|| Date.parse(admission.expiresAt) > Date.parse(quote.expiresAt)) {
		reject('Committed complete Chat admission differs from the quote');
	}
}

/**
 * Review-only one-shot Gateway-to-private-holder seam. The actual v360 and
 * v361 clients acknowledge COMMIT and direct LOGIN close before the six-field
 * envelope crosses the Service Binding. There is no Gateway KEK port, legacy
 * budget owner, legacy proxy or billing callback. No production route calls it.
 */
export function createCompleteChatHolderDispatchV385(
	input: CompleteChatHolderDispatchInputV385,
	ports: CompleteChatHolderDispatchPortsV385 = {},
): Readonly<{ run(): Promise<Response> }> {
	let entered = false;
	return Object.freeze({
		async run(): Promise<Response> {
			if (entered) reject('Complete Chat holder dispatch already entered');
			entered = true;
			if (!input.finalQuoteInput || !Object.isFrozen(input.finalQuoteInput)
				|| input.identity.apiKeyId.length < 1
				|| input.identity.userId.length < 1
				|| input.identity.workspaceId.length < 1
				|| typeof input.holderBinding?.fetch !== 'function') {
				reject('Complete Chat holder dispatch input invalid');
			}
			if (!Array.isArray(input.guardrailIntents)
				|| input.guardrailIntents.length > 7) {
				reject('Complete Chat Guardrail intents invalid');
			}
			const intentsJson = JSON.stringify(input.guardrailIntents);
			if (typeof intentsJson !== 'string' || intentsJson.length > 32_768) {
				reject('Complete Chat Guardrail intents invalid');
			}
			const parsedIntents = JSON.parse(intentsJson) as unknown;
			if (!Array.isArray(parsedIntents)
				|| parsedIntents.length !== input.guardrailIntents.length
				|| parsedIntents.some(intent => !intent || typeof intent !== 'object'
					|| Array.isArray(intent))) {
				reject('Complete Chat Guardrail intents invalid');
			}
			const frozenIntents = Object.freeze((parsedIntents as
				GuardrailBudgetIntent[]).map(intent => Object.freeze(intent)));
			const identity = Object.freeze({ ...input.identity });
			const bearer = input.bearer;
			const identityJson = JSON.stringify(identity);
			const assertIdentityUnchanged = () => {
				if (JSON.stringify(input.identity) !== identityJson
					|| input.bearer !== bearer) {
					reject('Authenticated Chat identity changed after quote preparation');
				}
			};
			const assertIntentsUnchanged = () => {
				if (JSON.stringify(input.guardrailIntents) !== intentsJson) {
					reject('Complete Chat Guardrail intents changed after quote preparation');
				}
			};
			assertLive(input);
			checkedRoute(input);
			const nonce = (ports.newAttemptNonce ?? randomUUID)();
			if (!UUID.test(nonce)) reject('Holder attempt nonce invalid');
			const quote = await (ports.issueQuote ?? issuePostgresCompleteChatQuoteV360)({
				runtimeClient: input.runtimeClient,
				runtimeConnectionString: input.runtimeConnectionString,
				capabilityConnectionString: input.capabilityConnectionString,
				quoteConnectionString: input.quoteConnectionString,
				bearer,
				identity,
				finalQuoteInput: input.finalQuoteInput,
			});
			checkedQuote(quote, input);
			assertLive(input);
			assertIdentityUnchanged();
			assertIntentsUnchanged();
			const admission = await (ports.admitQuote ?? admitPostgresCompleteChatQuoteV361)({
				runtimeClient: input.runtimeClient,
				runtimeConnectionString: input.runtimeConnectionString,
				admissionConnectionString: input.admissionConnectionString,
				quote,
				guardrailIntents: frozenIntents,
			});
			checkedAdmission(admission, quote, input);
			assertLive(input);
			assertIdentityUnchanged();
			assertIntentsUnchanged();
			checkedRoute(input);
			const envelope = createChatTextHolderRequestV363({
				quote, finalQuoteInput: input.finalQuoteInput,
				selectedRoute: input.selectedRoute, attemptNonce: nonce,
			});
			const request = new Request(HOLDER_URL, {
				method: 'POST', redirect: 'error', signal: input.signal,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(envelope),
			});
			// The holder independently reloads committed quote, route and ciphertext,
			// then obtains its own grant/custody/send-start before physical fetch.
			const response = await input.holderBinding.fetch(request);
			const streamed = (JSON.parse(input.finalQuoteInput.finalBodyUtf8) as
				Record<string, unknown>).stream === true;
			const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
			const expected = streamed ? 'text/event-stream' : 'application/json';
			if (response.status !== 200 || !response.body
				|| (contentType !== expected && !contentType.startsWith(`${expected};`))) {
				void response.body?.cancel().catch(() => undefined);
				reject('Private complete Chat holder response unavailable');
			}
			// Do not forward arbitrary Provider or private-Worker response headers.
			return new Response(response.body, { status: 200,
				headers: { 'Content-Type': expected, 'Cache-Control': 'no-store' } });
		},
	});
}
