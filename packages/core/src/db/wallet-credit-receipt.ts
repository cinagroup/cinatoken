/** Versioned, immutable evidence of one committed wallet credit. No current-balance inference. */
import { isWalletCreditKind, type WalletCreditKind } from '../services/wallet-balance';

export type WalletCreditSnapshot = {
	walletGranted: number;
	walletSpent: number;
	walletBalance: number;
};

export type WalletCreditReceipt = {
	version: 1;
	userId: string;
	externalRef: string;
	amountMicros: number;
	kind: WalletCreditKind;
	auditId: string;
	creditedAt: string;
	before: WalletCreditSnapshot;
	after: WalletCreditSnapshot;
};

export type ReadWalletCreditReceiptParams = { userId: string; externalRef: string };
export type ReadWalletCreditReceiptResult =
	| { version: 1; status: 'recorded'; receipt: WalletCreditReceipt }
	| { version: 1; status: 'not_found' | 'legacy_unverified' };

export class WalletCreditValidationError extends Error {
	constructor(message = 'Invalid wallet credit') {
		super(message);
		this.name = 'WalletCreditValidationError';
	}
}
export class WalletCreditConflictError extends Error {
	constructor() {
		super('Wallet credit reference conflicts with an existing operation');
		this.name = 'WalletCreditConflictError';
	}
}
export class WalletCreditLegacyUnverifiedError extends Error {
	constructor() {
		super('Existing wallet credit cannot be verified; no additional credit was applied');
		this.name = 'WalletCreditLegacyUnverifiedError';
	}
}
export class WalletCreditConcurrentMutationError extends Error {
	constructor() {
		super('Wallet credit snapshot changed; no credit was applied');
		this.name = 'WalletCreditConcurrentMutationError';
	}
}

/** Do not trim, case-fold, normalize Unicode, or hash: historical dedup keys are literal. */
export function assertWalletCreditReference(value: unknown): asserts value is string {
	if (
		typeof value !== 'string' ||
		value.length > 510 ||
		!value.trim() ||
		[...value].length > 255 ||
		/[\p{Cc}\p{Cf}]/u.test(value) ||
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
	)
		throw new WalletCreditValidationError('Invalid wallet credit reference');
}

/** Exact numeric micro-units; no coercion, silently rounded inputs, or unsafe counters. */
export function walletCreditMicros(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new WalletCreditValidationError('Invalid wallet amount');
	const micros = Math.round(value * 1_000_000);
	if (!Number.isSafeInteger(micros) || micros / 1_000_000 !== value)
		throw new WalletCreditValidationError('Wallet amount must be exact safe micro-units');
	return micros === 0 ? 0 : micros;
}

export function walletCreditAmount(micros: number): number {
	if (!Number.isSafeInteger(micros)) throw new WalletCreditValidationError('Unsafe wallet amount');
	const amount = micros / 1_000_000;
	if (walletCreditMicros(amount) !== micros)
		throw new WalletCreditValidationError('Wallet amount cannot be represented exactly');
	return amount;
}

/** DECIMAL drivers return strings. Check their exact decimal value before converting to Number. */
export function walletCreditStoredAmount(value: number | string | null): number {
	if (typeof value === 'number') return walletCreditAmount(walletCreditMicros(value));
	if (typeof value !== 'string' || !/^-?\d+(?:\.\d{1,6})?$/u.test(value))
		throw new WalletCreditValidationError('Invalid stored wallet amount');
	const negative = value.startsWith('-');
	const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
	const units = (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))) * (negative ? -1n : 1n);
	if (units > BigInt(Number.MAX_SAFE_INTEGER) || units < BigInt(-Number.MAX_SAFE_INTEGER))
		throw new WalletCreditValidationError('Unsafe stored wallet amount');
	return walletCreditAmount(Number(units));
}

/** Only for legacy D1 REAL counters. New inputs and DECIMAL strings stay exact.
 * A few binary ULPs can explain old += arithmetic, but never a quarter micro or
 * a real small nonzero amount. The caller must CAS the original, unrounded row. */
