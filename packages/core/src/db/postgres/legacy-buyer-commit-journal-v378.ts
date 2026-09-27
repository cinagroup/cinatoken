import type { PostgresDatabaseClient } from '../../storage/database-client';
import {
	type LegacyBuyerTerminalExpectationV375,
} from './legacy-buyer-terminal-reader-v375';

export type LegacyBuyerJournalSessionV378 = Readonly<{
	client: PostgresDatabaseClient;
	close: () => Promise<unknown>;
}>;

export type LegacyBuyerJournalIntentV378 = Readonly<{
	intentId: string;
	// Caller supplied digest of canonical complete request bytes. The v378
	// journal stores it but cannot compare it to v372's committed financial row.
	fullRequestSha256: string;
	deadlineAt: string;
	expectedFinancialFacts: LegacyBuyerTerminalExpectationV375;
}>;

export type LegacyBuyerJournalWriteObservationV378 =
	| Readonly<{ kind: 'write_acknowledged'; journalState: string }>
	| Readonly<{ kind: 'write_acknowledged_journal_error'; journalError: unknown }>
	| Readonly<{
		kind: 'write_unacknowledged';
		writeError: unknown;
		journalState: string | null;
		journalError?: unknown;
	}>;

type OpenJournalSession = () => Promise<LegacyBuyerJournalSessionV378>;

async function withJournal<T>(open: OpenJournalSession,
	work: (client: PostgresDatabaseClient) => Promise<T>): Promise<T> {
	const session = await open();
	if (session?.client?.driver !== 'postgres' || typeof session.close !== 'function') {
		if (typeof session?.close === 'function') await session.close();
		throw new TypeError('Dedicated PostgreSQL buyer journal session required');
	}
	try {
		return await work(session.client);
	} finally {
		await session.close();
	}
}

/**
 * Prepare is a separate autocommit journal operation. After that session is
 * closed, a different PostgreSQL backend must see the same immutable receipt.
 * Only then may the financial writer be invoked. If the process dies at any
 * point after prepare, the stale-prepared sweeper treats it as uncertain.
 * This function invokes `writeOnce` at most once and never retries a charge.
 */
export async function runLegacyBuyerJournaledWriteV378(
	intent: LegacyBuyerJournalIntentV378,
	openJournalSession: OpenJournalSession,
	writeOnce: () => Promise<unknown>,
	optIn: 'review-only',
): Promise<LegacyBuyerJournalWriteObservationV378> {
	if (optIn !== 'review-only' || typeof openJournalSession !== 'function'
		|| typeof writeOnce !== 'function'
		|| !/^[0-9a-f]{64}$/.test(intent?.fullRequestSha256 ?? '')) {
		throw new TypeError('Review-only buyer journal intent required');
	}
	const pinned = structuredClone(intent);
	await withJournal(openJournalSession, async client => {
		const rows = await client.raw.unsafe<{ backend_pid: number }[]>(
			`SELECT cinatoken_buyer_commit_journal.prepare_v378(
				$1::uuid,$2::text,$3::text,$4::jsonb,$5::timestamptz
			) AS backend_pid`,
			[pinned.intentId, pinned.expectedFinancialFacts.requestId,
				pinned.fullRequestSha256, client.raw.json(pinned.expectedFinancialFacts),
				pinned.deadlineAt],
		);
		if (rows.length !== 1 || !Number.isInteger(rows[0]?.backend_pid)) {
			throw new TypeError('Buyer journal preparation response invalid');
		}
	});
	const committed = await withJournal(openJournalSession, async client => {
		const rows = await client.raw.unsafe<{ committed: boolean }[]>(
			`SELECT cinatoken_buyer_commit_journal.verify_prepared_v378(
				$1::uuid,$2::text) AS committed`,
			[pinned.intentId, pinned.fullRequestSha256],
		);
		return rows.length === 1 && rows[0]?.committed === true;
	});
	if (!committed) {
		throw new TypeError('Buyer journal receipt was not independently committed');
	}

	let writeError: unknown;
	let writeCompleted = false;
	try {
		await writeOnce();
		writeCompleted = true;
	} catch (error) {
		writeError = error;
	}
	const outcome = writeCompleted ? 'acknowledged' : 'uncertain';
	try {
		const journalState = await withJournal(openJournalSession, async client => {
			const rows = await client.raw.unsafe<{ state: string | null }[]>(
				`SELECT cinatoken_buyer_commit_journal.mark_write_v378(
					$1::uuid,$2::text) AS state`,
				[pinned.intentId, outcome],
			);
			if (rows.length !== 1) throw new TypeError('Buyer journal write response invalid');
			return rows[0]!.state;
		});
		if (outcome === 'acknowledged') {
			if (!journalState || journalState === 'quarantined') {
				throw new TypeError('Buyer journal acknowledgement state invalid');
			}
			return Object.freeze({ kind: 'write_acknowledged', journalState });
		}
		return Object.freeze({ kind: 'write_unacknowledged', writeError,
			journalState });
	} catch (journalError) {
		// The independently committed prepared receipt is recoverable even if
		// this best-effort status update fails or the process dies here.
		if (outcome === 'acknowledged') {
			return Object.freeze({ kind: 'write_acknowledged_journal_error',
				journalError });
		}
		return Object.freeze({ kind: 'write_unacknowledged', writeError,
			journalState: null, journalError });
	}
}

