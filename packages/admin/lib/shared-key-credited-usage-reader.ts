import type { GatewayRepositories, SharedKeyRow } from '@octafuse/core';

const MAX_PAGE = 200;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

type CreditedUsageRow = {
	shared_key_id: string;
	seller_user_id: string;
	input_tokens: string | number;
	output_tokens: string | number;
	net_micros: string | number;
	last_credited_at: string | Date | null;
};

function safeCount(value: string | number): number {
	const raw = String(value);
	if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error('shared_key_stats_reader_invalid_count');
	const count = BigInt(raw);
	if (count > MAX_SAFE) throw new Error('shared_key_stats_reader_count_exceeds_safe_range');
	return Number(count);
}

function moneyFromMicros(value: string | number): { value: number; exact: string } {
	const micros = BigInt(safeCount(value));
	const integer = micros / BigInt(1_000_000);
	const fraction = (micros % BigInt(1_000_000)).toString().padStart(6, '0');
	return { value: Number(micros) / 1_000_000, exact: `${integer}.${fraction}` };
}

/**
 * Response-only projection. Internal getSharedKeyById and legacy CAS writers
 * continue to see their original shared_keys snapshot until a separate cutover.
 * The SQL function refuses reads until both source backfills and the full audit
 * have committed. Any identity or readiness drift fails the whole response.
 */
export async function projectCurrentSellerCreditedUsageWithReader(
	keys: SharedKeyRow[],
	expectedSellerUserId: string | undefined,
	readPage: (sellerUserId: string, keyIds: string[]) => Promise<CreditedUsageRow[]>,
): Promise<SharedKeyRow[]> {
	if (expectedSellerUserId && keys.some((key) => key.sellerUserId !== expectedSellerUserId)) {
		throw new Error('shared_key_stats_reader_seller_scope_mismatch');
	}
	const ids = keys.map((key) => key.id);
	if (new Set(ids).size !== ids.length) {
		throw new Error('shared_key_stats_reader_duplicate_key');
	}
	if (keys.length === 0) return [];
	const projected = new Map<string, CreditedUsageRow>();
	const bySeller = new Map<string, string[]>();
	for (const key of keys) {
		const sellerIds = bySeller.get(key.sellerUserId) ?? [];
		sellerIds.push(key.id);
		bySeller.set(key.sellerUserId, sellerIds);
	}
	for (const [sellerUserId, sellerIds] of bySeller) {
		for (let offset = 0; offset < sellerIds.length; offset += MAX_PAGE) {
			const page = sellerIds.slice(offset, offset + MAX_PAGE);
			const rows = await readPage(sellerUserId, page);
			for (const row of rows) {
				if (projected.has(row.shared_key_id) || row.seller_user_id !== sellerUserId) {
					throw new Error('shared_key_stats_reader_duplicate_or_wrong_seller_result');
				}
				projected.set(row.shared_key_id, row);
			}
		}
	}
	if (projected.size !== keys.length) throw new Error('shared_key_stats_reader_missing_result');
	return keys.map((key) => {
		const row = projected.get(key.id);
		if (!row || row.seller_user_id !== key.sellerUserId) {
			throw new Error('shared_key_stats_reader_owner_changed');
		}
		let lastUsedAt: string | null = null;
		if (row.last_credited_at !== null) {
			const date = row.last_credited_at instanceof Date
				? row.last_credited_at : new Date(row.last_credited_at);
			if (Number.isNaN(date.getTime())) throw new Error('shared_key_stats_reader_invalid_time');
			lastUsedAt = date.toISOString();
		}
		const money = moneyFromMicros(row.net_micros);
		return {
			...key,
			servedInputTokens: safeCount(row.input_tokens),
			servedOutputTokens: safeCount(row.output_tokens),
			earnedTotal: money.value,
			earnedTotalExact: money.exact,
			lastUsedAt,
		};
	});
}

export async function projectCurrentSellerCreditedUsage(
	repositories: GatewayRepositories,
	keys: SharedKeyRow[],
	expectedSellerUserId?: string,
): Promise<SharedKeyRow[]> {
	const client = repositories.client;
	if (client.driver !== 'postgres') {
		throw new Error('shared_key_stats_reader_requires_postgres');
	}
	return projectCurrentSellerCreditedUsageWithReader(keys, expectedSellerUserId,
		(sellerUserId, keyIds) => client.raw.unsafe<CreditedUsageRow[]>(
			'SELECT * FROM cinatoken_shared_stats.read_shared_key_credited_usage($1::text,$2::text[])',
			[sellerUserId, keyIds],
		));
}
