import type { PostgresDatabaseClient } from '../../storage/database-client';
import {
	readLegacyBuyerTerminalV375,
	type LegacyBuyerTerminalExpectationV375,
} from './legacy-buyer-terminal-reader-v375';

export type LegacyBuyerCommitObservationV376 =
	| Readonly<{ kind: 'write_acknowledged' }>
	| Readonly<{
		kind: 'write_unacknowledged';
		financialFacts: 'confirmed' | 'unconfirmed' | 'conflict' | 'reader_error';
		writeError: unknown;
		readerError?: unknown;
	}>;

export type LegacyBuyerFreshTerminalReaderV376 = Readonly<{
	client: PostgresDatabaseClient;
	close: () => Promise<unknown>;
}>;

/**
 * Review-only call protocol for a single v372 buyer write. The caller must
 * retain `expected` before starting the write. Only after the writer rejects,
 * `openFreshReader` creates a new connection authenticated as the v375
 * terminal-reader LOGIN. A failed write or read never causes a second
 * financial write here. `confirmed` covers only the v375 financial facts,
 * not the complete Provider request or response.
 */
export async function observeLegacyBuyerCommitV376(
	writeOnce: () => Promise<unknown>,
	openFreshReader: () => Promise<LegacyBuyerFreshTerminalReaderV376>,
	expected: LegacyBuyerTerminalExpectationV375,
	optIn: 'review-only',
): Promise<LegacyBuyerCommitObservationV376> {
	if (optIn !== 'review-only' || typeof writeOnce !== 'function'
		|| typeof openFreshReader !== 'function') {
		throw new TypeError('Review-only PostgreSQL buyer COMMIT observation required');
	}
	// Keep the pre-write target private. The request owner may mutate its
	// objects while an ambiguous COMMIT is pending, including an attempt fact.
	// This still cannot replace a database-bound full request intent receipt.
	const pinnedExpected = structuredClone(expected);
	try {
		await writeOnce();
		return Object.freeze({ kind: 'write_acknowledged' });
	} catch (writeError) {
		try {
			const session = await openFreshReader();
			if (session?.client?.driver !== 'postgres'
				|| typeof session.close !== 'function') {
				throw new TypeError('Fresh PostgreSQL buyer terminal reader required');
			}
			let financialFacts: 'confirmed' | 'unconfirmed' | 'conflict';
			try {
				financialFacts = await readLegacyBuyerTerminalV375(
					session.client, pinnedExpected, 'review-only');
			} finally {
				await session.close();
			}
			return Object.freeze({ kind: 'write_unacknowledged', financialFacts, writeError });
		} catch (readerError) {
			return Object.freeze({ kind: 'write_unacknowledged',
				financialFacts: 'reader_error' as const, writeError, readerError });
		}
	}
}
