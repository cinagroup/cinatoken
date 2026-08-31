/**
 * 用户路由：`POST /v1/tools/web-search` — 联网搜索工具；成功后按固定单价计入 budget_spent。
 * 引擎/密钥/单价读自 `system_config`（见 `resolveWebSearchConfig`）。
 */
import { resolveWebSearchConfig } from '@octafuse/core';
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
import {
	searchWebByProvider,
	WebSearchProviderError,
} from '@octafuse/tool-engines/web-search';
import { reserveRequestGuardrailBudgets } from '../../../services/request-guardrails';
import {
	dispatchToolGuardrailBudget,
	filterToolGuardrailOutput,
	forfeitToolGuardrailBudgetSafely,
	runToolRequestGuardrails,
	toolGuardrailBudgetMicros,
} from '../../../services/tool-request-guardrails';

type ToolsEnv = Env & { Variables: { apiKey: import('../../../middleware/auth').ApiKeyContext } };

export const webSearchRoutes = new Hono<ToolsEnv>();

const TOOL_ID = 'tool:web-search';

webSearchRoutes.use('*', requireApiKey);
webSearchRoutes.use('*', assignGenerationId);

const MAX_WEB_SEARCH_DOMAINS = 30;
const MAX_WEB_SEARCH_DOMAIN_LENGTH = 253;

type WebSearchProviderInput = {
	query: string;
	allowedDomains?: string[];
	blockedDomains?: string[];
};

type WebSearchProviderInputResult =
	| { ok: true; value: WebSearchProviderInput }
	| { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeDomain(value: string): string | null {
	const candidate = value.trim();
	if (!candidate || candidate.length > MAX_WEB_SEARCH_DOMAIN_LENGTH * 2) return null;
	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(candidate);
	if (hasScheme && !/^https?:\/\//iu.test(candidate)) return null;
	let parsed: URL;
	try {
		parsed = new URL(hasScheme ? candidate : `https://${candidate}`);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
	if (parsed.username || parsed.password || parsed.port) return null;
	const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '');
	if (!hostname || hostname.length > MAX_WEB_SEARCH_DOMAIN_LENGTH) return null;
	const labels = hostname.split('.');
	if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label))) {
		return null;
	}
	return hostname;
}

function parseDomainArray(
	value: unknown,
	field: 'allowed_domains' | 'blocked_domains',
): { ok: true; value: string[] | undefined } | { ok: false; error: string } {
	if (value === undefined) return { ok: true, value: undefined };
	if (!Array.isArray(value) || value.length > MAX_WEB_SEARCH_DOMAINS) {
		return { ok: false, error: `${field} must be an array of at most ${MAX_WEB_SEARCH_DOMAINS} domains` };
	}
	const domains: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string' || !item.trim()) {
			return { ok: false, error: `${field} must contain only non-empty domain strings` };
		}
		const domain = normalizeDomain(item);
		if (!domain) return { ok: false, error: `${field} contains an invalid domain` };
		if (!domains.includes(domain)) domains.push(domain);
	}
	return { ok: true, value: domains.length > 0 ? domains : undefined };
}

/** Validate both the public request and the post-Guardrail provider projection. */
export function parseWebSearchProviderInput(value: unknown): WebSearchProviderInputResult {
	if (!isRecord(value)) return { ok: false, error: 'Request body must be a JSON object' };
	const query = typeof value.query === 'string' ? value.query.trim() : '';
	if (query.length < 2) return { ok: false, error: 'query must be at least 2 characters' };
	const allowed = parseDomainArray(value.allowed_domains, 'allowed_domains');
	if (!allowed.ok) return allowed;
	const blocked = parseDomainArray(value.blocked_domains, 'blocked_domains');
	if (!blocked.ok) return blocked;
	if (allowed.value?.length && blocked.value?.length) {
		return { ok: false, error: 'Cannot specify both allowed_domains and blocked_domains' };
	}
	return {
		ok: true,
		value: {
			query,
			...(allowed.value ? { allowedDomains: allowed.value } : {}),
			...(blocked.value ? { blockedDomains: blocked.value } : {}),
		},
	};
}

