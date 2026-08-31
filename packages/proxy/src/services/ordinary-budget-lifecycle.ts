import type { GatewayRepositories } from '@octafuse/core';

const MICROS_PER_UNIT = 1_000_000;

export const ORDINARY_BUDGET_ADMISSION_LEASE_MS = 2 * 60 * 1000;
export const ORDINARY_BUDGET_DISPATCH_LEASE_MS = 15 * 60 * 1000;
export const ORDINARY_BUDGET_RECOVERY_PAGE_SIZE = 50;
export const ORDINARY_BUDGET_RECOVERY_MAX_PASSES = 4;

export type OrdinaryBudgetAdmissionErrorCode =
	| 'invalid_identity'
	| 'invalid_budget_limit'
	| 'invalid_budget_epoch'
	| 'invalid_time'
	| 'estimate_unavailable'
	| 'estimate_non_finite'
	| 'estimate_negative'
	| 'estimate_out_of_range'
	| 'budget_exhausted'
	| 'budget_epoch_stale'
	| 'reservation_conflict'
	| 'reservation_invariant_violation';

export type OrdinaryBudgetAdmissionError = {
	code: OrdinaryBudgetAdmissionErrorCode;
	message: string;
	retryable: boolean;
	remainingMicros?: number;
	budgetResetAt?: string | null;
	expectedBudgetEpoch?: number;
	actualBudgetEpoch?: number;
};

export type OrdinaryBudgetLifecycleErrorCode =
	| 'invalid_transition'
	| 'invalid_time'
	| 'invalid_reason'
	| 'reserve_persistence_failed'
	| 'dispatch_persistence_failed'
	| 'release_persistence_failed'
	| 'forfeit_persistence_failed';

export type OrdinaryBudgetLeaseKind = 'unlimited' | 'free' | 'reserved';
export type OrdinaryBudgetRepositories = Pick<GatewayRepositories, 'userBudgets'>;
export type OrdinaryBudgetLeaseState =
	| 'unmetered'
	| 'reserved'
	| 'dispatched'
	| 'released'
	| 'forfeited';

export class OrdinaryBudgetLifecycleError extends Error {
	readonly code: OrdinaryBudgetLifecycleErrorCode;
	readonly requestId: string;
	readonly leaseState: OrdinaryBudgetLeaseState | null;

	constructor(params: {
		code: OrdinaryBudgetLifecycleErrorCode;
		message: string;
		requestId: string;
		leaseState: OrdinaryBudgetLeaseState | null;
		cause?: unknown;
	}) {
		super(params.message, params.cause === undefined ? undefined : { cause: params.cause });
		this.name = 'OrdinaryBudgetLifecycleError';
		this.code = params.code;
		this.requestId = params.requestId;
		this.leaseState = params.leaseState;
	}
}

export interface OrdinaryBudgetLease {
	readonly kind: OrdinaryBudgetLeaseKind;
	readonly requestId: string;
	readonly userId: string;
	readonly apiKeyId: string;
	readonly reservedMicros: number;
	readonly budgetEpoch: number | null;
	readonly limitMicros: number | null;
	readonly state: OrdinaryBudgetLeaseState;
	readonly reserved: boolean;

	/** Invoke immediately before the first upstream byte can be dispatched. */
	beforeUpstreamDispatch(now?: Date): Promise<void>;
	/** Releases only a lease whose upstream dispatch never began. */
	releasePreDispatch(reason: string, now?: Date): Promise<void>;
	/** Conservatively consumes the ceiling when a dispatched outcome is unknown. */
	forfeitPostDispatchUnknown(reason: string, now?: Date): Promise<void>;
	/** Selects release or forfeit from the locally observed dispatch boundary. */
	terminateUnknown(reason: string, now?: Date): Promise<void>;
}

export type OrdinaryBudgetAdmissionResult =
	| {
			ok: true;
			kind: OrdinaryBudgetLeaseKind;
			lease: OrdinaryBudgetLease;
	  }
	| {
			ok: false;
			error: OrdinaryBudgetAdmissionError;
	  };

