import {
	isGatewayKeyLimitIntent,
	type GatewayRepositories,
	type GuardrailBudgetIntent,
} from '@octafuse/core';
import type { GatewayErrorCodeValue } from './gateway-error-codes';
import { GatewayErrorCode } from './gateway-error-codes';
import { isPrivateByokRoute } from './byok-key-pool';
import type { RouteResult } from './model-router';
import {
	reserveOrdinaryUserBudget,
	type OrdinaryBudgetRepositories,
	type OrdinaryBudgetLease,
	type ReserveOrdinaryBudgetParams,
} from './ordinary-budget-lifecycle';
import {
	forfeitRequestGuardrailBudgets,
	extendDispatchedRequestGuardrailBudgets,
	markRequestGuardrailBudgetsDispatched,
	releaseRequestGuardrailBudgets,
	reserveRequestGuardrailBudgets,
	type GuardrailBudgetAdmissionResult,
} from './request-guardrails';

/** Request-fixed, function-only Guardrail owner; its reserve performs strict recovery. */
export type GuardrailBudgetRequestPort = Readonly<{
	identity: Readonly<{ requestId: string; userId: string; apiKeyId: string }>;
	reserve(params: {
		intents: GuardrailBudgetIntent[];
		reservedMicros: number;
		settlementBasis?: 'charged' | 'gateway_key_route';
		now: Date;
	}): Promise<GuardrailBudgetAdmissionResult>;
	extend(params: {
		intents: GuardrailBudgetIntent[];
		reservedMicros: number;
		now: Date;
	}): Promise<GuardrailBudgetAdmissionResult>;
	markDispatched(now: Date): Promise<void>;
	releasePreDispatch(reason: string): Promise<void>;
	forfeitPostDispatch(reason: string): Promise<void>;
}>;

/** A request-local policy denial raised immediately before upstream dispatch. */
export class RequestBudgetAdmissionError extends Error {
	readonly status: 402 | 403;
	readonly code: GatewayErrorCodeValue;

	constructor(params: { code: GatewayErrorCodeValue; message: string; cause?: unknown }) {
		super(params.message, params.cause === undefined ? undefined : { cause: params.cause });
		this.name = 'RequestBudgetAdmissionError';
		this.code = params.code;
		this.status = params.code === GatewayErrorCode.budgetExceeded ? 402 : 403;
	}
}

export type RouteAwareBudgetAdmission = {
	/** Stable delegating lease; it switches from free to reserved only for a paid route. */
	readonly ordinaryLease: OrdinaryBudgetLease;
	readonly guardrailReserved: boolean;
	readonly guardrailDispatched: boolean;
	readonly guardrailTerminal: boolean;
	/** Invoke at the failover boundary immediately adjacent to the selected credential dispatch. */
	beforeUpstreamDispatch(route: RouteResult): Promise<void>;
	/** Local single-grant candidate: reserve first, then resolve a PostgreSQL claim before any dispatch mark. */
	prepareSingleGrant(route: RouteResult): Promise<SingleGrantBudgetTicket>;
	releaseGuardrailPreDispatch(reason: string): Promise<void>;
	forfeitGuardrailPostDispatch(reason: string): Promise<void>;
	terminateGuardrailUnknown(reason: string): Promise<void>;
};

export type SingleGrantBudgetTicket = Readonly<{
	/** Call only after the one request-level claim COMMIT has been acknowledged. */
	markAfterCommittedClaim(): Promise<void>;
	/** A definitive no-claim result proves this owner cannot have sent a provider request. */
	releaseAfterDefiniteNoClaim(): Promise<void>;
	/** A lost claim acknowledgement leaves admission reserved for bounded recovery. */
	holdAfterUncertainClaim(): void;
}>;

export type CreateRouteAwareBudgetAdmissionParams = {
	ordinary: ReserveOrdinaryBudgetParams;
	guardrail: {
		intents: GuardrailBudgetIntent[];
		reservedMicros: number;
		now?: Date;
	};
	privateByokGatewayKey: {
		/** Authentication snapshot of `api_keys.include_byok_in_limit`. */
		includeInLimit: boolean;
		/** Maximum of charged and list-price ceilings for route-selective fallback. */
		reservedMicros: number;
	};
};

function admissionError(
	code: GatewayErrorCodeValue,
	message: string,
): RequestBudgetAdmissionError {
	return new RequestBudgetAdmissionError({ code, message });
}

/**
 * Coordinates both budget ledgers at the credential-aware dispatch boundary.
 *
 * The stable ordinary lease starts as a proven zero-cost lease, so a successful
 * private BYOK request can flow through existing settlement code without a
 * database reservation. The delegate switches to the paid lease before the
 * first shared/platform fetch and remains stable for all later attempts.
 */