webSearchRoutes.post('/', async (c) => {
	const apiKey = c.get('apiKey');
	const repos = c.get('repositories');
	const requestStartedAt = new Date();
	const requestCorrelationId = c.get('generationId')!;
	const resolved = await resolveWebSearchConfig(repos);
	if (!resolved.ok) {
		if (resolved.reason === 'active_missing_key') {
			console.warn('[Gateway Tools] WEB_SEARCH_ACTIVE has no API key', resolved.provider);
			return c.json({ error: 'Web search is not configured' }, 503);
		}
		if (resolved.reason === 'invalid_catalog') {
			console.warn('[Gateway Tools] invalid WEB_SEARCH_CATALOG');
			return c.json({ error: 'Web search provider is misconfigured' }, 503);
		}
		console.warn('[Gateway Tools] invalid WEB_SEARCH_ACTIVE', resolved.raw);
		return c.json({ error: 'Web search provider is misconfigured' }, 503);
	}

	const {
		provider,
		apiKey: providerApiKey,
		metered: unitMetered,
		standard: unitStandard,
		charged: unitCharged,
	} = resolved.config;
	if (!providerApiKey) {
		return c.json({ error: 'Web search is not configured' }, 503);
	}

	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	const record = isRecord(body) ? body : {};
	const requestedInput = parseWebSearchProviderInput(record);
	if (!requestedInput.ok) return c.json({ error: requestedInput.error }, 400);
	const count = typeof record.count === 'number' ? record.count : undefined;
	const guardrail = await runToolRequestGuardrails(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		toolId: TOOL_ID,
		toolProvider: provider,
		input: {
			query: requestedInput.value.query,
			...(requestedInput.value.allowedDomains
				? { allowed_domains: requestedInput.value.allowedDomains }
				: {}),
			...(requestedInput.value.blockedDomains
				? { blocked_domains: requestedInput.value.blockedDomains }
				: {}),
		},
		correlationId: requestCorrelationId,
		now: requestStartedAt,
	});
	if (!guardrail.ok) {
		return c.json({ error: guardrail.message }, guardrail.status);
	}
	const guardedInput = parseWebSearchProviderInput(guardrail.body.input);
	if (!guardedInput.ok) {
		return c.json({ error: `${guardedInput.error} after guardrail processing` }, 400);
	}
	const { query, allowedDomains, blockedDomains } = guardedInput.value;

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

	let results: Awaited<ReturnType<typeof searchWebByProvider>>;
	try {
		results = await searchWebByProvider(provider, {
			apiKey: providerApiKey,
			query,
			count,
			allowedDomains,
			blockedDomains,
		});
	} catch (err) {
		const latencyMs = Date.now() - started;
		const message = err instanceof Error ? err.message : String(err);
		console.warn('[Gateway Tools] web-search failed', message);
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
			console.warn('[Gateway Tools] failed to log web-search error', logErr);
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

		if (err instanceof WebSearchProviderError) {
			const status = err.status >= 400 && err.status < 600 ? err.status : 502;
			// 勿把引擎 401 原样透出为「用户 Key 无效」
			if (status === 401 || status === 403) {
				return c.json({ error: 'Web search provider rejected the request' }, 502);
			}
			return c.json({ error: message }, status === 400 ? 400 : 502);
		}
		return c.json({ error: 'Web search failed' }, 502);
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
			requestBody: JSON.stringify({
				query,
				provider,
				allowed_domains: allowedDomains,
				blocked_domains: blockedDomains,
				count,
			}),
			requestBodyLoggingMode: c.get('requestBodyLoggingMode'),
			responseBody: guardedOutput.ok
				? JSON.stringify({
					result_count: guardedOutput.value.length,
					results: guardedOutput.value.map((r) => ({
						title: r.title,
						url: r.url,
						snippet: r.snippet?.slice(0, 240) || r.summary?.slice(0, 240) || undefined,
						siteName: r.siteName,
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
			results: guardedOutput.value,
			// 单位随 Gateway `BILLING_CURRENCY`（USD/CNY…），非固定美元
			cost: chargedCost,
		},
	});
});
