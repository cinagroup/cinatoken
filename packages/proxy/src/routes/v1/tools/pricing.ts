/**
 * 用户路由：`GET /v1/tools/pricing` — 只读工具定价（不含 provider 密钥与 Active 引擎名）。
 * 返回三账本单价；`cost` 为 charged 兼容别名。
 */
import {
	BILLING_CURRENCY_KEY,
	DEFAULT_AI_DETECTION_BILLING_UNIT_CHARS,
	DEFAULT_AI_DETECTION_COST,
	DEFAULT_WEB_DEEP_SEARCH_COST,
	DEFAULT_WEB_FETCH_COST,
	DEFAULT_WEB_SEARCH_COST,
	normalizeBillingCurrencyCode,
	resolveAiDetectionConfigFromSnapshots,
	resolveWebDeepSearchConfigFromSnapshots,
	resolveWebFetchConfigFromSnapshots,
	resolveWebSearchConfigFromSnapshots,
	TOOL_CONFIG_FAMILY_KEYS,
	roundGatewayMoney,
} from '@octafuse/core';
import type { SystemConfigRepository } from '@octafuse/core';
import { Hono } from 'hono';
import type { Env } from '../../../app';
import { requireApiKey } from '../../../middleware/auth';

type ToolsEnv = Env & { Variables: { apiKey: import('../../../middleware/auth').ApiKeyContext } };

export const toolsPricingRoutes = new Hono<ToolsEnv>();

toolsPricingRoutes.use('*', requireApiKey);

type ToolPricingRow =
	| { id: string; unit: 'request'; cost: number; metered: number; standard: number; charged: number }
	| {
			id: string;
			unit: 'chars';
			unit_chars: number;
			cost: number;
			metered: number;
			standard: number;
			charged: number;
	  };

function tripleOrDefault(config: {
	metered: number;
	standard: number;
	charged: number;
} | null, defaultCost: number) {
	if (!config) {
		const d = roundGatewayMoney(defaultCost);
		return { metered: d, standard: d, charged: d, cost: d };
	}
	return {
		metered: config.metered,
		standard: config.standard,
		charged: config.charged,
		cost: config.charged,
	};
}

const TOOLS_PRICING_KEYS = [...new Set(Object.values(TOOL_CONFIG_FAMILY_KEYS).flat())].sort();

/** Currency and every family price must describe the same database snapshot. */
export async function readToolsPricing(systemConfig: Pick<SystemConfigRepository, 'getConfigSnapshots'>) {
	const snapshots = await systemConfig.getConfigSnapshots(TOOLS_PRICING_KEYS);
	const billingRaw = snapshots.find((row) => row.key === BILLING_CURRENCY_KEY)?.value;
	const webSearch = resolveWebSearchConfigFromSnapshots(snapshots);
	const webFetch = resolveWebFetchConfigFromSnapshots(snapshots);
	const webDeepSearch = resolveWebDeepSearchConfigFromSnapshots(snapshots);
	const aiDetection = resolveAiDetectionConfigFromSnapshots(snapshots);

	const searchPrices = tripleOrDefault(webSearch.ok ? webSearch.config : null, DEFAULT_WEB_SEARCH_COST);
	const fetchPrices = tripleOrDefault(webFetch.ok ? webFetch.config : null, DEFAULT_WEB_FETCH_COST);
	const deepPrices = tripleOrDefault(webDeepSearch.ok ? webDeepSearch.config : null, DEFAULT_WEB_DEEP_SEARCH_COST);
	const detectPrices = tripleOrDefault(aiDetection.ok ? aiDetection.config : null, DEFAULT_AI_DETECTION_COST);

	const tools: ToolPricingRow[] = [
		{
			id: 'web-search',
			unit: 'request',
			...searchPrices,
		},
		{
			id: 'web-fetch',
			unit: 'request',
			...fetchPrices,
		},
		{
			id: 'web-deep-search',
			unit: 'request',
			...deepPrices,
		},
		{
			id: 'ai-detection',
			unit: 'chars',
			unit_chars: aiDetection.ok
				? aiDetection.config.billingUnitChars
				: DEFAULT_AI_DETECTION_BILLING_UNIT_CHARS,
			...detectPrices,
		},
	];

	return { billing_currency: normalizeBillingCurrencyCode(billingRaw), tools };
}

toolsPricingRoutes.get('/', async (c) => {
	return c.json({ data: await readToolsPricing(c.get('repositories').systemConfig) });
});
