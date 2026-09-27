import type { PostgresDatabaseClient } from '../../storage/database-client';

/**
 * Review-only confirmation facts retained by the caller before the write.
 * The SQL reader compares every field to committed, immutable economic facts.
 */
export type LegacyBuyerTerminalExpectationV375 = Readonly<{
	requestId: string;
	userId: string;
	apiKeyId: string;
	workspaceId: string;
	chargeMicros: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reason: string;
	outcomes: readonly Readonly<{
		attempt_id: string;
		attempt_index: number;
		shared_key_id: string;
		transition_id: string;
		quote_version_id: string;
		usage_certainty: string;
		input_tokens: number | null;
		output_tokens: number | null;
		cache_read_tokens: number | null;
		cache_write_tokens: number | null;
		provider_cost_certainty: string;
		provider_cost_micros: number | null;
		evidence_kind: string;
		evidence_sha256: string | null;
		observed_at: string;
	}>[];
}>;

/**
 * Call through a fresh dedicated terminal-reader LOGIN after the original
 * write's COMMIT ACK is lost or its connection closes. `unconfirmed` and
 * `conflict` both require external reconciliation; neither permits retrying
 * the financial write. This function never writes or invokes the writer.
 */
export async function readLegacyBuyerTerminalV375(
	client: PostgresDatabaseClient,
	expected: LegacyBuyerTerminalExpectationV375,
	optIn: 'review-only',
): Promise<'confirmed' | 'unconfirmed' | 'conflict'> {
	if (optIn !== 'review-only' || client?.driver !== 'postgres') {
		throw new TypeError('Review-only PostgreSQL buyer terminal reader required');
	}
	const rows = await client.raw.unsafe<{ status: string }[]>(
		`SELECT cinatoken_buyer_terminal.read_windowed_v375(
			$1::text,$2::text,$3::text,$4::text,$5::bigint,
			$6::bigint,$7::bigint,$8::bigint,$9::bigint,$10::text,
			$11::jsonb) AS status`,
		[
			expected.requestId, expected.userId, expected.apiKeyId,
			expected.workspaceId, expected.chargeMicros,
			expected.inputTokens, expected.outputTokens,
			expected.cacheReadTokens, expected.cacheWriteTokens,
			expected.reason, client.raw.json(expected.outcomes),
		],
	);
	if (rows.length !== 1 || !['confirmed', 'unconfirmed', 'conflict'].includes(rows[0]?.status)) {
		throw new TypeError('PostgreSQL buyer terminal reader response invalid');
	}
	return rows[0].status as 'confirmed' | 'unconfirmed' | 'conflict';
}
