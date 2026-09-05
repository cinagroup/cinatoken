import type { PublicModelAnalyticsRow } from '@octafuse/core';
import type { CatalogDiscoveryModel } from './catalog-discovery';

export const PUBLIC_STATS_MINIMUM_SAMPLE_SIZE = 20;

export type PublicModelStats = {
	id: string;
	slug: string;
	display_name: string;
	vendor: string;
	request_count: number;
	success_rate: number;
	avg_latency_ms: number | null;
	output_tokens: number;
	total_tokens: number;
};

function finiteNonNegative(value: unknown): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function finiteNonNegativeSafeInteger(value: unknown): number | null {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Weekly popularity scores from pre-aggregated rows; unsafe or low-volume facts stay private. */
export function privacyQualifiedWeeklyTokenTotals(
	rows: PublicModelAnalyticsRow[],
	minimumSampleSize = PUBLIC_STATS_MINIMUM_SAMPLE_SIZE,
): Map<string, number> {
	const grouped = new Map<string, { requests: number; totalTokens: number; valid: boolean }>();
	for (const row of rows) {
		if (!row.model_id) continue;
		const requests = finiteNonNegativeSafeInteger(row.request_count);
		const totalTokens = finiteNonNegativeSafeInteger(row.total_tokens);
		const entry = grouped.get(row.model_id) ?? { requests: 0, totalTokens: 0, valid: true };
		if (
			requests === null
			|| totalTokens === null
			|| !Number.isSafeInteger(entry.requests + requests)
			|| !Number.isSafeInteger(entry.totalTokens + totalTokens)
		) {
			entry.valid = false;
		} else {
			entry.requests += requests;
			entry.totalTokens += totalTokens;
		}
		grouped.set(row.model_id, entry);
	}
	return new Map([...grouped.entries()].flatMap(([modelId, aggregate]) => (
		aggregate.valid && aggregate.requests >= minimumSampleSize
			? [[modelId, aggregate.totalTokens] as const]
			: []
	)));
}

/** Privacy-safe public telemetry derived from aggregate rows only. */
export function aggregatePublicModelStats(
	models: CatalogDiscoveryModel[],
	rows: PublicModelAnalyticsRow[],
	minimumSampleSize = PUBLIC_STATS_MINIMUM_SAMPLE_SIZE,
): PublicModelStats[] {
	const published = new Map(models.map((model) => [model.id, model]));
	const grouped = new Map<string, { requests: number; successes: number; outputTokens: number; totalTokens: number; latencyWeight: number; latencySamples: number }>();
	for (const row of rows) {
		if (!row.model_id || !published.has(row.model_id)) continue;
		const requests = finiteNonNegative(row.request_count);
		const entry = grouped.get(row.model_id) ?? { requests: 0, successes: 0, outputTokens: 0, totalTokens: 0, latencyWeight: 0, latencySamples: 0 };
		entry.requests += requests;
		entry.successes += Math.min(requests, finiteNonNegative(row.success_count));
		entry.outputTokens += finiteNonNegative(row.output_tokens);
		entry.totalTokens += finiteNonNegative(row.total_tokens);
		if (row.avg_latency_ms != null && Number.isFinite(Number(row.avg_latency_ms)) && Number(row.avg_latency_ms) >= 0) {
			entry.latencyWeight += Number(row.avg_latency_ms) * requests;
			entry.latencySamples += requests;
		}
		grouped.set(row.model_id, entry);
	}

	return [...grouped.entries()].flatMap(([id, aggregate]) => {
		if (aggregate.requests < minimumSampleSize) return [];
		const model = published.get(id)!;
		return [{
			id,
			slug: model.slug,
			display_name: model.display_name ?? model.id,
			vendor: model.vendor,
			request_count: aggregate.requests,
			success_rate: aggregate.requests > 0 ? (aggregate.successes / aggregate.requests) * 100 : 0,
			avg_latency_ms: aggregate.latencySamples > 0 ? aggregate.latencyWeight / aggregate.latencySamples : null,
			output_tokens: aggregate.outputTokens,
			total_tokens: aggregate.totalTokens,
		}];
	}).sort((a, b) => b.request_count - a.request_count || a.display_name.localeCompare(b.display_name));
}
