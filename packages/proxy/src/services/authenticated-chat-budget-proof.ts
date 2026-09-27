import type { GatewayRepositories, GuardrailBudgetIntent } from '@octafuse/core';
import type { ApiKeyContext } from '../middleware/auth';
import {
	estimateGatewayKeyByokBudgetMicros,
	estimateGuardrailBudgetMicros,
	estimateOrdinaryBudgetChargedCost,
} from './guardrail-budget-estimate';
import type { ModelFallbackPlanResult } from './model-fallback-plan';
import type { RouteResult } from './model-router';
import {
	ordinaryBudgetReservationMicros,
	type OrdinaryBudgetRepositories,
} from './ordinary-budget-lifecycle';
import {
	createRouteAwareBudgetAdmission,
	type GuardrailBudgetRequestPort,
	type RouteAwareBudgetAdmission,
} from './request-budget-admission';
import { MAX_REQUEST_DISPATCHES } from './request-dispatch-budget';

type ResolvedPlan = Extract<ModelFallbackPlanResult, { ok: true }>;

/** This candidate has no caller-supplied held amount. Only the server's auth and route snapshots enter. */
export type AuthenticatedChatBudgetProofInput = Readonly<{
	requestId: string;
	authenticatedKey: ApiKeyContext;
	plan: ResolvedPlan;
	budgetIntents: readonly GuardrailBudgetIntent[];
	now: Date;
}>;

export class AuthenticatedChatBudgetProofError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AuthenticatedChatBudgetProofError';
	}
}

function finiteMicros(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) {
		throw new AuthenticatedChatBudgetProofError(`${label} has no provable finite micro-unit ceiling`);
	}
	return value;
}

function totalMicros(perDispatch: number, dispatchLimit: number, label: string): number {
	const total = perDispatch * dispatchLimit;
	if (!Number.isSafeInteger(total) || total < 0) {
		throw new AuthenticatedChatBudgetProofError(`${label} exceeds the safe request ceiling`);
	}
	return total;
}

function routePricingBinding(route: RouteResult): string {
	// Credential expansion changes providerApiKey/providerKeyId, never these priced route fields.
	return JSON.stringify({
		targetId: route.targetId,
		providerId: route.providerId,
		providerModelName: route.providerModelName,
		providerSharedChannelType: route.providerSharedChannelType,
		gatewayModelId: route.gatewayModelId,
		gatewayCandidateIndex: route.gatewayCandidateIndex,
		gatewayServiceTier: route.gatewayServiceTier,
		gatewayRequestedServiceTier: route.gatewayRequestedServiceTier,
		gatewayTextSpeed: route.gatewayTextSpeed,
		upstreamProtocol: route.upstreamProtocol,
		upstreamOperation: route.upstreamOperation,
		adapter: route.adapter,
		endpoint: route.endpoint,
		priceOverrideRaw: route.priceOverrideRaw,
		routeChargedProfileJson: route.routeChargedProfileJson,
		routeMeteredProfileJson: route.routeMeteredProfileJson,
		customParams: route.customParams,
	});
}

function planBinding(plan: ResolvedPlan): string {
	return JSON.stringify(plan.candidates.map(candidate => ({
		baseModelId: candidate.baseModelId,
		modelPricingProfile: candidate.model.pricing_profile,
		upstreamBody: candidate.upstreamBody,
		routes: candidate.routes.map(routePricingBinding),
	})));
}

function authenticatedKeyBinding(key: ApiKeyContext): string {
	return JSON.stringify({
		userId: key.userId,
		keyId: key.keyId,
		workspaceId: key.workspaceId,
		apiKeyHash: key.apiKeyHash,
		budgetMax: key.budgetMax,
		budgetEpoch: key.budgetEpoch,
		includeByokInLimit: key.includeByokInLimit === true,
		chargedCostFactors: key.chargedCostFactors,
	});
}

function assertIntentBoundToKey(intent: GuardrailBudgetIntent, key: ApiKeyContext): void {
	if (intent.workspaceId !== key.workspaceId
		|| (intent.scopeType === 'user' && intent.scopeId !== key.userId)
		|| (intent.scopeType === 'api_key' && intent.scopeId !== key.keyId)
		|| (intent.scopeType === 'workspace' && intent.scopeId !== key.workspaceId)) {
		throw new AuthenticatedChatBudgetProofError('Guardrail intent differs from authenticated Gateway Key');
	}
}

