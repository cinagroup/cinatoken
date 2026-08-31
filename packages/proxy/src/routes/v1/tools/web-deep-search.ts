/**
 * 用户路由：`POST /v1/tools/web-deep-search` — 搜+读一体；成功后按固定单价计入 budget_spent。
 */
import { resolveWebDeepSearchConfig } from '@octafuse/core';
import { Hono } from 'hono';
import type { Env } from '../../../app';
import { requireApiKey } from '../../../middleware/auth';
import { assignGenerationId } from '../../../middleware/generation-id';
import {
	chargeToolUsage,
	reserveToolOrdinaryBudget,
	terminateToolOrdinaryBudgetSafely,
	toolFailureSettlement,
	toolUserBudgetSettlement,
} from '../../../services/tool-usage-charge';
import { reserveRequestGuardrailBudgets } from '../../../services/request-guardrails';
import {
	dispatchToolGuardrailBudget,
	filterToolGuardrailOutput,
	forfeitToolGuardrailBudgetSafely,
	runToolRequestGuardrails,
	toolGuardrailBudgetMicros,
} from '../../../services/tool-request-guardrails';
import {
	clampDeepSearchCount,
	deepSearchByProvider,
	WebDeepSearchProviderError,
} from '@octafuse/tool-engines/web-deep-search';

type ToolsEnv = Env & { Variables: { apiKey: import('../../../middleware/auth').ApiKeyContext } };

export const webDeepSearchRoutes = new Hono<ToolsEnv>();

const TOOL_ID = 'tool:web-deep-search';

webDeepSearchRoutes.use('*', requireApiKey);
webDeepSearchRoutes.use('*', assignGenerationId);

