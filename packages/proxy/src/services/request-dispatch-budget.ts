import { createRequestAuxiliaryAuthBudget, type RequestAuxiliaryAuthBudget, type RequestAuxiliaryAuthBudgetSnapshot } from '@octafuse/core';

/** Local execution safety default from V2.1; shared by every model/key fallback. */
export const MAX_REQUEST_DISPATCHES = 3;

export type RequestDispatchBudgetSnapshot = Readonly<{
	limit: number;
	/** Pre-fetch permits; legacy drivers conservatively claim before preparation. */
	permitsConsumed: number;
	auxiliaryAuth: RequestAuxiliaryAuthBudgetSnapshot;
}>;

export class RequestDispatchLimitError extends Error {
	constructor() {
		super('Request upstream dispatch limit reached');
		this.name = 'RequestDispatchLimitError';
	}
}

export interface RequestDispatchBudget {
	/** Immutable request origin, also used to prevent deadline renewal on fallback. */
	readonly createdAtMs: number;
	readonly auxiliaryAuth: RequestAuxiliaryAuthBudget;
	assertAvailable(): void;
	/** Synchronous check-and-claim. A claimed permit is never refunded. */
	consume(): void;
	snapshot(): RequestDispatchBudgetSnapshot;
}

/**
 * Create once at the request entry point, not once per model/credential chain.
 * No global state, caller identity, money balance, or trace retention involved.
 * Internal callers can tighten the limit but cannot raise the safety ceiling.
 */
export function createRequestDispatchBudget(limit = MAX_REQUEST_DISPATCHES, auxiliaryAuthLimit?: number): RequestDispatchBudget {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REQUEST_DISPATCHES) {
		throw new RangeError(`Dispatch limit must be an integer between 1 and ${MAX_REQUEST_DISPATCHES}`);
	}
	let permitsConsumed = 0;
	const auxiliaryAuth = createRequestAuxiliaryAuthBudget(auxiliaryAuthLimit);
	const assertAvailable = (): void => {
		if (permitsConsumed >= limit) throw new RequestDispatchLimitError();
	};
	return Object.freeze({
		createdAtMs: Date.now(),
		auxiliaryAuth,
		assertAvailable,
		consume(): void {
			assertAvailable();
			permitsConsumed += 1;
		},
		snapshot: (): RequestDispatchBudgetSnapshot => Object.freeze({ limit, permitsConsumed, auxiliaryAuth: auxiliaryAuth.snapshot() }),
	});
}