export function walletCreditStoredD1Amount(value: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new WalletCreditValidationError('Invalid stored D1 wallet amount');
	const candidate = walletCreditAmount(Math.round(value * 1_000_000));
	const difference = Math.abs(candidate - value);
	if (difference > 2 * Number.EPSILON * Math.abs(value) || difference >= 0.25 / 1_000_000)
		throw new WalletCreditValidationError('Stored D1 wallet amount is not canonical micro-units');
	return candidate;
}

export function walletCreditSnapshot(granted: number, spent: number): WalletCreditSnapshot {
	const g = walletCreditMicros(granted),
		s = walletCreditMicros(spent);
	if (g < 0 || s < 0) throw new WalletCreditValidationError('Wallet counters cannot be negative');
	return {
		walletGranted: walletCreditAmount(g),
		walletSpent: walletCreditAmount(s),
		walletBalance: walletCreditAmount(g - s),
	};
}

export function assertWalletCreditParams(params: {
	userId: string;
	externalRef: string;
	amount: number;
	kind: WalletCreditKind;
}): void {
	assertWalletCreditReference(params.externalRef);
	if (typeof params.userId !== 'string' || !params.userId) throw new WalletCreditValidationError('Invalid wallet user');
	if (walletCreditMicros(params.amount) === 0 || !isWalletCreditKind(params.kind))
		throw new WalletCreditValidationError('Invalid wallet credit amount or kind');
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function jsonRecord(value: string | null): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(value ?? 'null');
		return record(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function sameJsonValue(a: unknown, b: unknown, depth = 0): boolean {
	if (a === b) return true;
	if (depth > 64) return false;
	if (Array.isArray(a) || Array.isArray(b))
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((value, index) => sameJsonValue(value, b[index], depth + 1))
		);
	if (!record(a) || !record(b)) return false;
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every((key) => Object.hasOwn(b, key) && sameJsonValue(a[key], b[key], depth + 1))
	);
}

/** Validate receipt math independently of the storage driver or frontend. */
export function parseWalletCreditReceipt(value: unknown): WalletCreditReceipt | null {
	try {
		if (
			!record(value) ||
			value.version !== 1 ||
			typeof value.userId !== 'string' ||
			!value.userId ||
			typeof value.auditId !== 'string' ||
			!value.auditId ||
			typeof value.creditedAt !== 'string' ||
			!Number.isFinite(Date.parse(value.creditedAt)) ||
			new Date(value.creditedAt).toISOString() !== value.creditedAt ||
			typeof value.kind !== 'string' ||
			!isWalletCreditKind(value.kind) ||
			typeof value.amountMicros !== 'number' ||
			!Number.isSafeInteger(value.amountMicros) ||
			value.amountMicros === 0 ||
			!record(value.before) ||
			!record(value.after)
		)
			return null;
		assertWalletCreditReference(value.externalRef);
		walletCreditAmount(value.amountMicros);
		const before = walletCreditSnapshot(value.before.walletGranted as number, value.before.walletSpent as number);
		const after = walletCreditSnapshot(value.after.walletGranted as number, value.after.walletSpent as number);
		if (
			before.walletBalance !== value.before.walletBalance ||
			after.walletBalance !== value.after.walletBalance ||
			walletCreditMicros(after.walletGranted) - walletCreditMicros(before.walletGranted) !== value.amountMicros ||
			after.walletSpent !== before.walletSpent
		)
			return null;
		return {
			version: 1,
			userId: value.userId,
			externalRef: value.externalRef,
			amountMicros: value.amountMicros,
			kind: value.kind,
			auditId: value.auditId,
			creditedAt: value.creditedAt,
			before,
			after,
		};
	} catch {
		return null;
	}
}