webDeepSearchRoutes.post('/', async (c) => {
	const apiKey = c.get('apiKey');
	const repos = c.get('repositories');
	const requestStartedAt = new Date();
	const requestCorrelationId = c.get('generationId')!;
	const resolved = await resolveWebDeepSearchConfig(repos);
	if (!resolved.ok) {
		if (resolved.reason === 'active_missing_key') {
			console.warn('[Gateway Tools] WEB_DEEP_SEARCH_ACTIVE has no API key', resolved.provider);
			return c.json({ error: 'Web deep search is not configured' }, 503);
		}
		if (resolved.reason === 'invalid_catalog') {
			console.warn('[Gateway Tools] invalid WEB_DEEP_SEARCH_CATALOG');
			return c.json({ error: 'Web deep search provider is misconfigured' }, 503);
		}
		console.warn('[Gateway Tools] invalid WEB_DEEP_SEARCH_ACTIVE', resolved.raw);
		return c.json({ error: 'Web deep search provider is misconfigured' }, 503);
	}

	const {
		provider,
		apiKey: providerApiKey,
		metered: unitMetered,
		standard: unitStandard,
		charged: unitCharged,
	} = resolved.config;
	if (!providerApiKey) {
		return c.json({ error: 'Web deep search is not configured' }, 503);
	}

	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
	const requestedQuery = typeof record.query === 'string' ? record.query.trim() : '';
	if (requestedQuery.length < 2) {
		return c.json({ error: 'query must be at least 2 characters' }, 400);
	}

	const count = typeof record.count === 'number' ? clampDeepSearchCount(record.count) : undefined;
	const guardrail = await runToolRequestGuardrails(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		toolId: TOOL_ID,
		toolProvider: provider,
		input: requestedQuery,
		correlationId: requestCorrelationId,
		now: requestStartedAt,
	});
	if (!guardrail.ok) {
		return c.json({ error: guardrail.message }, guardrail.status);
	}
	const query = typeof guardrail.body.input === 'string' ? guardrail.body.input.trim() : '';
	if (query.length < 2) {
		return c.json({ error: 'query must be at least 2 characters after guardrail processing' }, 400);
	}

	const ordinaryAdmission = await reserveToolOrdinaryBudget(repos, {
		requestId: requestCorrelationId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		budgetMax: apiKey.budgetMax,
		budgetEpoch: apiKey.budgetEpoch,
		chargedCost: unitCharged,
		now: requestStartedAt,
	});
	if (!ordinaryAdmission.ok) return c.json({ error: ordinaryAdmission.error.message }, 403);
	const ordinaryBudgetLease = ordinaryAdmission.lease;
	let admission: Awaited<ReturnType<typeof reserveRequestGuardrailBudgets>>;
	try {
		admission = await reserveRequestGuardrailBudgets(repos, {
			requestId: requestCorrelationId,
			intents: guardrail.budgetIntents,
			reservedMicros: toolGuardrailBudgetMicros(unitCharged),
			now: requestStartedAt,
		});
	} catch (error) {
		await terminateToolOrdinaryBudgetSafely(ordinaryBudgetLease, 'guardrail_budget_admission_failed');
		throw error;
	}
	if (!admission.ok) {
		await terminateToolOrdinaryBudgetSafely(ordinaryBudgetLease, 'guardrail_budget_admission_failed');
		if (admission.blocked) return c.json({ error: admission.message }, 403);
		throw new Error(`Guardrail budget admission failed: ${admission.message}`);
	}
	const guardrailBudgetReserved = admission.reserved;
	let guardrailBudgetDispatched = false;
	try {
		await dispatchToolGuardrailBudget(repos, {
			requestId: requestCorrelationId,
			reserved: guardrailBudgetReserved,
		});
		guardrailBudgetDispatched = guardrailBudgetReserved;
		await ordinaryBudgetLease.beforeUpstreamDispatch();
	} catch (error) {
		await terminateToolOrdinaryBudgetSafely(ordinaryBudgetLease, 'tool_dispatch_not_started');
		if (guardrailBudgetDispatched) {
			await forfeitToolGuardrailBudgetSafely(repos, {
				requestId: requestCorrelationId,
				reserved: true,
				reason: 'ordinary_budget_dispatch_failed',
			});
		}
		throw error;
	}
	const started = Date.now();

	let results: Awaited<ReturnType<typeof deepSearchByProvider>>;
	try {
		results = await deepSearchByProvider(provider, {
			apiKey: providerApiKey,
			query,
			count,
		});
	} catch (err) {
		const latencyMs = Date.now() - started;
		const message = err instanceof Error ? err.message : String(err);
		console.warn('[Gateway Tools] web-deep-search failed', message);
		const settlement = toolFailureSettlement(err);
		let settled = false;
		try {
			await chargeToolUsage({
				repos,
				requestLogId: requestCorrelationId,
				budgetAccountedAt: requestStartedAt.toISOString(),
				guardrailBudgetSettlement: guardrailBudgetReserved
					? {
						requestId: requestCorrelationId,
						mode: settlement.mode,
						reason: settlement.reason,
					}
					: undefined,
				userBudgetSettlement: toolUserBudgetSettlement(
					ordinaryBudgetLease,
					settlement.mode,
					settlement.reason,
				),
				apiKeyId: apiKey.keyId,
				workspaceId: apiKey.workspaceId,
				userId: apiKey.userId,
				userEmail: apiKey.userEmail,
				toolId: TOOL_ID,
				toolProvider: provider,
				meteredCost: 0,
				standardCost: 0,
				chargedCost: 0,
				pricingUnit: 'request',
				billingUnits: 1,
				unitPrices: { metered: unitMetered, standard: unitStandard, charged: unitCharged },
				latencyMs,
				requestBody: JSON.stringify({ query, provider }),
				requestBodyLoggingMode: c.get('requestBodyLoggingMode'),
				errorMessage: message,
				status: 'error',
			});
			settled = true;
		} catch (logErr) {
			console.warn('[Gateway Tools] failed to log web-deep-search error', logErr);
		}
		if (!settled) {
			await forfeitToolGuardrailBudgetSafely(repos, {
				requestId: requestCorrelationId,
				reserved: guardrailBudgetReserved,
				reason: settlement.mode === 'actual' ? 'tool_error_settlement_failed' : settlement.reason,
			});
			await terminateToolOrdinaryBudgetSafely(
				ordinaryBudgetLease,
				settlement.mode === 'actual' ? 'tool_error_settlement_failed' : settlement.reason,
			);
		}

		if (err instanceof WebDeepSearchProviderError) {
			const status = err.status >= 400 && err.status < 600 ? err.status : 502;
			if (status === 401 || status === 403) {
				return c.json({ error: 'Web deep search provider rejected the request' }, 502);
			}
			return c.json({ error: message }, status === 400 ? 400 : 502);
		}
		return c.json({ error: 'Web deep search failed' }, 502);
	}

	const guardedOutput = await filterToolGuardrailOutput(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		toolId: TOOL_ID,
		correlationId: requestCorrelationId,
		guardrail,
		value: results,
	});
	const latencyMs = Date.now() - started;
	let chargedCost: number;
	try {
		({ chargedCost } = await chargeToolUsage({
			repos,
			requestLogId: requestCorrelationId,
			budgetAccountedAt: requestStartedAt.toISOString(),
			guardrailBudgetSettlement: guardrailBudgetReserved
				? { requestId: requestCorrelationId, mode: 'actual', reason: 'tool_request_usage_settled' }
				: undefined,
			userBudgetSettlement: toolUserBudgetSettlement(
				ordinaryBudgetLease,
				'actual',
				'tool_request_usage_settled',
			),
			apiKeyId: apiKey.keyId,
			workspaceId: apiKey.workspaceId,
			userId: apiKey.userId,
			userEmail: apiKey.userEmail,
			toolId: TOOL_ID,
			toolProvider: provider,
			meteredCost: unitMetered,
			standardCost: unitStandard,
			chargedCost: unitCharged,
			pricingUnit: 'request',
			billingUnits: 1,
			unitPrices: { metered: unitMetered, standard: unitStandard, charged: unitCharged },
			latencyMs,
			requestBody: JSON.stringify({ query, provider, count }),
			requestBodyLoggingMode: c.get('requestBodyLoggingMode'),
			responseBody: guardedOutput.ok
				? JSON.stringify({
					result_count: guardedOutput.value.length,
					results: guardedOutput.value.map((r) => ({
						title: r.title,
						url: r.url,
						snippet: r.snippet?.slice(0, 240),
						content_preview: r.content?.slice(0, 240),
					})),
				})
				: JSON.stringify({ guardrail_blocked: true }),
			errorMessage: guardedOutput.ok ? null : 'Response blocked by output guardrail',
			status: guardedOutput.ok ? 'success' : 'error',
			chargeOnError: !guardedOutput.ok,
		}));
	} catch (error) {
		await forfeitToolGuardrailBudgetSafely(repos, {
			requestId: requestCorrelationId,
			reserved: guardrailBudgetReserved,
			reason: 'tool_usage_settlement_failed',
		});
		await terminateToolOrdinaryBudgetSafely(ordinaryBudgetLease, 'tool_usage_settlement_failed');
		throw error;
	}
	if (!guardedOutput.ok) {
		return c.json({ error: 'Response blocked by output guardrail' }, 403);
	}
	return c.json({ data: { results: guardedOutput.value, cost: chargedCost } });
});