export type ReserveOrdinaryBudgetParams = {
	requestId: string;
	userId: string;
	apiKeyId: string;
	/** Authentication snapshot: null is the only representation of unlimited. */
	budgetMax: number | null;
	/** Epoch captured with the authentication snapshot. */
	expectedBudgetEpoch: number;
	/** Conservative charged-cost ceiling; null means an upper bound is unprovable. */
	estimatedChargedCost: number | null;
	now?: Date;
};

export type OrdinaryBudgetEstimateResult =
	| { ok: true; reservedMicros: number }
	| {
			ok: false;
			error: Pick<OrdinaryBudgetAdmissionError, 'code' | 'message' | 'retryable'>;
	  };

function admissionFailure(
	code: OrdinaryBudgetAdmissionErrorCode,
	message: string,
	retryable: boolean,
	extra: Omit<OrdinaryBudgetAdmissionError, 'code' | 'message' | 'retryable'> = {},
): OrdinaryBudgetAdmissionResult {
	return { ok: false, error: { code, message, retryable, ...extra } };
}

/** Convert a proven charged-cost ceiling without collapsing unknown values to zero. */
export function ordinaryBudgetReservationMicros(
	estimatedChargedCost: number | null,
): OrdinaryBudgetEstimateResult {
	if (estimatedChargedCost == null) {
		return {
			ok: false,
			error: {
				code: 'estimate_unavailable',
				message: 'A finite user budget requires a provable charged-cost ceiling',
				retryable: false,
			},
		};
	}
	if (!Number.isFinite(estimatedChargedCost)) {
		return {
			ok: false,
			error: {
				code: 'estimate_non_finite',
				message: 'The charged-cost ceiling must be finite',
				retryable: false,
			},
		};
	}
	if (estimatedChargedCost < 0) {
		return {
			ok: false,
			error: {
				code: 'estimate_negative',
				message: 'The charged-cost ceiling cannot be negative',
				retryable: false,
			},
		};
	}
	if (estimatedChargedCost === 0) return { ok: true, reservedMicros: 0 };

	const scaled = estimatedChargedCost * MICROS_PER_UNIT;
	const reservedMicros = Math.ceil(scaled);
	if (
		!Number.isFinite(scaled)
		|| !Number.isSafeInteger(reservedMicros)
		|| reservedMicros <= 0
	) {
		return {
			ok: false,
			error: {
				code: 'estimate_out_of_range',
				message: 'The charged-cost ceiling exceeds the safe micro-unit range',
				retryable: false,
			},
		};
	}
	return { ok: true, reservedMicros };
}

function validateIdentity(params: ReserveOrdinaryBudgetParams): OrdinaryBudgetAdmissionResult | null {
	if (!params.requestId || params.requestId.length > 128) {
		return admissionFailure('invalid_identity', 'requestId must contain 1-128 characters', false);
	}
	if (!params.userId || params.userId.length > 512) {
		return admissionFailure('invalid_identity', 'userId must contain 1-512 characters', false);
	}
	if (!params.apiKeyId || params.apiKeyId.length > 512) {
		return admissionFailure('invalid_identity', 'apiKeyId must contain 1-512 characters', false);
	}
	return null;
}

function validDate(value: Date): boolean {
	return Number.isFinite(value.getTime());
}

function lifecycleError(params: {
	code: OrdinaryBudgetLifecycleErrorCode;
	message: string;
	requestId: string;
	leaseState: OrdinaryBudgetLeaseState | null;
	cause?: unknown;
}): OrdinaryBudgetLifecycleError {
	return new OrdinaryBudgetLifecycleError(params);
}

function lifecycleNow(
	requestId: string,
	state: OrdinaryBudgetLeaseState,
	now: Date,
): string {
	if (!validDate(now)) {
		throw lifecycleError({
			code: 'invalid_time',
			message: 'Budget lifecycle timestamp is invalid',
			requestId,
			leaseState: state,
		});
	}
	return now.toISOString();
}

