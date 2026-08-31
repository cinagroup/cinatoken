import {
	guardrailBudgetUnits,
	type GatewayRepositories,
	type GuardrailPreflightResult,
} from '@octafuse/core';
import {
	auditGuardrailDecision,
	auditGuardrailOutputDecision,
	filterGuardrailResponse,
	forfeitRequestGuardrailBudgets,
	markRequestGuardrailBudgetsDispatched,
	releaseRequestGuardrailBudgets,
	runRequestGuardrails,
} from './request-guardrails';

export type GuardedToolOutput<T> =
	| { ok: true; value: T; redactionCount: number }
	| { ok: false; blockedBy: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function providerRemainsAllowed(body: Record<string, unknown>, provider: string): boolean {
	if (!isRecord(body.provider) || !Array.isArray(body.provider.only)) return false;
	return body.provider.only.some(
		(value) => typeof value === 'string' && value.toLowerCase() === provider.toLowerCase(),
	);
}

/**
 * Tools participate in model/provider policy through stable pseudo model ids
 * (`tool:web-search`, etc.). Only user content is projected into `input`; tool
 * controls remain outside the shared prompt scanner.
 */
export async function runToolRequestGuardrails(
	repositories: GatewayRepositories,
	params: {
		workspaceId: string;
		userId: string;
		apiKeyId: string;
		toolId: string;
		toolProvider: string;
		input: unknown;
		correlationId: string;
		now: Date;
	},
): Promise<GuardrailPreflightResult> {
	const result = await runRequestGuardrails(repositories, {
		workspaceId: params.workspaceId,
		userId: params.userId,
		apiKeyId: params.apiKeyId,
		modelIds: [params.toolId],
		body: {
			model: params.toolId,
			provider: { only: [params.toolProvider] },
			input: params.input,
		},
		correlationId: params.correlationId,
		now: params.now,
	});
	if (!result.ok) return result;
	const providerAllowed = providerRemainsAllowed(result.body, params.toolProvider);
	if (providerAllowed && !result.requireZdr) return result;

	// Tools have no model router to consume `provider.only`, so verify the fixed
	// provider explicitly. They also lack route-level, auditable ZDR capability.
	const blocked: GuardrailPreflightResult = {
		ok: false,
		status: 403,
		code: 'guardrail_blocked',
		message: providerAllowed
			? 'Request blocked because this tool cannot guarantee zero data retention'
			: 'Request blocked by provider policy',
		trace: result.trace,
	};
	await auditGuardrailDecision(repositories, {
		workspaceId: params.workspaceId,
		userId: params.userId,
		apiKeyId: params.apiKeyId,
		modelIds: [params.toolId],
		correlationId: params.correlationId,
		result: blocked,
	});
	return blocked;
}

/** Fixed tool prices are authoritative, so only integer conversion needs a ceiling. */
export function toolGuardrailBudgetMicros(chargedCost: number): number {
	if (chargedCost === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
	const micros = guardrailBudgetUnits(chargedCost, 'ceiling');
	return Number.isSafeInteger(micros) ? micros : Number.MAX_SAFE_INTEGER;
}

/** Transfer a reservation to the upstream path, releasing it if dispatch never starts. */
export async function dispatchToolGuardrailBudget(
	repositories: GatewayRepositories,
	params: { requestId: string; reserved: boolean; now?: Date },
): Promise<void> {
	try {
		await markRequestGuardrailBudgetsDispatched(
			repositories,
			params.requestId,
			params.reserved,
			params.now,
		);
	} catch (error) {
		await releaseRequestGuardrailBudgets(
			repositories,
			params.requestId,
			params.reserved,
			'upstream_dispatch_not_started',
		).catch((releaseError: unknown) => {
			console.error(
				`[Gateway Tools] guardrail budget release failed requestId=${params.requestId} error=${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
			);
		});
		throw error;
	}
}

/** Unknown post-dispatch outcomes conservatively consume the fixed reservation. */
export async function forfeitToolGuardrailBudgetSafely(
	repositories: GatewayRepositories,
	params: { requestId: string; reserved: boolean; reason: string },
): Promise<void> {
	try {
		await forfeitRequestGuardrailBudgets(
			repositories,
			params.requestId,
			params.reserved,
			params.reason,
		);
	} catch (error) {
		console.error(
			`[Gateway Tools] guardrail budget forfeit failed requestId=${params.requestId} reason=${params.reason} error=${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Apply bounded JSON output policies before a tool result is returned or logged. */
export async function filterToolGuardrailOutput<T>(
	repositories: GatewayRepositories,
	params: {
		workspaceId: string;
		userId: string;
		apiKeyId: string;
		toolId: string;
		correlationId: string;
		guardrail: Extract<GuardrailPreflightResult, { ok: true }>;
		value: T;
	},
): Promise<GuardedToolOutput<T>> {
	if (params.guardrail.outputFilters.length === 0) {
		return { ok: true, value: params.value, redactionCount: 0 };
	}

	let blockedBy: string | null = null;
	let redactionCount = 0;
	let value: T | null = null;
	try {
		const filtered = await filterGuardrailResponse(
			Response.json(params.value),
			params.guardrail.outputFilters,
		);
		blockedBy = filtered.blockedBy;
		redactionCount = filtered.redactionCount;
		if (!blockedBy) value = await filtered.response.json() as T;
	} catch (error) {
		blockedBy = 'output_filter_failed';
		console.error(
			`[Gateway Tools] output guardrail failed requestId=${params.correlationId} error=${error instanceof Error ? error.message : String(error)}`,
		);
	}

	try {
		await auditGuardrailOutputDecision(repositories, {
			workspaceId: params.workspaceId,
			userId: params.userId,
			apiKeyId: params.apiKeyId,
			modelIds: [params.toolId],
			correlationId: params.correlationId,
			trace: params.guardrail.trace,
			blockedBy,
			redactionCount,
		});
	} catch (error) {
		// Match model routes: audit failure must not lose known billable usage.
		console.error(
			`[Gateway Tools] output guardrail audit failed requestId=${params.correlationId} error=${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (blockedBy || value === null) {
		return { ok: false, blockedBy: blockedBy ?? 'output_filter_failed' };
	}
	return { ok: true, value, redactionCount };
}
