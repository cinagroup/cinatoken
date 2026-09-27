import type { PostgresDatabaseClient } from '../../storage/database-client';
import {
	type LegacyBuyerJournalIntentV378,
	type LegacyBuyerJournalSessionV378,
	type LegacyBuyerJournalWriteObservationV378,
	runLegacyBuyerJournaledWriteV378,
} from './legacy-buyer-commit-journal-v378';

/** Exact, non-sensitive fields that v383 can independently read from the log. */
export type BuyerLogProjectionV383 = Readonly<{
	apiKeyId: string;
	billingKind: string | null;
	isByok: boolean;
	modelId: string | null;
	providerId: string | null;
	providerKeyFingerprint: string | null;
	requestId: string;
	requestOperation: string | null;
	requestProtocol: string | null;
	routeGroup: string;
	routePoolId: string | null;
	routeTargetId: string | null;
	routeTrace: string | null;
	status: 'success';
	upstreamOperation: string | null;
	upstreamProtocol: string;
	upstreamRequestId: string | null;
	userId: string;
	workspaceId: string;
}>;

type OpenJournalSession = () => Promise<LegacyBuyerJournalSessionV378>;

async function withDedicatedSession<T>(open: OpenJournalSession,
	work: (client: PostgresDatabaseClient) => Promise<T>): Promise<T> {
	const session = await open();
	if (session?.client?.driver !== 'postgres'
		|| typeof session.close !== 'function') {
		if (typeof session?.close === 'function') await session.close();
		throw new TypeError('Dedicated PostgreSQL v383 session required');
	}
	try {
		return await work(session.client);
	} finally {
		await session.close();
	}
}

export type BuyerProjectionWriteObservationV383 =
	| Readonly<{ kind: 'projection_prewrite_unacknowledged';
		prewriteError: unknown; journalState: string | null }>
	| LegacyBuyerJournalWriteObservationV378;

/**
 * v378 prepare and independent verification happen first. The callback then
 * commits the v383 log projection on another journal backend, verifies it on
 * yet another backend, closes both sessions, and only then calls the buyer
 * writer once. Any ambiguous prewrite/verification response leaves writer
 * calls at zero. The buyer INSERT trigger independently rejects missing or
 * mismatched projections, including an A-intent/B-writer callback mistake.
 * Neither this helper nor its digest authenticates complete Provider wire.
 */
export async function runLegacyBuyerProjectionWriteV383(
	intent: LegacyBuyerJournalIntentV378,
	projection: BuyerLogProjectionV383,
	openJournalSession: OpenJournalSession,
	writeOnce: () => Promise<unknown>,
	optIn: 'review-only',
): Promise<BuyerProjectionWriteObservationV383> {
	if (optIn !== 'review-only' || typeof openJournalSession !== 'function'
		|| typeof writeOnce !== 'function' || projection?.requestId
			!== intent?.expectedFinancialFacts?.requestId) {
		throw new TypeError('Review-only v383 projection intent required');
	}
	const pinnedProjection = structuredClone(projection);
	let writerStarted = false;
	const observed = await runLegacyBuyerJournaledWriteV378(intent,
		openJournalSession, async () => {
			const projectionSha256 = await withDedicatedSession(openJournalSession,
				async client => {
					const rows = await client.raw.unsafe<{ projection_sha256: string }[]>(
						`SELECT cinatoken_buyer_request_projection.prepare_v383(
							$1::uuid,$2::jsonb) AS projection_sha256`,
						[intent.intentId, client.raw.json(pinnedProjection)],
					);
					if (rows.length !== 1
						|| !/^[0-9a-f]{64}$/.test(rows[0]?.projection_sha256 ?? '')) {
						throw new TypeError('v383 projection prewrite response invalid');
					}
					return rows[0]!.projection_sha256;
				});
			const verified = await withDedicatedSession(openJournalSession,
				async client => {
					const rows = await client.raw.unsafe<{ verified: boolean }[]>(
						`SELECT cinatoken_buyer_request_projection.verify_v383(
							$1::uuid,$2::text) AS verified`,
						[intent.intentId, projectionSha256],
					);
					return rows.length === 1 && rows[0]?.verified === true;
				});
			if (!verified) {
				throw new TypeError('v383 projection was not independently verified');
			}
			writerStarted = true;
			return await writeOnce();
		}, optIn);
	if (!writerStarted && observed.kind === 'write_unacknowledged') {
		return Object.freeze({ kind: 'projection_prewrite_unacknowledged',
			prewriteError: observed.writeError,
			journalState: observed.journalState });
	}
	return observed;
}

/** Read only a committed DB-log projection plus v375 financial fact subset. */
export async function readBuyerLogProjectionV383(
	intentId: string,
	openFreshReader: OpenJournalSession,
	optIn: 'review-only',
): Promise<'unconfirmed' | 'conflict' | 'db_log_projection_confirmed'> {
	if (optIn !== 'review-only' || typeof openFreshReader !== 'function') {
		throw new TypeError('Review-only v383 terminal reader required');
	}
	return withDedicatedSession(openFreshReader, async client => {
		const rows = await client.raw.unsafe<{ result: string }[]>(
			`SELECT cinatoken_buyer_request_projection.read_v383($1::uuid)
				AS result`, [intentId]);
		const result = rows[0]?.result;
		if (rows.length !== 1 || (result !== 'unconfirmed'
			&& result !== 'conflict'
			&& result !== 'db_log_projection_confirmed')) {
			throw new TypeError('v383 terminal reader response invalid');
		}
		return result;
	});
}