/**
 * Request-local review candidate. A dispatch permit can be consumed at most
 * MAX_REQUEST_DISPATCHES times; any one credential-expanded attempt may repeat
 * the most expensive priced route. Hold that per-attempt ceiling once for every
 * possible dispatch, including unsuccessful billable attempts.
 *
 * This is a trusted Worker composition proof, not independent verification by
 * the v350/v351 SQL functions. Those functions still trust the admission LOGIN
 * to provide the held amount and do not know the route quote.
 */
export function createAuthenticatedChatBudgetProof(input: AuthenticatedChatBudgetProofInput): Readonly<{
	authenticatedKeySnapshot: Readonly<Pick<ApiKeyContext,
		'keyId' | 'userId' | 'workspaceId' | 'chargedCostFactors'>>;
	assertSettlementSnapshot(route: RouteResult, pricingRoute: RouteResult): void;
	open(repositories: GatewayRepositories, options?: {
		ordinaryBudgetRepositories?: OrdinaryBudgetRepositories;
		ordinaryRecoveryFailureMode?: 'fail_closed';
		guardrailBudgetRequestPort?: GuardrailBudgetRequestPort;
	}): Promise<RouteAwareBudgetAdmission>;
}> {
	const { authenticatedKey: key, plan, now } = input;
	if (typeof input.requestId !== 'string' || input.requestId.length < 1 || input.requestId.length > 128
		|| !key || !key.userId || !key.keyId || !key.workspaceId
		|| !Number.isSafeInteger(key.budgetEpoch) || key.budgetEpoch < 0
		|| !(now instanceof Date) || !Number.isFinite(now.getTime())
		|| !Array.isArray(plan.candidates) || plan.candidates.length === 0) {
		throw new AuthenticatedChatBudgetProofError('Authenticated Chat budget proof input invalid');
	}
	for (const intent of input.budgetIntents) assertIntentBoundToKey(intent, key);
	const ordinaryEstimate = estimateOrdinaryBudgetChargedCost(plan.candidates, key.chargedCostFactors);
	if (!ordinaryEstimate.ok) {
		throw new AuthenticatedChatBudgetProofError(ordinaryEstimate.message);
	}
	const ordinaryPerDispatch = ordinaryBudgetReservationMicros(ordinaryEstimate.estimatedChargedCost);
	if (!ordinaryPerDispatch.ok) {
		throw new AuthenticatedChatBudgetProofError(ordinaryPerDispatch.error.message);
	}
	const ordinaryHeldMicros = totalMicros(ordinaryPerDispatch.reservedMicros,
		MAX_REQUEST_DISPATCHES, 'Ordinary budget');
	const rawGuardrailHeldMicros = totalMicros(finiteMicros(
		estimateGuardrailBudgetMicros(plan.candidates, key.chargedCostFactors), 'Guardrail budget'),
		MAX_REQUEST_DISPATCHES, 'Guardrail budget');
	const guardrailHeldMicros = Math.max(rawGuardrailHeldMicros, ordinaryHeldMicros);
	const gatewayKeyHeldMicros = totalMicros(finiteMicros(
		estimateGatewayKeyByokBudgetMicros(plan.candidates), 'Gateway Key BYOK budget'),
		MAX_REQUEST_DISPATCHES, 'Gateway Key BYOK budget');
	// ReserveOrdinaryUserBudget accepts money units and performs a second ceiling
	// conversion. Give it one extra micro and verify the round-trip never shrinks
	// below the integer aggregate used in this proof.
	const ordinaryHeldCost = ordinaryHeldMicros === 0
		? 0 : (ordinaryHeldMicros + 1) / 1_000_000;
	const converted = ordinaryBudgetReservationMicros(ordinaryHeldCost);
	if (!converted.ok || converted.reservedMicros < ordinaryHeldMicros) {
		throw new AuthenticatedChatBudgetProofError('Ordinary budget aggregate cannot round-trip safely');
	}
	const quotedRoutes = new Set(plan.candidates.flatMap(candidate =>
		candidate.routes.map(routePricingBinding)));
	if (quotedRoutes.size === 0) {
		throw new AuthenticatedChatBudgetProofError('Chat fallback plan has no quoted route');
	}
	for (const globalRoute of plan.globalRoutes) {
		if (!quotedRoutes.has(routePricingBinding(globalRoute))) {
			throw new AuthenticatedChatBudgetProofError('Global fallback route lacks a priced candidate');
		}
	}
	const capturedPlan = planBinding(plan);
	const capturedKey = authenticatedKeyBinding(key);
	const intents = input.budgetIntents.map(intent => Object.freeze({ ...intent }));
	const identity = Object.freeze({
		requestId: input.requestId,
		userId: key.userId,
		apiKeyId: key.keyId,
		budgetMax: key.budgetMax,
		budgetEpoch: key.budgetEpoch,
		includeByokInLimit: key.includeByokInLimit === true,
	});
	const authenticatedKeySnapshot = Object.freeze({
		keyId: identity.apiKeyId,
		userId: identity.userId,
		workspaceId: key.workspaceId,
		chargedCostFactors: key.chargedCostFactors,
	});
	const admissionNow = new Date(now.getTime());
	let opened = false;
	const assertRoute = (route: RouteResult): void => {
		if (authenticatedKeyBinding(key) !== capturedKey
			|| planBinding(plan) !== capturedPlan
			|| !quotedRoutes.has(routePricingBinding(route))) {
			throw new AuthenticatedChatBudgetProofError('Dispatch route differs from the proven Chat fallback plan');
		}
	};
	return Object.freeze({
		authenticatedKeySnapshot,
		assertSettlementSnapshot(route: RouteResult, pricingRoute: RouteResult): void {
			assertRoute(route);
			assertRoute(pricingRoute);
		},
		async open(repositories: GatewayRepositories, options: {
			ordinaryBudgetRepositories?: OrdinaryBudgetRepositories;
			ordinaryRecoveryFailureMode?: 'fail_closed';
			guardrailBudgetRequestPort?: GuardrailBudgetRequestPort;
		} = {}): Promise<RouteAwareBudgetAdmission> {
			if (opened) throw new AuthenticatedChatBudgetProofError('Chat budget proof already opened');
			if (authenticatedKeyBinding(key) !== capturedKey || planBinding(plan) !== capturedPlan) {
				throw new AuthenticatedChatBudgetProofError('Authenticated Chat quote changed before admission');
			}
			opened = true;
			const admission = await createRouteAwareBudgetAdmission(repositories, {
				ordinary: {
					requestId: identity.requestId,
					userId: identity.userId,
					apiKeyId: identity.apiKeyId,
					budgetMax: identity.budgetMax,
					expectedBudgetEpoch: identity.budgetEpoch,
					estimatedChargedCost: ordinaryHeldCost,
					now: admissionNow,
				},
				guardrail: { intents, reservedMicros: guardrailHeldMicros, now: admissionNow },
				privateByokGatewayKey: {
					includeInLimit: identity.includeByokInLimit,
					reservedMicros: Math.max(guardrailHeldMicros, gatewayKeyHeldMicros),
				},
			}, options);
			return Object.freeze({
				get ordinaryLease() { return admission.ordinaryLease; },
				get guardrailReserved() { return admission.guardrailReserved; },
				get guardrailDispatched() { return admission.guardrailDispatched; },
				get guardrailTerminal() { return admission.guardrailTerminal; },
				beforeUpstreamDispatch(route: RouteResult) {
					assertRoute(route);
					return admission.beforeUpstreamDispatch(route);
				},
				prepareSingleGrant(route: RouteResult) {
					assertRoute(route);
					return admission.prepareSingleGrant(route);
				},
				releaseGuardrailPreDispatch: admission.releaseGuardrailPreDispatch,
				forfeitGuardrailPostDispatch: admission.forfeitGuardrailPostDispatch,
				terminateGuardrailUnknown: admission.terminateGuardrailUnknown,
			});
		},
	});
}
