import type { Context } from 'hono';
import type { Env } from '../app';
import type { ApiKeyContext } from '../middleware/auth';
import type { MultimediaChargedCostEstimate } from './multimedia-ordinary-budget';
import { multimediaEstimateHasProvablePricing } from './multimedia-ordinary-budget';
import { runRequestGuardrails } from './request-guardrails';
import { buildModelFallbackPlan } from './model-fallback-plan';
import { createRouteAwareBudgetAdmission } from './request-budget-admission';
import { GatewayErrorCode } from './gateway-error-codes';
import { gatewayErrorJson } from './gateway-error-response';
import type { UpstreamProtocol } from '@octafuse/core';
import type { FailoverDispatchOptions } from './failover-dispatch';
import type { ProxyResult } from './proxy';
import { privateByokContextForApiKey } from './byok-key-pool';
import { scheduleResourceCompletion } from '../runtime/schedule-resource-completion';
import { segmentedJsonResponseWithinLimit } from './egress/segmented-json-response';
import { IMAGE_JSON_ADMISSION_LIMITS } from './json-structure-budget';
import { boundRequestBody, MAX_REQUEST_BODY_BYTES } from './bounded-request-body';
import { createRequestDeadline } from './request-deadline';
import { ownUpstreamResponse } from './egress/owned-upstream-response';

type NativeContext = Context<Env & { Variables: { apiKey: ApiKeyContext } }>;

/** Bounded authenticated native JSON; retain neither Hono's body cache nor an unbounded text copy. */
export async function readNativeMediaJson(c: NativeContext): Promise<Record<string, unknown>> {
	const deadline = createRequestDeadline(Date.now() + 120_000, c.req.raw.signal);
	const ingress = ownUpstreamResponse(new Response(c.req.raw.body), deadline.signal);
	scheduleResourceCompletion(c, ingress.resourceCompletion);
	try {
		const parsed = await segmentedJsonResponseWithinLimit(
			ingress.response,
			MAX_REQUEST_BODY_BYTES,
			IMAGE_JSON_ADMISSION_LIMITS,
			deadline.signal,
		);
		if (!parsed.jsonValid || !parsed.body || typeof parsed.body !== 'object' || Array.isArray(parsed.body))
			throw new SyntaxError('Invalid JSON body');
		return parsed.body as Record<string, unknown>;
	} finally {
		deadline.dispose();
	}
}

/** Native nested input is projected into a shared prompt root, then restored after filtering. */
export async function prepareNativeMediaPolicy(
	c: NativeContext,
	input: {
		rawModelId: string;
		body: Record<string, unknown>;
		protocol: UpstreamProtocol;
		operation: string;
		start: number;
	},
) {
	const repos = c.get('repositories');
	const apiKey = c.get('apiKey');
	const requestId = crypto.randomUUID();
	const guardrail = await runRequestGuardrails(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		modelIds: [input.rawModelId],
		body: { model: input.rawModelId, input: { native: input.body }, stream: input.body.stream === true },
		correlationId: requestId,
		now: new Date(input.start),
	});
	if (!guardrail.ok)
		return gatewayErrorJson(c, {
			status: guardrail.status,
			code:
				guardrail.code === 'guardrail_invalid' ? GatewayErrorCode.guardrailInvalid : GatewayErrorCode.guardrailBlocked,
			message: guardrail.message,
		});
	// Images and binary/native audio cannot prove configured text output filters before delivery.
	if (guardrail.outputFilters.length)
		return gatewayErrorJson(c, {
			status: 403,
			code: GatewayErrorCode.guardrailBlocked,
			message: 'Native media output cannot safely enforce the configured output guardrail',
		});
	const planned = await buildModelFallbackPlan(repos, {
		modelIds: [input.rawModelId],
		body: guardrail.body,
		requestProtocol: input.protocol,
		requestOperation: input.operation,
		pricingAt: new Date(input.start),
	});
	if (!planned.ok) return gatewayErrorJson(c, { status: planned.status, code: planned.code, message: planned.message });
	const selected = planned.candidates[0]!;
	const native = (selected.upstreamBody.input as { native: Record<string, unknown> }).native;
	return { requestId, guardrail, selected, body: native, start: input.start };
}

type NativePolicy = Exclude<Awaited<ReturnType<typeof prepareNativeMediaPolicy>>, Response>;

