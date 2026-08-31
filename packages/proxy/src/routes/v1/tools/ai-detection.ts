/**
 * 用户路由：`POST /v1/tools/ai-detection` — AI 率检测；按计费单元数 × 单价计入 budget_spent。
 * 引擎/凭证/单价读自 `system_config`（见 `resolveAiDetectionConfig`）。
 */
import { resolveAiDetectionConfig, roundGatewayMoney, scaleToolUnitPrices } from '@octafuse/core';
import { Hono } from 'hono';
import type { Env } from '../../../app';
import { requireApiKey } from '../../../middleware/auth';
import { assignGenerationId } from '../../../middleware/generation-id';
import {
	AiDetectionProviderError,
	detectAiRate,
	getAiDetectionDriver,
} from '@octafuse/tool-engines/ai-detection';
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

type ToolsEnv = Env & { Variables: { apiKey: import('../../../middleware/auth').ApiKeyContext } };

export const aiDetectionRoutes = new Hono<ToolsEnv>();

const TOOL_ID = 'tool:ai-detection';

aiDetectionRoutes.use('*', requireApiKey);
aiDetectionRoutes.use('*', assignGenerationId);

aiDetectionRoutes.post('/', async (c) => {
	const apiKey = c.get('apiKey');
	const repos = c.get('repositories');
	const requestStartedAt = new Date();
	const requestCorrelationId = c.get('generationId')!;
	const resolved = await resolveAiDetectionConfig(repos);
	if (!resolved.ok) {
		if (resolved.reason === 'active_missing_key') {
			console.warn('[Gateway Tools] AI_DETECTION_ACTIVE has no credentials', resolved.provider);
			return c.json({ error: 'AI detection is not configured' }, 503);
		}
		if (resolved.reason === 'provider_not_implemented') {
			console.warn('[Gateway Tools] AI_DETECTION_ACTIVE not implemented', resolved.provider);
			return c.json({ error: 'AI detection provider is misconfigured' }, 503);
		}
		if (resolved.reason === 'invalid_catalog') {
			console.warn('[Gateway Tools] invalid AI_DETECTION_CATALOG');
			return c.json({ error: 'AI detection provider is misconfigured' }, 503);
		}
		console.warn('[Gateway Tools] invalid AI_DETECTION_ACTIVE', resolved.raw);
		return c.json({ error: 'AI detection provider is misconfigured' }, 503);
	}

	const {
		provider,
		metered: unitMetered,
		standard: unitStandard,
		charged: unitCharged,
		billingUnitChars,
	} = resolved.config;
	const driver = getAiDetectionDriver(provider);
	if (!driver) {
		console.warn('[Gateway Tools] AI detection driver missing', provider);
		return c.json({ error: 'AI detection provider is misconfigured' }, 503);
	}

	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
	const text = typeof record.text === 'string' ? record.text : '';
	const requestedText = text.trim();
	if (!requestedText) {
		return c.json({ error: 'text is required' }, 400);
	}

	const guardrail = await runToolRequestGuardrails(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		toolId: TOOL_ID,
		toolProvider: provider,
		input: requestedText,
		correlationId: requestCorrelationId,
		now: requestStartedAt,
	});
	if (!guardrail.ok) {
		return c.json({ error: guardrail.message }, guardrail.status);
	}
	const trimmed = typeof guardrail.body.input === 'string' ? guardrail.body.input.trim() : '';
	if (!trimmed) {
		return c.json({ error: 'text is required after guardrail processing' }, 400);
	}

	const totalChars = [...trimmed].length;
	const billingUnits = Math.max(1, Math.ceil(totalChars / billingUnitChars));
	const unitPrices = { metered: unitMetered, standard: unitStandard, charged: unitCharged };
	const totals = scaleToolUnitPrices(unitPrices, billingUnits);
	const totalCharged = roundGatewayMoney(totals.charged);

	const ordinaryAdmission = await reserveToolOrdinaryBudget(repos, {
		requestId: requestCorrelationId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		budgetMax: apiKey.budgetMax,
		budgetEpoch: apiKey.budgetEpoch,
		chargedCost: totalCharged,
		now: requestStartedAt,
	});
	if (!ordinaryAdmission.ok) return c.json({ error: ordinaryAdmission.error.message }, 403);
	const ordinaryBudgetLease = ordinaryAdmission.lease;
	let admission: Awaited<ReturnType<typeof reserveRequestGuardrailBudgets>>;
	try {
		admission = await reserveRequestGuardrailBudgets(repos, {
			requestId: requestCorrelationId,
			intents: guardrail.budgetIntents,
			reservedMicros: toolGuardrailBudgetMicros(totalCharged),
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
	const logRequestBody = JSON.stringify({ total_chars: totalChars, billing_units: billingUnits, provider });

	let result: Awaited<ReturnType<typeof detectAiRate>>;
	try {
		result = await detectAiRate(trimmed, driver, resolved.config);
	} catch (err) {
		const latencyMs = Date.now() - started;
		const message = err instanceof Error ? err.message : String(err);
		console.warn('[Gateway Tools] ai-detection failed', message);

		const settlement = toolFailureSettlement(err, { knownLocalFailure: message === 'EMPTY_CONTENT' });
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
				pricingUnit: 'chars',
				billingUnits,
				unitPrices,
				latencyMs,
				requestBody: logRequestBody,
				requestBodyLoggingMode: c.get('requestBodyLoggingMode'),
				errorMessage: message,
				status: 'error',
			});
			settled = true;
		} catch (logErr) {
			console.warn('[Gateway Tools] failed to log ai-detection error', logErr);
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

		if (message === 'EMPTY_CONTENT') {
			return c.json({ error: 'text is required' }, 400);
		}
		if (err instanceof AiDetectionProviderError) {
			const status = err.status >= 400 && err.status < 600 ? err.status : 502;
			if (status === 401 || status === 403) {
				return c.json({ error: 'AI detection provider rejected the request' }, 502);
			}
			return c.json({ error: message }, status === 400 ? 400 : 502);
		}
		return c.json({ error: 'AI detection failed' }, 502);
	}

	const output = {
		overall_score: result.overallScore,
		total_chars: result.totalChars,
		segments: result.segments.map((segment) => ({
			index: segment.index,
			chars: segment.chars,
			score: segment.score,
			excerpt: segment.excerpt,
		})),
		billing_units: billingUnits,
	};
	const guardedOutput = await filterToolGuardrailOutput(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		toolId: TOOL_ID,
		correlationId: requestCorrelationId,
		guardrail,
		value: output,
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
			meteredCost: totals.metered,
			standardCost: totals.standard,
			chargedCost: totals.charged,
			pricingUnit: 'chars',
			billingUnits,
			unitPrices,
			latencyMs,
			requestBody: logRequestBody,
			requestBodyLoggingMode: c.get('requestBodyLoggingMode'),
			// 仅分数汇总，不含 excerpt / 原文
			responseBody: guardedOutput.ok
				? JSON.stringify({
					overall_score: guardedOutput.value.overall_score,
					total_chars: guardedOutput.value.total_chars,
					billing_units: guardedOutput.value.billing_units,
					segment_count: guardedOutput.value.segments.length,
					segments: guardedOutput.value.segments.map((segment) => ({
						index: segment.index,
						chars: segment.chars,
						score: segment.score,
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
	return c.json({
		data: {
			...guardedOutput.value,
			// 单位随 Gateway `BILLING_CURRENCY`
			cost: chargedCost,
		},
	});
});