function lifecycleReason(
	requestId: string,
	state: OrdinaryBudgetLeaseState,
	reason: string,
): string {
	const normalized = reason.trim();
	if (!normalized || normalized.length > 128) {
		throw lifecycleError({
			code: 'invalid_reason',
			message: 'Budget lifecycle reason must contain 1-128 characters',
			requestId,
			leaseState: state,
		});
	}
	return normalized;
}

function invalidTransition(
	requestId: string,
	state: OrdinaryBudgetLeaseState,
	action: string,
): OrdinaryBudgetLifecycleError {
	return lifecycleError({
		code: 'invalid_transition',
		message: `Cannot ${action} an ordinary budget lease in ${state} state`,
		requestId,
		leaseState: state,
	});
}

function createOrdinaryBudgetLease(
	repositories: OrdinaryBudgetRepositories,
	params: {
		kind: OrdinaryBudgetLeaseKind;
		requestId: string;
		userId: string;
		apiKeyId: string;
		reservedMicros: number;
		budgetEpoch: number | null;
		limitMicros: number | null;
	},
): OrdinaryBudgetLease {
	let state: OrdinaryBudgetLeaseState = params.kind === 'reserved' ? 'reserved' : 'unmetered';

	const lease: OrdinaryBudgetLease = {
		kind: params.kind,
		requestId: params.requestId,
		userId: params.userId,
		apiKeyId: params.apiKeyId,
		reservedMicros: params.reservedMicros,
		budgetEpoch: params.budgetEpoch,
		limitMicros: params.limitMicros,
		get state() {
			return state;
		},
		get reserved() {
			return params.kind === 'reserved';
		},

		async beforeUpstreamDispatch(now = new Date()): Promise<void> {
			if (params.kind !== 'reserved') return;
			if (state === 'dispatched') return;
			if (state !== 'reserved') throw invalidTransition(params.requestId, state, 'dispatch');
			const nowIso = lifecycleNow(params.requestId, state, now);
			const expiresAtIso = new Date(
				now.getTime() + ORDINARY_BUDGET_DISPATCH_LEASE_MS,
			).toISOString();
			let marked: boolean;
			try {
				marked = await repositories.userBudgets.markDispatched(
					params.requestId,
					nowIso,
					expiresAtIso,
				);
			} catch (cause) {
				throw lifecycleError({
					code: 'dispatch_persistence_failed',
					message: 'Ordinary budget lease could not enter dispatched state',
					requestId: params.requestId,
					leaseState: state,
					cause,
				});
			}
			if (!marked) {
				throw lifecycleError({
					code: 'dispatch_persistence_failed',
					message: 'Ordinary budget lease could not enter dispatched state',
					requestId: params.requestId,
					leaseState: state,
				});
			}
			state = 'dispatched';
		},

		async releasePreDispatch(reason: string, now = new Date()): Promise<void> {
			if (params.kind !== 'reserved') return;
			if (state === 'released') return;
			if (state !== 'reserved') throw invalidTransition(params.requestId, state, 'release');
			const normalizedReason = lifecycleReason(params.requestId, state, reason);
			const nowIso = lifecycleNow(params.requestId, state, now);
			let released: number;
			try {
				released = await repositories.userBudgets.release(
					params.requestId,
					nowIso,
					normalizedReason,
				);
			} catch (cause) {
				throw lifecycleError({
					code: 'release_persistence_failed',
					message: 'Ordinary budget lease could not be released before dispatch',
					requestId: params.requestId,
					leaseState: state,
					cause,
				});
			}
			if (released !== 1) {
				throw lifecycleError({
					code: 'release_persistence_failed',
					message: 'Ordinary budget lease could not be released before dispatch',
					requestId: params.requestId,
					leaseState: state,
				});
			}
			state = 'released';
		},

		async forfeitPostDispatchUnknown(reason: string, now = new Date()): Promise<void> {
			if (params.kind !== 'reserved') return;
			if (state === 'forfeited') return;
			if (state !== 'dispatched') throw invalidTransition(params.requestId, state, 'forfeit');
			const normalizedReason = lifecycleReason(params.requestId, state, reason);
			const nowIso = lifecycleNow(params.requestId, state, now);
			let forfeited: number;
			try {
				forfeited = await repositories.userBudgets.forfeitDispatched(
					params.requestId,
					nowIso,
					normalizedReason,
				);
			} catch (cause) {
				throw lifecycleError({
					code: 'forfeit_persistence_failed',
					message: 'Dispatched ordinary budget lease could not be forfeited',
					requestId: params.requestId,
					leaseState: state,
					cause,
				});
			}
			if (forfeited !== 1) {
				throw lifecycleError({
					code: 'forfeit_persistence_failed',
					message: 'Dispatched ordinary budget lease could not be forfeited',
					requestId: params.requestId,
					leaseState: state,
				});
			}
			state = 'forfeited';
		},

		async terminateUnknown(reason: string, now = new Date()): Promise<void> {
			if (params.kind !== 'reserved' || state === 'released' || state === 'forfeited') return;
			if (state === 'reserved') {
				await lease.releasePreDispatch(reason, now);
				return;
			}
			await lease.forfeitPostDispatchUnknown(reason, now);
		},
	};
	return lease;
}

