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
	type OrdinaryBudgetLease,
	type ReserveOrdinaryBudgetParams,
} from './ordinary-budget-lifecycle';
import {
	forfeitRequestGuardrailBudgets,
	extendDispatchedRequestGuardrailBudgets,
	markRequestGuardrailBudgetsDispatched,
	releaseRequestGuardrailBudgets,
	reserveRequestGuardrailBudgets,
} from './request-guardrails';

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
	releaseGuardrailPreDispatch(reason: string): Promise<void>;
	forfeitGuardrailPostDispatch(reason: string): Promise<void>;
	terminateGuardrailUnknown(reason: string): Promise<void>;
};

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
): Promise<RouteAwareBudgetAdmission> {
	const freeAdmission = await reserveOrdinaryUserBudget(repositories, {
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
	};

	const ensurePaidAdmission = async (): Promise<void> => {
		paidAdmissionPromise ??= (async () => {
			const ordinaryAdmission = await reserveOrdinaryUserBudget(
				repositories,
				params.ordinary,
			);
			if (!ordinaryAdmission.ok) {
				throw admissionError(GatewayErrorCode.budgetExceeded, ordinaryAdmission.error.message);
			}

			let guardrailAdmission: Awaited<ReturnType<typeof reserveRequestGuardrailBudgets>>;
			try {
				guardrailAdmission = byokKeyReservationEstablished
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

			activeOrdinaryLease = ordinaryAdmission.lease;
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
			const admission = await reserveRequestGuardrailBudgets(repositories, {
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
		await releaseRequestGuardrailBudgets(
			repositories,
			params.ordinary.requestId,
			guardrailReserved,
			reason,
		);
		guardrailTerminal = true;
		guardrailReserved = false;
	};

	const forfeitGuardrailPostDispatch = async (reason: string): Promise<void> => {
		if (!guardrailReserved || guardrailTerminal) return;
		if (!guardrailDispatched) {
			await releaseGuardrailPreDispatch(reason);
			return;
		}
		await forfeitRequestGuardrailBudgets(
			repositories,
			params.ordinary.requestId,
			guardrailReserved,
			reason,
		);
		guardrailTerminal = true;
		guardrailReserved = false;
	};

	const beforeUpstreamDispatch = async (route: RouteResult): Promise<void> => {
		if (isPrivateByokRoute(route) && activeOrdinaryLease.state !== 'dispatched') {
			await ensurePrivateByokKeyAdmission();
			if (!byokKeyReservationEstablished) return;
		} else {
			await ensurePaidAdmission();
		}
		dispatchPromise ??= (async () => {
			if (guardrailReserved && !guardrailDispatched) {
				try {
					await markRequestGuardrailBudgetsDispatched(
						repositories,
						params.ordinary.requestId,
						guardrailReserved,
						params.guardrail.now,
					);
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

	return {
		ordinaryLease,
		get guardrailReserved() { return guardrailReserved; },
		get guardrailDispatched() { return guardrailDispatched; },
		get guardrailTerminal() { return guardrailTerminal; },
		beforeUpstreamDispatch,
		releaseGuardrailPreDispatch,
		forfeitGuardrailPostDispatch,
		async terminateGuardrailUnknown(reason: string): Promise<void> {
			if (guardrailDispatched) await forfeitGuardrailPostDispatch(reason);
			else await releaseGuardrailPreDispatch(reason);
		},
	};
}
