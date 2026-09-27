import type { PostgresDatabaseClient } from '../../../core/src/storage/database-client';
import { requireDeliveryAuthority } from './postgres-shared-earning-delivery';

const OBSERVATION_CAP = 1000;

type Query = {
	unsafe<T extends Record<string, unknown>[]>(sql: string, params?: readonly unknown[]): PromiseLike<T>;
};
type TransactionClient = Query & { begin<T>(run: (tx: Query) => Promise<T>): Promise<T> };

export type SharedEarningBacklogSnapshot = Readonly<{
	observedAt: string;
	cap: number;
	pending: number;
	pendingSaturated: boolean;
	due: number;
	dueSaturated: boolean;
	leased: number;
	leasedSaturated: boolean;
	deadLetter: number;
	deadLetterSaturated: boolean;
	oldestPendingDueAgeSeconds: string | null;
}>;

function count(row: Record<string, unknown>, key: string): number {
	const value = row[key];
	if (typeof value !== 'number' || !Number.isInteger(value) ||
		value < 0 || value > OBSERVATION_CAP) {
		throw new Error('Shared earning backlog observation differs');
	}
	return value;
}

function saturated(row: Record<string, unknown>, key: string, value: number): boolean {
	const flag = row[key];
	if (typeof flag !== 'boolean' || (flag && value !== OBSERVATION_CAP)) {
		throw new Error('Shared earning backlog observation differs');
	}
	return flag;
}

function ageSeconds(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,15})$/u.test(value)) return value;
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
		return String(value);
	throw new Error('Shared earning backlog observation differs');
}

function snapshot(rows: Record<string, unknown>[]): SharedEarningBacklogSnapshot {
	if (rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') {
		throw new Error('Shared earning backlog observation differs');
	}
	const row = rows[0];
	const observedAt = row.out_observed_at instanceof Date ||
		typeof row.out_observed_at === 'string'
		? new Date(row.out_observed_at) : null;
	if (!observedAt || !Number.isFinite(observedAt.getTime()) ||
		row.out_cap !== OBSERVATION_CAP) {
		throw new Error('Shared earning backlog observation differs');
	}
	const pending = count(row, 'out_pending_count');
	const due = count(row, 'out_due_count');
	const leased = count(row, 'out_leased_count');
	const deadLetter = count(row, 'out_dead_letter_count');
	const oldestPendingDueAgeSeconds = ageSeconds(row.out_oldest_pending_due_age_seconds);
	if ((pending === 0) !== (oldestPendingDueAgeSeconds === null)) {
		throw new Error('Shared earning backlog observation differs');
	}
	return Object.freeze({
		observedAt: observedAt.toISOString(), cap: OBSERVATION_CAP,
		pending, pendingSaturated: saturated(row, 'out_pending_saturated', pending),
		due, dueSaturated: saturated(row, 'out_due_saturated', due),
		leased, leasedSaturated: saturated(row, 'out_leased_saturated', leased),
		deadLetter, deadLetterSaturated: saturated(row, 'out_dead_letter_saturated', deadLetter),
		oldestPendingDueAgeSeconds,
	});
}

/** A failed or unconfirmed observation stops this Cron tick before any claim. */
export async function observeDedicatedSharedEarningBacklog(
	deliveryClient: PostgresDatabaseClient,
): Promise<SharedEarningBacklogSnapshot> {
	if (deliveryClient?.driver !== 'postgres' ||
		typeof (deliveryClient.raw as unknown as TransactionClient)?.begin !== 'function') {
		throw new TypeError('Dedicated PostgreSQL delivery client required for backlog observation');
	}
	const delivery = deliveryClient.raw as unknown as TransactionClient;
	return delivery.begin(async tx => {
		await tx.unsafe('SET TRANSACTION READ ONLY');
		await requireDeliveryAuthority(tx);
		const rows = await tx.unsafe<Record<string, unknown>[]>(
			'SELECT * FROM cinatoken_economic_delivery.observe_backlog($1::integer)',
			[OBSERVATION_CAP],
		);
		return snapshot(rows);
	});
}