function unmeteredAdmission(
	repositories: OrdinaryBudgetRepositories,
	params: ReserveOrdinaryBudgetParams,
	kind: 'unlimited' | 'free',
): OrdinaryBudgetAdmissionResult {
	const lease = createOrdinaryBudgetLease(repositories, {
		kind,
		requestId: params.requestId,
		userId: params.userId,
		apiKeyId: params.apiKeyId,
		reservedMicros: 0,
		budgetEpoch: kind === 'free' ? params.expectedBudgetEpoch : null,
		limitMicros: null,
	});
	return { ok: true, kind, lease };
}

function validReservationSnapshot(
	reservation: {
		requestId: string;
		userId: string;
		apiKeyId: string;
		budgetEpoch: number;
		limitMicros: number;
		reservedMicros: number;
	},
	params: ReserveOrdinaryBudgetParams,
	reservedMicros: number,
): boolean {
	return reservation.requestId === params.requestId
		&& reservation.userId === params.userId
		&& reservation.apiKeyId === params.apiKeyId
		&& Number.isSafeInteger(reservation.budgetEpoch)
		&& reservation.budgetEpoch >= 0
		&& Number.isSafeInteger(reservation.limitMicros)
		&& reservation.limitMicros >= reservedMicros
		&& reservation.reservedMicros === reservedMicros;
}

async function releaseRejectedReservationBestEffort(
	repositories: OrdinaryBudgetRepositories,
	requestId: string,
	nowIso: string,
	reason: 'budget_epoch_mismatch' | 'reservation_invariant_violation',
): Promise<void> {
	try {
		const released = await repositories.userBudgets.release(
			requestId,
			nowIso,
			reason,
		);
		if (released !== 1) {
			console.error(JSON.stringify({
				message: 'ordinary budget rejected-reservation cleanup did not release a reservation',
				requestId,
				reason,
			}));
		}
	} catch (error) {
		console.error(JSON.stringify({
			message: 'ordinary budget rejected-reservation cleanup failed',
			requestId,
			reason,
			error: error instanceof Error ? error.message : String(error),
		}));
	}
}

/**
 * Atomically reserves a conservative ordinary-user budget ceiling. Recovery is
 * deliberately bounded; repository admission remains the authoritative check.
 */