export async function createRouteAwareBudgetAdmission(
	repositories: GatewayRepositories,
	params: CreateRouteAwareBudgetAdmissionParams,
	options: {
		ordinaryBudgetRepositories?: OrdinaryBudgetRepositories;
		ordinaryRecoveryFailureMode?: 'warn' | 'fail_closed';
		guardrailBudgetRequestPort?: GuardrailBudgetRequestPort;
	} = {},
): Promise<RouteAwareBudgetAdmission> {
	// Callers may retain and mutate their input objects while admission awaits
	// database work. Keep both ledgers on the same request, quote and intents.
	params = {
		ordinary: {
			...params.ordinary,
			now: params.ordinary.now === undefined
				? undefined : new Date(params.ordinary.now.getTime()),
		},
		guardrail: {
			...params.guardrail,
			intents: params.guardrail.intents.map(intent => ({ ...intent })),
			now: params.guardrail.now === undefined
				? undefined : new Date(params.guardrail.now.getTime()),
		},
		privateByokGatewayKey: { ...params.privateByokGatewayKey },
	};
	// Keep the validated request owner fixed across the free admission await and
	// every later credential-aware route transition.
	const guardrailPort = options.guardrailBudgetRequestPort;
	const ordinaryRecoveryFailureMode = options.ordinaryRecoveryFailureMode;
	if (guardrailPort) {
		const guardrailIdentity = guardrailPort.identity;
		if (guardrailIdentity?.requestId !== params.ordinary.requestId
			|| guardrailIdentity.userId !== params.ordinary.userId
			|| guardrailIdentity.apiKeyId !== params.ordinary.apiKeyId) {
			throw new TypeError('Guardrail request owner identity differs from authenticated budget request');
		}
		if (!(params.guardrail.now instanceof Date)
			|| !Number.isFinite(params.guardrail.now.getTime())) {
			throw new TypeError('Guardrail request owner requires a fixed admission time');
		}
	}
	const ordinaryRepositories = options.ordinaryBudgetRepositories ?? repositories;
	const freeAdmission = await reserveOrdinaryUserBudget(ordinaryRepositories, {
		...params.ordinary,
		estimatedChargedCost: 0,
	});
	if (!freeAdmission.ok) {
		throw new Error(`Could not initialize request budget admission: ${freeAdmission.error.message}`);
	}

	let activeOrdinaryLease = freeAdmission.lease;
	let guardrailReserved = false;
	let guardrailDispatched = false;
	let guardrailTerminal = false;
	let byokKeyReservationEstablished = false;
	let paidAdmissionPromise: Promise<void> | null = null;
	let byokAdmissionPromise: Promise<void> | null = null;
	let dispatchPromise: Promise<void> | null = null;
	let admissionMode: 'none' | 'legacy' | 'single_grant' = 'none';
	const gatewayKeyIntent = params.guardrail.intents.find((intent) =>
		isGatewayKeyLimitIntent(intent) && intent.scopeId === params.ordinary.apiKeyId
	) ?? null;

	const ordinaryLease: OrdinaryBudgetLease = {
		get kind() { return activeOrdinaryLease.kind; },
		get requestId() { return activeOrdinaryLease.requestId; },
		get userId() { return activeOrdinaryLease.userId; },
		get apiKeyId() { return activeOrdinaryLease.apiKeyId; },
		get reservedMicros() { return activeOrdinaryLease.reservedMicros; },
		get budgetEpoch() { return activeOrdinaryLease.budgetEpoch; },
		get limitMicros() { return activeOrdinaryLease.limitMicros; },
		get state() { return activeOrdinaryLease.state; },
		get reserved() { return activeOrdinaryLease.reserved; },
		beforeUpstreamDispatch(now?: Date) {
			return activeOrdinaryLease.beforeUpstreamDispatch(now);
		},
		releasePreDispatch(reason: string, now?: Date) {
			return activeOrdinaryLease.releasePreDispatch(reason, now);
		},
		forfeitPostDispatchUnknown(reason: string, now?: Date) {
			return activeOrdinaryLease.forfeitPostDispatchUnknown(reason, now);
		},
		terminateUnknown(reason: string, now?: Date) {
			return activeOrdinaryLease.terminateUnknown(reason, now);
		},
	};

	const releasePaidOrdinaryAdmission = async (
		lease: OrdinaryBudgetLease,
		reason: string,
	): Promise<void> => {
		if (lease.state !== 'reserved') return;
		await lease.releasePreDispatch(reason);
		// A confirmed release may restore the original BYOK/free view. A failed
		// write must leave the reserved delegate reachable by the request owner.
		if (activeOrdinaryLease === lease) activeOrdinaryLease = freeAdmission.lease;
	};

	const ensurePaidAdmission = async (): Promise<void> => {
		paidAdmissionPromise ??= (async () => {
			const ordinaryAdmission = await reserveOrdinaryUserBudget(
				ordinaryRepositories,
				params.ordinary,
				{ recoveryFailureMode: ordinaryRecoveryFailureMode },
			);
			if (!ordinaryAdmission.ok) {
				throw admissionError(GatewayErrorCode.budgetExceeded, ordinaryAdmission.error.message);
			}
			// Publish ownership as soon as the reservation exists. Guardrail
			// admission or its compensating release can fail; the outer request
			// owner must still be able to retry Ordinary cleanup in that case.
			activeOrdinaryLease = ordinaryAdmission.lease;

			let guardrailAdmission: GuardrailBudgetAdmissionResult;
			try {
				guardrailAdmission = guardrailPort
					? byokKeyReservationEstablished
						? await guardrailPort.extend({
							intents: params.guardrail.intents,
							reservedMicros: params.guardrail.reservedMicros,
							now: params.guardrail.now ?? new Date(),
						})
						: await guardrailPort.reserve({
							intents: params.guardrail.intents,
							reservedMicros: params.guardrail.reservedMicros,
							now: params.guardrail.now ?? new Date(),
						})
					: byokKeyReservationEstablished
					? await extendDispatchedRequestGuardrailBudgets(repositories, {
							requestId: params.ordinary.requestId,
							intents: params.guardrail.intents,
							reservedMicros: params.guardrail.reservedMicros,
							now: params.guardrail.now,
						})
					: await reserveRequestGuardrailBudgets(repositories, {
							requestId: params.ordinary.requestId,
							intents: params.guardrail.intents,
							reservedMicros: params.guardrail.reservedMicros,
							now: params.guardrail.now,
						});
			} catch (error) {
				await releasePaidOrdinaryAdmission(
					ordinaryAdmission.lease,
					'guardrail_budget_admission_failed',
				).catch(() => undefined);
				throw error;
			}
			if (!guardrailAdmission.ok) {
				await releasePaidOrdinaryAdmission(
					ordinaryAdmission.lease,
					'guardrail_budget_admission_rejected',
				);
				if (guardrailAdmission.blocked) {
					const code = guardrailAdmission.reason === 'guardrail_budget'
						? GatewayErrorCode.guardrailBlocked
						: GatewayErrorCode.budgetExceeded;
					throw admissionError(code, guardrailAdmission.message);
				}
				throw new Error(`Guardrail budget admission failed: ${guardrailAdmission.message}`);
			}

			guardrailReserved = guardrailReserved || guardrailAdmission.reserved;
			// A previous BYOK dispatch only transitioned the key-limit lease. The
			// newly installed ordinary lease must cross its own dispatch boundary.
			dispatchPromise = null;
		})();
		await paidAdmissionPromise;
	};

	const ensurePrivateByokKeyAdmission = async (): Promise<void> => {
		if (
			params.privateByokGatewayKey.includeInLimit !== true
			|| gatewayKeyIntent == null
			|| params.privateByokGatewayKey.reservedMicros === 0
		) return;
		byokAdmissionPromise ??= (async () => {
			const admission = guardrailPort
				? await guardrailPort.reserve({
					intents: [gatewayKeyIntent],
					reservedMicros: params.privateByokGatewayKey.reservedMicros,
					settlementBasis: 'gateway_key_route',
					now: params.guardrail.now ?? new Date(),
				})
				: await reserveRequestGuardrailBudgets(repositories, {
				requestId: params.ordinary.requestId,
				intents: [gatewayKeyIntent],
				reservedMicros: params.privateByokGatewayKey.reservedMicros,
				settlementBasis: 'gateway_key_route',
				now: params.guardrail.now,
			});
			if (!admission.ok) {
				if (admission.blocked) {
					throw admissionError(GatewayErrorCode.budgetExceeded, admission.message);
				}
				throw new Error(`BYOK Gateway key limit admission failed: ${admission.message}`);
			}
			guardrailReserved = admission.reserved;
			byokKeyReservationEstablished = admission.reserved;
		})();
		await byokAdmissionPromise;
	};

	const releaseGuardrailPreDispatch = async (reason: string): Promise<void> => {
		if (!guardrailReserved || guardrailTerminal) return;
		if (guardrailDispatched) {
			throw new Error('A dispatched Guardrail budget reservation cannot be released');
		}
		if (guardrailPort) {
			await guardrailPort.releasePreDispatch(reason);
		} else {
			await releaseRequestGuardrailBudgets(
				repositories,
				params.ordinary.requestId,
				guardrailReserved,
				reason,
			);
		}
		guardrailTerminal = true;
		guardrailReserved = false;
	};

	const forfeitGuardrailPostDispatch = async (reason: string): Promise<void> => {
		if (!guardrailReserved || guardrailTerminal) return;
		if (!guardrailDispatched) {
			await releaseGuardrailPreDispatch(reason);
			return;
		}
		if (guardrailPort) {
			await guardrailPort.forfeitPostDispatch(reason);
		} else {
			await forfeitRequestGuardrailBudgets(
				repositories,
				params.ordinary.requestId,
				guardrailReserved,
				reason,
			);
		}
		guardrailTerminal = true;
		guardrailReserved = false;
	};

	const reserveForRoute = async (route: RouteResult): Promise<boolean> => {
		if (isPrivateByokRoute(route) && activeOrdinaryLease.state !== 'dispatched') {
			await ensurePrivateByokKeyAdmission();
			return byokKeyReservationEstablished;
		} else {
			await ensurePaidAdmission();
			return true;
		}
	};

	const markDispatched = async (): Promise<void> => {
		dispatchPromise ??= (async () => {
			if (guardrailReserved && !guardrailDispatched) {
				try {
					if (guardrailPort) {
						await guardrailPort.markDispatched(
							params.guardrail.now ?? new Date(),
						);
					} else {
						await markRequestGuardrailBudgetsDispatched(
							repositories,
							params.ordinary.requestId,
							guardrailReserved,
							params.guardrail.now,
						);
					}
					guardrailDispatched = true;
				} catch (error) {
					await releaseGuardrailPreDispatch('upstream_dispatch_not_started').catch(() => undefined);
					await activeOrdinaryLease.terminateUnknown('guardrail_dispatch_mark_failed').catch(() => undefined);
					throw error;
				}
			}
			try {
				await activeOrdinaryLease.beforeUpstreamDispatch(params.guardrail.now);
			} catch (error) {
				// The Guardrail ledger already crossed its conservative dispatch
				// boundary. Fail closed and preserve that ceiling if its paired
				// ordinary transition cannot be made durable.
				await forfeitGuardrailPostDispatch('ordinary_dispatch_mark_failed').catch(() => undefined);
				await activeOrdinaryLease.terminateUnknown('ordinary_dispatch_mark_failed').catch(() => undefined);
				throw error;
			}
		})();
		await dispatchPromise;
	};

	const beforeUpstreamDispatch = async (route: RouteResult): Promise<void> => {
		if (admissionMode === 'single_grant') throw new Error('Single-grant budget admission already owns this request');
		admissionMode = 'legacy';
		if (await reserveForRoute(route)) await markDispatched();
	};

	const prepareSingleGrant = async (route: RouteResult): Promise<SingleGrantBudgetTicket> => {
		if (admissionMode !== 'none') throw new Error('Request budget admission mode already selected');
		// Freeze the mode before yielding so a sibling cannot use the legacy dispatch path.
		admissionMode = 'single_grant';
		const shouldMark = await reserveForRoute(route);
		const preparedOrdinaryLease = activeOrdinaryLease;
		let state: 'prepared' | 'marking' | 'dispatched' | 'releasing' | 'release_failed' | 'released' | 'unknown' = 'prepared';
		return Object.freeze({
			async markAfterCommittedClaim(): Promise<void> {
				if (state !== 'prepared') throw new Error('Single-grant budget ticket already resolved');
				state = 'marking';
				try { if (shouldMark) await markDispatched(); state = 'dispatched'; }
				catch (error) { state = 'unknown'; throw error; }
			},
			async releaseAfterDefiniteNoClaim(): Promise<void> {
				if (state !== 'prepared' && state !== 'release_failed') {
					throw new Error('Single-grant budget ticket cannot be released');
				}
				state = 'releasing';
				try {
					await releaseGuardrailPreDispatch('dispatch_claim_not_granted');
					await releasePaidOrdinaryAdmission(preparedOrdinaryLease, 'dispatch_claim_not_granted');
					state = 'released';
				} catch (error) { state = 'release_failed'; throw error; }
			},
			holdAfterUncertainClaim(): void {
				if (state !== 'prepared') throw new Error('Single-grant budget ticket already resolved');
				state = 'unknown';
			},
		});
	};

	return {
		ordinaryLease,
		get guardrailReserved() { return guardrailReserved; },
		get guardrailDispatched() { return guardrailDispatched; },
		get guardrailTerminal() { return guardrailTerminal; },
		beforeUpstreamDispatch,
		prepareSingleGrant,
		releaseGuardrailPreDispatch,
		forfeitGuardrailPostDispatch,
		async terminateGuardrailUnknown(reason: string): Promise<void> {
			if (guardrailDispatched) await forfeitGuardrailPostDispatch(reason);
			else await releaseGuardrailPreDispatch(reason);
		},
	};
}
