import type { GatewayRepositories, McpCallableItem } from '@octafuse/core';
import type { ApiKeyContext } from '../../middleware/auth';
import type { ResourceCompletion } from '../resource-completion';
import { EMPTY_USAGE } from '../proxy';
import type { ProxyDispatchResult } from '../failover-dispatch';
import { withNativeMediaDispatch } from '../egress/native-media-lifecycle';
import {
	runToolRequestGuardrails,
	filterToolGuardrailOutput,
	toolGuardrailBudgetMicros,
	dispatchToolGuardrailBudget,
	forfeitToolGuardrailBudgetSafely,
} from '../tool-request-guardrails';
import { reserveRequestGuardrailBudgets, releaseRequestGuardrailBudgets } from '../request-guardrails';
import {
	reserveToolOrdinaryBudget,
	terminateToolOrdinaryBudgetSafely,
	toolUserBudgetSettlement,
	type ChargeToolUsageParams,
} from '../tool-usage-charge';

export type McpInvocation = {
	input: Record<string, unknown>;
	run<T>(operation: (fetchImpl: typeof fetch) => Promise<T>): Promise<T>;
	filter<T>(value: T): Promise<{ ok: true; value: T } | { ok: false; blockedBy: string }>;
	settlement(
		mode: 'actual' | 'reserved',
		reason: string,
	): Pick<
		ChargeToolUsageParams,
		'requestLogId' | 'budgetAccountedAt' | 'guardrailBudgetSettlement' | 'userBudgetSettlement'
	>;
	terminate(reason: string): Promise<void>;
};
export async function prepareMcpInvocation(
	repos: GatewayRepositories,
	apiKey: ApiKeyContext,
	item: McpCallableItem,
	args: Record<string, unknown>,
	chargedCost: number,
	request: Request,
	fetchImpl: typeof fetch,
	register?: (task: ResourceCompletion) => void,
): Promise<McpInvocation> {
	const requestId = crypto.randomUUID();
	const now = new Date();
	const toolId = `mcp:${item.slug}/${item.upstreamKey}`;
	const guardrail = await runToolRequestGuardrails(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		toolId,
		toolProvider: item.slug,
		input: args,
		correlationId: requestId,
		now,
	});
	if (!guardrail.ok) throw new Error(guardrail.message);
	if (!guardrail.body.input || typeof guardrail.body.input !== 'object' || Array.isArray(guardrail.body.input))
		throw new Error('Guardrail produced invalid MCP arguments');
	const ordinary = await reserveToolOrdinaryBudget(repos, {
		requestId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		budgetMax: apiKey.budgetMax,
		budgetEpoch: apiKey.budgetEpoch,
		chargedCost,
		now,
	});
	if (!ordinary.ok) throw new Error(ordinary.error.message);
	let guardrailReserved = false;
	let guardrailDispatched = false;
	let dispatched = false;
	const terminate = async (reason: string) => {
		await terminateToolOrdinaryBudgetSafely(ordinary.lease, reason);
		if (guardrailDispatched)
			await forfeitToolGuardrailBudgetSafely(repos, { requestId, reserved: guardrailReserved, reason });
		else await releaseRequestGuardrailBudgets(repos, requestId, guardrailReserved, reason);
	};
	try {
		const result = await reserveRequestGuardrailBudgets(repos, {
			requestId,
			intents: guardrail.budgetIntents,
			reservedMicros: toolGuardrailBudgetMicros(chargedCost),
			now,
		});
		if (!result.ok) throw new Error(result.message);
		guardrailReserved = result.reserved;
	} catch (error) {
		await terminate('mcp_admission_failed');
		throw error;
	}
	return {
		input: guardrail.body.input as Record<string, unknown>,
		terminate,
		async run<T>(operation: (fetchImpl: typeof fetch) => Promise<T>): Promise<T> {
			let value!: T;
			await withNativeMediaDispatch<ProxyDispatchResult>(
				request.signal,
				{
					timeoutMs: item.timeoutMs,
					trackResourceCompletion: register,
					maxResponseBytes: item.maxResponseBytes,
					fetchImpl,
					beforeUpstreamDispatch: async () => {
						if (dispatched) return;
						await dispatchToolGuardrailBudget(repos, { requestId, reserved: guardrailReserved });
						guardrailDispatched = guardrailReserved;
						try {
							await ordinary.lease.beforeUpstreamDispatch();
							dispatched = true;
						} catch (error) {
							await terminate('mcp_dispatch_not_started');
							throw error;
						}
					},
				},
				async (_signal, options) => {
					value = await operation(options.fetchImpl as typeof fetch);
					return { response: new Response(null), usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: null };
				},
			);
			return value;
		},
		filter: (value) =>
			filterToolGuardrailOutput(repos, {
				workspaceId: apiKey.workspaceId,
				userId: apiKey.userId,
				apiKeyId: apiKey.keyId,
				toolId,
				correlationId: requestId,
				guardrail,
				value,
			}),
		settlement: (mode, reason) => ({
			requestLogId: requestId,
			budgetAccountedAt: now.toISOString(),
			guardrailBudgetSettlement: guardrailReserved ? { requestId, mode, reason } : undefined,
			userBudgetSettlement: toolUserBudgetSettlement(ordinary.lease, mode, reason),
		}),
	};
}