export async function admitNativeMediaRequest(
	c: NativeContext,
	policy: NativePolicy,
	estimate: MultimediaChargedCostEstimate,
) {
	const apiKey = c.get('apiKey');
	const repos = c.get('repositories');
	const provable = multimediaEstimateHasProvablePricing(estimate);
	const charged = provable ? estimate.chargedCost : null;
	const micros = (value: number | null): number =>
		value !== null && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.ceil(value * 1_000_000))
			? Math.ceil(value * 1_000_000)
			: Number.MAX_SAFE_INTEGER;
	const admission = await createRouteAwareBudgetAdmission(repos, {
		ordinary: {
			requestId: policy.requestId,
			userId: apiKey.userId,
			apiKeyId: apiKey.keyId,
			budgetMax: apiKey.budgetMax,
			expectedBudgetEpoch: apiKey.budgetEpoch,
			estimatedChargedCost: charged,
			now: new Date(policy.start),
		},
		guardrail: {
			intents: policy.guardrail.budgetIntents,
			reservedMicros: micros(charged),
			now: new Date(policy.start),
		},
		privateByokGatewayKey: {
			includeInLimit: apiKey.includeByokInLimit === true,
			reservedMicros: Math.max(
				micros(charged),
				micros(provable ? (estimate.byokStandardCostCeiling ?? estimate.standardCost) : null),
			),
		},
	});
	const terminateUnknown = async (reason: string): Promise<void> => {
		await Promise.all([admission.terminateGuardrailUnknown(reason), admission.ordinaryLease.terminateUnknown(reason)]);
	};
	const options: Pick<
		FailoverDispatchOptions,
		'beforeUpstreamDispatch' | 'registerResourceCompletion' | 'errorContext' | 'byok'
	> = {
		beforeUpstreamDispatch: (route) => admission.beforeUpstreamDispatch(route),
		registerResourceCompletion: (task) => scheduleResourceCompletion(c, task),
		errorContext: { skin: 'chat', requestId: policy.requestId },
		byok: privateByokContextForApiKey(apiKey),
	};
	return {
		admission,
		options,
		terminateUnknown,
		async dispatch<T extends ProxyResult>(operation: () => Promise<T>): Promise<T> {
			try {
				const result = await operation();
				if (admission.ordinaryLease.state === 'reserved')
					await admission.ordinaryLease.releasePreDispatch('native_upstream_not_dispatched');
				if (!admission.guardrailDispatched)
					await admission.releaseGuardrailPreDispatch('native_upstream_not_dispatched');
				return result;
			} catch (error) {
				await terminateUnknown('native_dispatch_failed');
				throw error;
			}
		},
		settlement(result: Pick<ProxyResult, 'meta'>, forceUnknown = false) {
			const unknown =
				forceUnknown || result.meta?.upstreamOutcomeUnknown === true || result.meta?.responseBodyTooLarge === true;
			return {
				requestLogId: policy.requestId,
				budgetAccountedAt: new Date(policy.start).toISOString(),
				guardrailBudgetSettlement: admission.guardrailReserved
					? { requestId: policy.requestId, mode: unknown ? ('reserved' as const) : ('actual' as const) }
					: undefined,
				ordinaryBudgetSettlement:
					admission.ordinaryLease.reserved && admission.ordinaryLease.state === 'dispatched'
						? {
								requestId: policy.requestId,
								budgetEpoch: admission.ordinaryLease.budgetEpoch!,
								reservedMicros: admission.ordinaryLease.reservedMicros,
								unknownCost: unknown,
							}
						: undefined,
			};
		},
	};
}

export async function readNativeMediaMultipart(c: NativeContext): Promise<Record<string, unknown>> {
	const deadline = createRequestDeadline(Date.now() + 120_000, c.req.raw.signal);
	const ingress = ownUpstreamResponse(new Response(c.req.raw.body), deadline.signal);
	scheduleResourceCompletion(c, ingress.resourceCompletion);
	const upload = ingress.response.body ? boundRequestBody(ingress.response.body, deadline, 26 * 1024 * 1024) : null;
	try {
		if (upload) c.req.raw = new Request(c.req.raw, { body: upload.body, duplex: 'half' } as RequestInit);
		return (await c.req.parseBody({ all: true })) as Record<string, unknown>;
	} finally {
		upload?.dispose();
		deadline.dispose();
	}
}
