/** Explicit economic facts supplied by the upstream observer, never inferred from a quote claim. */
export type SharedKeyEconomicAttemptOutcome = Readonly<{
	attemptId: string;
	requestLogId: string;
	attemptIndex: number;
	sharedKeyId: string;
	transitionId: string;
	quoteVersionId: string;
	usageCertainty: 'actual' | 'estimated' | 'unknown' | 'confirmed_zero';
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	providerCostCertainty: 'actual' | 'estimated' | 'unknown' | 'confirmed_zero';
	providerCostMicros: number | null;
	evidenceKind: 'provider_usage' | 'provider_bill' | 'confirmed_rejection' | 'timeout' | 'cancellation' | 'manual_review';
	evidenceSha256: string | null;
	observedAtIso: string;
}>;

/** Only a caller with actual buyer and per-attempt evidence may request this opt-in path. */
export type SharedKeyEconomicOutboxInput = Readonly<{
	/** v1 remains the default for existing callers; v2 carries the ordinary-user debit. */
	eventVersion?: 1 | 2;
	buyerChargeBasis: 'actual' | 'reserved' | 'none';
	buyerUsageCertainty: 'actual' | 'unknown';
	attempts: readonly SharedKeyEconomicAttemptOutcome[];
}>;

export type PreparedSharedKeyEconomicOutbox = Readonly<{
	eventVersion: 1 | 2;
	buyerChargeBasis: SharedKeyEconomicOutboxInput['buyerChargeBasis'];
	buyerUsageCertainty: SharedKeyEconomicOutboxInput['buyerUsageCertainty'];
	attemptsJson: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const TEXT = /^[^\u0000-\u001f\u007f-\u009f]{1,512}$/u;
const MAX_OUTCOMES_JSON_BYTES = 4 * 1024 * 1024;
const OUTCOME_KEYS = [
	'attemptId', 'requestLogId', 'attemptIndex', 'sharedKeyId', 'transitionId',
	'quoteVersionId', 'usageCertainty', 'inputTokens', 'outputTokens',
	'cacheReadTokens', 'cacheWriteTokens', 'providerCostCertainty',
	'providerCostMicros', 'evidenceKind', 'evidenceSha256', 'observedAtIso',
].sort();

function exactKeys(value: unknown, keys: readonly string[]): boolean {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		&& Object.keys(value).sort().join('\u0000') === keys.join('\u0000');
}

function safeMicros(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function tokenShape(attempt: SharedKeyEconomicAttemptOutcome): boolean {
	const tokens = [attempt.inputTokens, attempt.outputTokens,
		attempt.cacheReadTokens, attempt.cacheWriteTokens];
	if (attempt.usageCertainty === 'unknown') return tokens.every(value => value === null);
	if (!tokens.every(safeMicros)) return false;
	return attempt.usageCertainty !== 'confirmed_zero' || tokens.every(value => value === 0);
}

function costShape(attempt: SharedKeyEconomicAttemptOutcome): boolean {
	if (attempt.providerCostCertainty === 'unknown') return attempt.providerCostMicros === null;
	if (!safeMicros(attempt.providerCostMicros)) return false;
	return attempt.providerCostCertainty !== 'confirmed_zero' || attempt.providerCostMicros === 0;
}

/** Own the caller's facts before any transaction I/O; SQL rechecks all identities and constraints. */
export function prepareSharedKeyEconomicOutbox(
	requestLogId: string,
	budgetChargedMicros: number,
	input: SharedKeyEconomicOutboxInput,
): PreparedSharedKeyEconomicOutbox {
	if (!(exactKeys(input, ['attempts', 'buyerChargeBasis', 'buyerUsageCertainty'])
		|| exactKeys(input, ['attempts', 'buyerChargeBasis', 'buyerUsageCertainty', 'eventVersion']))
		|| (input.eventVersion !== undefined && input.eventVersion !== 1 && input.eventVersion !== 2)
		|| !TEXT.test(requestLogId) || requestLogId.trim() !== requestLogId
		|| requestLogId.length > 128
		|| !safeMicros(budgetChargedMicros)
		|| !['actual', 'reserved', 'none'].includes(input.buyerChargeBasis)
		|| !['actual', 'unknown'].includes(input.buyerUsageCertainty)
		|| (input.buyerChargeBasis === 'actual' && input.buyerUsageCertainty !== 'actual')
		|| (input.buyerChargeBasis === 'reserved' && input.buyerUsageCertainty !== 'unknown')
		|| (input.buyerChargeBasis === 'none' && budgetChargedMicros !== 0)
		|| !Array.isArray(input.attempts) || input.attempts.length < 1 || input.attempts.length > 1000) {
		throw new TypeError('Invalid shared-key economic event basis or attempt count');
	}
	const ids = new Set<string>();
	const indices = new Set<number>();
	const attempts = input.attempts.map(attempt => {
		if (!exactKeys(attempt, OUTCOME_KEYS)) {
			throw new TypeError('Shared-key economic attempt fields differ');
		}
		if (!UUID.test(attempt.attemptId)) throw new TypeError('Invalid economic attempt UUID');
		if (attempt.requestLogId !== requestLogId) throw new TypeError('Economic attempt request ID differs');
		if (!Number.isInteger(attempt.attemptIndex)
			|| attempt.attemptIndex < 1 || attempt.attemptIndex > 1000) {
			throw new TypeError('Invalid economic attempt index');
		}
		if (![attempt.sharedKeyId, attempt.transitionId, attempt.quoteVersionId]
			.every(value => typeof value === 'string' && TEXT.test(value) && value.trim() === value)) {
			throw new TypeError('Invalid economic attempt quote reference');
		}
		if (ids.has(attempt.attemptId.toLowerCase()) || indices.has(attempt.attemptIndex)) {
			throw new TypeError('Duplicate economic attempt identity');
		}
		if (!['actual', 'estimated', 'unknown', 'confirmed_zero'].includes(attempt.usageCertainty)
			|| !['actual', 'estimated', 'unknown', 'confirmed_zero'].includes(attempt.providerCostCertainty)
			|| !['provider_usage', 'provider_bill', 'confirmed_rejection', 'timeout', 'cancellation', 'manual_review']
				.includes(attempt.evidenceKind)
			|| !tokenShape(attempt) || !costShape(attempt)) {
			throw new TypeError('Invalid shared-key economic usage, cost or evidence certainty');
		}
		if ((attempt.evidenceSha256 !== null && !SHA256.test(attempt.evidenceSha256))
			|| (['actual', 'estimated'].includes(attempt.usageCertainty)
				|| ['actual', 'estimated'].includes(attempt.providerCostCertainty))
				&& attempt.evidenceSha256 === null) {
			throw new TypeError('Invalid shared-key economic evidence digest');
		}
		if (typeof attempt.observedAtIso !== 'string'
			|| !Number.isFinite(Date.parse(attempt.observedAtIso))
			|| new Date(attempt.observedAtIso).toISOString() !== attempt.observedAtIso) {
			throw new TypeError('Invalid shared-key economic observation time');
		}
		ids.add(attempt.attemptId.toLowerCase());
		indices.add(attempt.attemptIndex);
		return {
			attempt_id: attempt.attemptId.toLowerCase(), attempt_index: attempt.attemptIndex,
			shared_key_id: attempt.sharedKeyId, transition_id: attempt.transitionId,
			quote_version_id: attempt.quoteVersionId, usage_certainty: attempt.usageCertainty,
			input_tokens: attempt.inputTokens, output_tokens: attempt.outputTokens,
			cache_read_tokens: attempt.cacheReadTokens, cache_write_tokens: attempt.cacheWriteTokens,
			provider_cost_certainty: attempt.providerCostCertainty,
			provider_cost_micros: attempt.providerCostMicros,
			evidence_kind: attempt.evidenceKind, evidence_sha256: attempt.evidenceSha256,
			observed_at: attempt.observedAtIso,
		};
	});
	const attemptsJson = JSON.stringify(attempts);
	if (new TextEncoder().encode(attemptsJson).length > MAX_OUTCOMES_JSON_BYTES) {
		throw new TypeError('Shared-key economic outcomes exceed the byte limit');
	}
	return Object.freeze({
		eventVersion: input.eventVersion ?? 1,
		buyerChargeBasis: input.buyerChargeBasis,
		buyerUsageCertainty: input.buyerUsageCertainty,
		attemptsJson,
	});
}
