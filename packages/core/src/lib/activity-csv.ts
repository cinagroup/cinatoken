/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { normalizeBillingCurrencyCode } from "./billing-currency";
import { requestChargeSplit } from "./request-charge-allocation";

export type ActivityCsvRow = {
	id: string;
	apiKeyId: string | null;
	apiKeyName: string | null;
	modelId: string | null;
	modelName: string | null;
	providerName: string | null;
	protocol: string | null;
	operation: string | null;
	status: string;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	chargedCost: number;
	chargedWalletCost?: number | null;
	latencyMs: number | null;
	billingKind: string | null;
	inputImageCount: number;
	outputImageCount: number;
	audioDurationSeconds: number | null;
	audioCharacters: number | null;
	createdAt: string;
};

function csvCell(value: string | number | null): string {
	let text = value == null ? "" : String(value);
	if (/^[=+\-@]/u.test(text)) text = `'${text}`;
	return `"${text.replaceAll('"', '""')}"`;
}

export function serializeUserActivityCsv(
	rows: ActivityCsvRow[],
	billingCurrency: string = "USD",
	includeChargeAllocation = false,
): string {
	const normalizedCurrency =
		normalizeBillingCurrencyCode(billingCurrency).toLowerCase();
	const columns: Array<
		[string, (row: ActivityCsvRow) => string | number | null]
	> = [
		["time", (row) => row.createdAt],
		["request_id", (row) => row.id],
		["api_key_id", (row) => row.apiKeyId],
		["api_key_name", (row) => row.apiKeyName],
		["model_id", (row) => row.modelId],
		["model_name", (row) => row.modelName],
		["provider_name", (row) => row.providerName],
		["protocol", (row) => row.protocol],
		["operation", (row) => row.operation],
		["status", (row) => row.status],
		["input_tokens", (row) => row.inputTokens],
		["output_tokens", (row) => row.outputTokens],
		["total_tokens", (row) => row.totalTokens],
		["input_image_count", (row) => row.inputImageCount],
		["output_image_count", (row) => row.outputImageCount],
		["audio_duration_seconds", (row) => row.audioDurationSeconds],
		["audio_characters", (row) => row.audioCharacters],
		[`charged_cost_${normalizedCurrency}`, (row) => row.chargedCost],
		["latency_ms", (row) => row.latencyMs],
		["billing_kind", (row) => row.billingKind],
	];
	if (includeChargeAllocation) {
		const split = (row: ActivityCsvRow) =>
			requestChargeSplit({
				charged_cost: row.chargedCost,
				charged_wallet_cost: row.chargedWalletCost,
			});
		columns.push(
			[
				`charged_period_cost_${normalizedCurrency}`,
				(row) => {
					const value = split(row);
					return value.status === "known" ? value.period : null;
				},
			],
			[
				`charged_wallet_cost_${normalizedCurrency}`,
				(row) => {
					const value = split(row);
					return value.status === "known" ? value.wallet : null;
				},
			],
		);
	}
	return `\uFEFF${[
		columns.map(([name]) => csvCell(name)).join(","),
		...rows.map((row) =>
			columns.map(([, read]) => csvCell(read(row))).join(","),
		),
	].join("\r\n")}\r\n`;
}