export type WalletCreditAuditRecord = {
	id: string;
	userId: string | null;
	eventType: string;
	dedupKey: string | null;
	changePayload: string | null;
	beforeUserSnapshot: string | null;
	afterUserSnapshot: string | null;
	createdAt: string;
	/** MySQL TIMESTAMP, projected as exact epoch micros independent of session time_zone. */
	createdAtUnixMicros?: string;
};

function sameAuditInstant(value: string, creditedAt: string): boolean {
	// postgres-js can return "... .123+00"; mysql2 returns a UTC SQL timestamp.
	// Reject sub-millisecond differences instead of letting Date.parse truncate them.
	const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::\d{2})?)?$/u.exec(value);
	if (!match || /[1-9]/u.test((match[3] ?? '').slice(3))) return false;
	let zone = match[4] ?? 'Z';
	if (/^[+-]\d{2}$/u.test(zone)) zone += ':00';
	const canonical = `${match[1]}T${match[2]}.${(match[3] ?? '').padEnd(3, '0').slice(0, 3)}${zone}`;
	return Date.parse(canonical) === Date.parse(creditedAt);
}

function sameAuditTimestamp(row: WalletCreditAuditRecord, creditedAt: string): boolean {
	if (row.createdAtUnixMicros !== undefined) {
		const raw = row.createdAtUnixMicros;
		if (typeof raw !== 'string' || !/^\d+(?:\.0+)?$/u.test(raw)) return false;
		return BigInt(raw.split('.')[0]) === BigInt(Date.parse(creditedAt)) * 1000n;
	}
	return sameAuditInstant(row.createdAt, creditedAt);
}

/** A v1 receipt is evidence only when it agrees with the immutable audit row and both snapshots. */
export function readWalletCreditAuditReceipt(
	row: WalletCreditAuditRecord | undefined,
	params: ReadWalletCreditReceiptParams,
): ReadWalletCreditReceiptResult {
	assertWalletCreditReference(params.externalRef);
	if (!row) return { version: 1, status: 'not_found' };
	// In particular, MySQL's historical CI collation may match a different literal key.
	if (row.userId !== params.userId || row.dedupKey !== params.externalRef) throw new WalletCreditConflictError();
	const payload = jsonRecord(row.changePayload);
	const receipt = parseWalletCreditReceipt(payload?.receipt);
	const before = jsonRecord(row.beforeUserSnapshot),
		after = jsonRecord(row.afterUserSnapshot);
	if (
		!receipt ||
		row.eventType !== 'wallet_credit' ||
		receipt.userId !== row.userId ||
		receipt.externalRef !== row.dedupKey ||
		receipt.auditId !== row.id ||
		!sameAuditTimestamp(row, receipt.creditedAt) ||
		payload?.amount !== walletCreditAmount(receipt.amountMicros) ||
		payload.kind !== receipt.kind ||
		payload.external_ref !== receipt.externalRef ||
		!before ||
		!after ||
		before.id !== row.userId ||
		after.id !== row.userId ||
		before.wallet_granted !== receipt.before.walletGranted ||
		before.wallet_spent !== receipt.before.walletSpent ||
		after.wallet_granted !== receipt.after.walletGranted ||
		after.wallet_spent !== receipt.after.walletSpent ||
		Object.keys(before).length !== Object.keys(after).length ||
		Object.keys(before).some(
			(key) => key !== 'wallet_granted' && (!Object.hasOwn(after, key) || !sameJsonValue(before[key], after[key])),
		)
	) {
		return { version: 1, status: 'legacy_unverified' };
	}
	return { version: 1, status: 'recorded', receipt };
}

export function requireMatchingWalletCreditReceipt(
	result: ReadWalletCreditReceiptResult,
	params: { amount: number; kind: WalletCreditKind },
): WalletCreditReceipt {
	if (result.status !== 'recorded') throw new WalletCreditLegacyUnverifiedError();
	if (result.receipt.amountMicros !== walletCreditMicros(params.amount) || result.receipt.kind !== params.kind)
		throw new WalletCreditConflictError();
	return result.receipt;
}