export type LegacyBuyerRecheckResultV378 =
	| Readonly<{ kind: 'no_due_entry' }>
	| Readonly<{ kind: 'lease_lost'; intentId: string; probeNumber: number }>
	| Readonly<{
		kind: 'probed'; intentId: string; probeNumber: number;
		financialFacts: 'confirmed' | 'unconfirmed' | 'conflict' | 'reader_error';
		journalState: string; readerError?: unknown;
	}>;

/**
 * One bounded worker step. A SQL lease excludes concurrent workers; expiry
 * allows crash recovery. Every claim opens and closes a fresh v375 reader.
 * All uncertainty remains pending until confirmation, conflict, exhaustion,
 * or the durable deadline. There is no reference to the financial writer.
 */
export async function recheckLegacyBuyerJournalOnceV378(
	openJournalSession: OpenJournalSession,
	openFreshTerminalReader: () => Promise<LegacyBuyerJournalSessionV378>,
	optIn: 'review-only',
): Promise<LegacyBuyerRecheckResultV378> {
	if (optIn !== 'review-only' || typeof openFreshTerminalReader !== 'function') {
		throw new TypeError('Review-only buyer recheck required');
	}
	type Claim = { intent_id: string; lease_token: string;
		probe_number: number };
	const claim = await withJournal(openJournalSession, async client => {
		const rows = await client.raw.unsafe<Claim[]>(
			`SELECT intent_id,lease_token,probe_number
				FROM cinatoken_buyer_commit_journal.claim_due_v378($1::integer)`,
			[30],
		);
		if (rows.length > 1) throw new TypeError('Buyer journal claim response invalid');
		return rows[0] ?? null;
	});
	if (!claim) return Object.freeze({ kind: 'no_due_entry' });
	type TerminalCompletion = {
		financial_facts: 'confirmed' | 'unconfirmed' | 'conflict';
		journal_state: string | null;
	};
	let completion: TerminalCompletion | undefined;
	let readerError: unknown;
	try {
		const fresh = await openFreshTerminalReader();
		if (fresh?.client?.driver !== 'postgres'
			|| typeof fresh.close !== 'function') {
			if (typeof fresh?.close === 'function') await fresh.close();
			throw new TypeError('Fresh dedicated terminal reader required');
		}
		try {
			const rows = await fresh.client.raw.unsafe<TerminalCompletion[]>(
				`SELECT financial_facts,journal_state FROM
					cinatoken_buyer_commit_journal.complete_from_reader_v378(
						$1::uuid,$2::uuid)`,
				[claim.intent_id, claim.lease_token],
			);
			if (rows.length > 1) {
				throw new TypeError('Buyer terminal completion response invalid');
			}
			completion = rows[0];
		} finally {
			await fresh.close();
		}
	} catch (error) {
		readerError = error;
	}
	// The read and durable state transition happened inside one SQL call. A
	// later close failure must not rewrite an already recorded observation.
	if (completion) {
		if (!completion.journal_state) {
			return Object.freeze({ kind: 'lease_lost', intentId: claim.intent_id,
				probeNumber: claim.probe_number });
		}
		return Object.freeze({ kind: 'probed', intentId: claim.intent_id,
			probeNumber: claim.probe_number,
			financialFacts: completion.financial_facts,
			journalState: completion.journal_state,
			...(readerError === undefined ? {} : { readerError }) });
	}
	const journalState = await withJournal(openJournalSession, async client => {
		const rows = await client.raw.unsafe<{ state: string | null }[]>(
			`SELECT cinatoken_buyer_commit_journal.record_reader_error_v378(
				$1::uuid,$2::uuid,$3::text) AS state`,
			[claim.intent_id, claim.lease_token, 'reader_error'],
		);
		if (rows.length !== 1) throw new TypeError('Buyer journal completion response invalid');
		return rows[0]!.state;
	});
	if (!journalState) {
		return Object.freeze({ kind: 'lease_lost', intentId: claim.intent_id,
			probeNumber: claim.probe_number });
	}
	return Object.freeze({ kind: 'probed', intentId: claim.intent_id,
		probeNumber: claim.probe_number,
		financialFacts: 'reader_error', journalState,
		...(readerError === undefined ? {} : { readerError }) });
}

/** Process only currently due entries; a scheduler supplies later wakeups. */
export async function runLegacyBuyerRecheckBatchV378(
	openJournalSession: OpenJournalSession,
	openFreshTerminalReader: () => Promise<LegacyBuyerJournalSessionV378>,
	maxItems: number,
	optIn: 'review-only',
): Promise<readonly Exclude<LegacyBuyerRecheckResultV378,
	Readonly<{ kind: 'no_due_entry' }>>[]> {
	if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 32) {
		throw new TypeError('Buyer recheck batch limit must be 1 through 32');
	}
	const results: Exclude<LegacyBuyerRecheckResultV378,
		Readonly<{ kind: 'no_due_entry' }>>[] = [];
	for (let n = 0; n < maxItems; n++) {
		const result = await recheckLegacyBuyerJournalOnceV378(
			openJournalSession, openFreshTerminalReader, optIn);
		if (result.kind === 'no_due_entry') break;
		results.push(result);
	}
	return Object.freeze(results);
}
