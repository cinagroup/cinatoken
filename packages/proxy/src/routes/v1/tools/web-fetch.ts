/**
 * 用户路由：`POST /v1/tools/web-fetch` — 网页抓取工具；成功后按固定单价计入 budget_spent。
 * 引擎/密钥/单价读自 `system_config`（见 `resolveWebFetchConfig`）。
 */
import { resolveWebFetchConfig } from '@octafuse/core';
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
	assertFetchUrlSafe,
	fetchUrlByProvider,
	WebFetchProviderError,
} from '@octafuse/tool-engines/web-fetch';
import { finalizeRequestLogJson } from '../../../services/request-log-shared';
import {
	webFetchErrorForLog,
	webFetchRequestBodyForLog,
	webFetchResponseBodyForLog,
} from '../../../services/web-fetch-log';

type ToolsEnv = Env & { Variables: { apiKey: import('../../../middleware/auth').ApiKeyContext } };

export const webFetchRoutes = new Hono<ToolsEnv>();

const TOOL_ID = 'tool:web-fetch';

webFetchRoutes.use('*', requireApiKey);
webFetchRoutes.use('*', assignGenerationId);

webFetchRoutes.post('/', async (c) => {
	const apiKey = c.get('apiKey');
	const repos = c.get('repositories');
	const requestStartedAt = new Date();
	const requestCorrelationId = c.get('generationId')!;
	const resolved = await resolveWebFetchConfig(repos);
	if (!resolved.ok) {
		if (resolved.reason === 'active_missing_key') {
			console.warn('[Gateway Tools] WEB_FETCH_ACTIVE has no API key', resolved.provider);
			return c.json({ error: 'Web fetch is not configured' }, 503);
		}
		if (resolved.reason === 'invalid_catalog') {
			console.warn('[Gateway Tools] invalid WEB_FETCH_CATALOG');
			return c.json({ error: 'Web fetch provider is misconfigured' }, 503);
		}
		console.warn('[Gateway Tools] invalid WEB_FETCH_ACTIVE', resolved.raw);
		return c.json({ error: 'Web fetch provider is misconfigured' }, 503);
	}

	const {
		provider,
		apiKey: providerApiKey,
		metered: unitMetered,
		standard: unitStandard,
		charged: unitCharged,
	} = resolved.config;
	if (!providerApiKey) {
		return c.json({ error: 'Web fetch is not configured' }, 503);
	}

	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
	const urlRaw = typeof record.url === 'string' ? record.url : '';
	const requestedUrl = assertFetchUrlSafe(urlRaw);
	if (!requestedUrl.ok) {
		return c.json({ error: requestedUrl.error }, 400);
	}

	const guardrail = await runToolRequestGuardrails(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		toolId: TOOL_ID,
		toolProvider: provider,
		input: requestedUrl.url,
		correlationId: requestCorrelationId,
		now: requestStartedAt,
	});
	if (!guardrail.ok) {
		return c.json({ error: guardrail.message }, guardrail.status);
	}
	const guardedInput = typeof guardrail.body.input === 'string' ? guardrail.body.input : '';
	const guarded = assertFetchUrlSafe(guardedInput);
	if (!guarded.ok) {
		return c.json({ error: 'URL is invalid after guardrail processing' }, 400);
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
	if (!ordinaryAdmission.ok) {
		return c.json({ error: ordinaryAdmission.error.message }, 403);
	}
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

	let result: Awaited<ReturnType<typeof fetchUrlByProvider>>;
	try {
		result = await fetchUrlByProvider(provider, {
			apiKey: providerApiKey,
			url: guarded.url,
		});
	} catch (err) {
		const latencyMs = Date.now() - started;
		const message = err instanceof Error ? err.message : String(err);
		const errorNameForLog = webFetchErrorForLog(err);
		console.warn('[Gateway Tools] web-fetch failed', errorNameForLog);
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
				requestBody: webFetchRequestBodyForLog(guarded.url, provider),
				requestBodyLoggingMode: c.get('requestBodyLoggingMode'),
				errorMessage: errorNameForLog,
				status: 'error',
			});
			settled = true;
		} catch (logErr) {
			console.warn('[Gateway Tools] failed to log web-fetch error', logErr);
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

		if (err instanceof WebFetchProviderError) {
			const status = err.status >= 400 && err.status < 600 ? err.status : 502;
			// 勿把引擎 401 原样透出为「用户 Key 无效」
			if (status === 401 || status === 403) {
				return c.json({ error: 'Web fetch provider rejected the request' }, 502);
			}
			return c.json({ error: message }, status === 400 ? 400 : 502);
		}
		return c.json({ error: 'Web fetch failed' }, 502);
	}

	const guardedOutput = await filterToolGuardrailOutput(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		toolId: TOOL_ID,
		correlationId: requestCorrelationId,
		guardrail,
		value: result,
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
			requestBody: webFetchRequestBodyForLog(guarded.url, provider),
			requestBodyLoggingMode: c.get('requestBodyLoggingMode'),
			responseBody: guardedOutput.ok
				? webFetchResponseBodyForLog(guardedOutput.value)
				: finalizeRequestLogJson({ guardrail_blocked: true }),
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
	return c.json({
		data: {
			url: guardedOutput.value.url,
			title: guardedOutput.value.title,
			content: guardedOutput.value.content,
			// 单位随 Gateway `BILLING_CURRENCY`（USD/CNY…），非固定美元
			cost: chargedCost,
		},
	});
});
