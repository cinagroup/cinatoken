import assert from 'node:assert/strict';
import test from 'node:test';
import { readToolsPricing } from './pricing';

test('public Tools pricing reads all four families and currency in exactly one snapshot', async () => {
	let reads = 0;
	const values: Record<string, string> = {
		BILLING_CURRENCY: 'CNY',
		WEB_SEARCH_PROVIDER: 'tavily', WEB_SEARCH_API_KEY: 'fixture-search', WEB_SEARCH_COST: '0.031',
		WEB_FETCH_PROVIDER: 'firecrawl', WEB_FETCH_API_KEY: 'fixture-fetch', WEB_FETCH_COST: '0.042',
		WEB_DEEP_SEARCH_ACTIVE: 'firecrawl',
		WEB_DEEP_SEARCH_CATALOG: JSON.stringify({ firecrawl: { apiKey: 'fixture-deep', metered: 0.053, standard: 0.064, charged: 0.075 } }),
		AI_DETECTION_ACTIVE: 'tencent_tms',
		AI_DETECTION_CATALOG: JSON.stringify({ tencent_tms: { secretId: 'fixture-id', secretKey: 'fixture-key', metered: 0.086, standard: 0.097, charged: 0.108, billingUnitChars: 2345 } }),
	};
	const result = await readToolsPricing({
		async getConfigSnapshots(keys) {
			reads += 1;
			assert.equal(keys.length, 15);
			assert.deepEqual(keys, [...keys].sort());
			assert.equal(new Set(keys).size, 15);
			assert.equal(keys.filter((key) => key === 'BILLING_CURRENCY').length, 1);
			return keys.map((key) => ({ key, value: values[key] ?? null, revision: values[key] === undefined ? null : 'legacy' }));
		},
	});
	assert.equal(reads, 1);
	assert.equal(result.billing_currency, 'CNY');
	assert.deepEqual(result.tools, [
		{ id: 'web-search', unit: 'request', metered: 0.031, standard: 0.031, charged: 0.031, cost: 0.031 },
		{ id: 'web-fetch', unit: 'request', metered: 0.042, standard: 0.042, charged: 0.042, cost: 0.042 },
		{ id: 'web-deep-search', unit: 'request', metered: 0.053, standard: 0.064, charged: 0.075, cost: 0.075 },
		{ id: 'ai-detection', unit: 'chars', unit_chars: 2345, metered: 0.086, standard: 0.097, charged: 0.108, cost: 0.108 },
	]);
	assert.doesNotMatch(JSON.stringify(result), /fixture-|secret|apiKey|tavily|tencent_tms/u);
});

test('public pricing snapshot failures and missing family rows fail without fallback reads', async () => {
	let reads = 0;
	await assert.rejects(readToolsPricing({ async getConfigSnapshots() { reads += 1; throw new Error('unavailable'); } }), /unavailable/u);
	assert.equal(reads, 1);
	await assert.rejects(readToolsPricing({ async getConfigSnapshots() { return []; } }), /Invalid config group contract/u);
});