export async function reserveOrdinaryUserBudget(
	repositories: OrdinaryBudgetRepositories,
	params: ReserveOrdinaryBudgetParams,
): Promise<OrdinaryBudgetAdmissionResult> {
	const identityError = validateIdentity(params);
	if (identityError) return identityError;
	if (params.budgetMax === null) return unmeteredAdmission(repositories, params, 'unlimited');
	if (!Number.isFinite(params.budgetMax) || params.budgetMax < 0) {
		return admissionFailure(
			'invalid_budget_limit',
			'A finite user budget limit must be a non-negative finite number',
			false,
		);
	}
	if (!Number.isSafeInteger(params.expectedBudgetEpoch) || params.expectedBudgetEpoch < 0) {
		return admissionFailure(
			'invalid_budget_epoch',
			'Expected user budget epoch must be a non-negative safe integer',
			false,
		);
	}
	const estimate = ordinaryBudgetReservationMicros(params.estimatedChargedCost);
	if (!estimate.ok) return { ok: false, error: estimate.error };
	if (estimate.reservedMicros === 0) return unmeteredAdmission(repositories, params, 'free');

	const now = params.now ?? new Date();
	if (!validDate(now)) {
		return admissionFailure('invalid_time', 'Budget admission timestamp is invalid', false);
	}
	const nowIso = now.toISOString();
	try {
		for (let pass = 0; pass < ORDINARY_BUDGET_RECOVERY_MAX_PASSES; pass += 1) {
			const recovered = await repositories.userBudgets.expireBefore(
				nowIso,
				ORDINARY_BUDGET_RECOVERY_PAGE_SIZE,
			);
			if (recovered < ORDINARY_BUDGET_RECOVERY_PAGE_SIZE) break;
		}
	} catch (error) {
		console.warn(JSON.stringify({
			message: 'ordinary budget lease recovery failed',
			error: error instanceof Error ? error.message : String(error),
		}));
	}

	const expiresAtIso = new Date(
		now.getTime() + ORDINARY_BUDGET_ADMISSION_LEASE_MS,
	).toISOString();
	const reserveParams = {
		requestId: params.requestId,
		userId: params.userId,
		apiKeyId: params.apiKeyId,
		reservedMicros: estimate.reservedMicros,
		expectedBudgetEpoch: params.expectedBudgetEpoch,
		nowIso,
		expiresAtIso,
	};
	let result: Awaited<ReturnType<OrdinaryBudgetRepositories['userBudgets']['reserve']>>;
	try {
		// The repository compares expectedBudgetEpoch in the same atomic admission
		// operation that creates the reservation.
		result = await repositories.userBudgets.reserve(reserveParams);
	} catch (cause) {
		throw lifecycleError({
			code: 'reserve_persistence_failed',
			message: 'Ordinary user budget reservation failed',
			requestId: params.requestId,
			leaseState: null,
			cause,
		});
	}

	switch (result.status) {
		case 'unlimited':
			return unmeteredAdmission(repositories, params, 'unlimited');
		case 'blocked':
			return admissionFailure(
				'budget_exhausted',
				'User budget does not have enough remaining capacity',
				false,
				{ remainingMicros: result.remainingMicros },
			);
		case 'stale':
			return admissionFailure(
				'budget_epoch_stale',
				'User budget changed; authenticate again before retrying',
				true,
				{ budgetResetAt: result.budgetResetAt, expectedBudgetEpoch: params.expectedBudgetEpoch },
			);
		case 'conflict':
			return admissionFailure('reservation_conflict', result.message, false);
		case 'reserved':
		case 'idempotent': {
			const reservation = result.reservation;
			if (!validReservationSnapshot(reservation, params, estimate.reservedMicros)) {
				await releaseRejectedReservationBestEffort(
					repositories,
					params.requestId,
					nowIso,
					'reservation_invariant_violation',
				);
				return admissionFailure(
					'reservation_invariant_violation',
					'User budget repository returned an inconsistent reservation',
					false,
				);
			}
			if (reservation.budgetEpoch !== params.expectedBudgetEpoch) {
				await releaseRejectedReservationBestEffort(
					repositories,
					params.requestId,
					nowIso,
					'budget_epoch_mismatch',
				);
				return admissionFailure(
					'budget_epoch_stale',
					'User budget changed; authenticate again before retrying',
					true,
					{
						expectedBudgetEpoch: params.expectedBudgetEpoch,
						actualBudgetEpoch: reservation.budgetEpoch,
					},
				);
			}
			const lease = createOrdinaryBudgetLease(repositories, {
				kind: 'reserved',
				requestId: reservation.requestId,
				userId: reservation.userId,
				apiKeyId: reservation.apiKeyId,
				reservedMicros: reservation.reservedMicros,
				budgetEpoch: reservation.budgetEpoch,
				limitMicros: reservation.limitMicros,
			});
			return { ok: true, kind: 'reserved', lease };
		}
	}
}
