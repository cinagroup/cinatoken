import type { GuardrailBudgetIntent } from '@octafuse/core';
import { guardrailBudgetAdmissionResult } from './request-guardrails';
import type { GuardrailBudgetRequestPort } from './request-budget-admission';
import { openPostgresGuardrailBudgetExtensionOwnerV355 } from './postgres-guardrail-budget-extension-v355';

const ADMISSION_LEASE_MS = 2 * 60 * 1000;
const DISPATCH_LEASE_MS = 15 * 60 * 1000;

type OwnerParams = Parameters<typeof openPostgresGuardrailBudgetExtensionOwnerV355>[0];
type OwnerFactory = (params: OwnerParams) => ReturnType<typeof openPostgresGuardrailBudgetExtensionOwnerV355>;

function validNow(now: Date): Date {
	if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
		throw new TypeError('PostgreSQL Guardrail request owner time invalid');
	}
	return new Date(now.getTime());
}

function snapshotIntents(intents: GuardrailBudgetIntent[]): GuardrailBudgetIntent[] {
	if (!Array.isArray(intents)) throw new TypeError('PostgreSQL Guardrail intents invalid');
	return intents.map(intent => ({ ...intent }));
}

/**
 * Review-only bridge into the route-aware coordinator. Recovery is performed
 * by the v353 direct LOGIN before reserve and must succeed; the legacy runtime
 * repository's swallowed-expiry path is never used. The caller owns close().
 */
export async function openPostgresGuardrailBudgetRequestPortV356(
	params: OwnerParams,
	openOwner: OwnerFactory = openPostgresGuardrailBudgetExtensionOwnerV355,
): Promise<GuardrailBudgetRequestPort & Readonly<{ close(): Promise<void> }>> {
	// The owner opens asynchronously. Keep the authenticated identity and
	// connection selection fixed before the first yield to its factory.
	const fixedParams = Object.freeze({ ...params });
	const owner = await openOwner(fixedParams);
	const requestId = fixedParams.requestId;
	const port: GuardrailBudgetRequestPort & Readonly<{ close(): Promise<void> }> = {
		identity: Object.freeze({ requestId, userId: fixedParams.userId, apiKeyId: fixedParams.apiKeyId }),
		async reserve(values) {
			if (values.intents.length === 0 || values.reservedMicros === 0) {
				return { ok: true as const, reserved: false };
			}
			const now = validNow(values.now);
			const result = await owner.lifecycle.reserveAfterRecovery({
				requestId,
				intents: snapshotIntents(values.intents),
				reservedMicros: values.reservedMicros,
				settlementBasis: values.settlementBasis,
				nowIso: now.toISOString(),
				expiresAtIso: new Date(now.getTime() + ADMISSION_LEASE_MS).toISOString(),
			});
			return guardrailBudgetAdmissionResult(result);
		},
		async extend(values) {
			if (values.intents.length === 0 || values.reservedMicros === 0) {
				return { ok: true as const, reserved: false };
			}
			const now = validNow(values.now);
			const result = await owner.extendDispatched({
				requestId,
				intents: snapshotIntents(values.intents),
				reservedMicros: values.reservedMicros,
				nowIso: now.toISOString(),
				expiresAtIso: new Date(now.getTime() + DISPATCH_LEASE_MS).toISOString(),
			});
			return guardrailBudgetAdmissionResult(result);
		},
		async markDispatched(now) {
			const at = validNow(now);
			const marked = await owner.lifecycle.admission.markDispatched(
				requestId, at.toISOString(),
				new Date(at.getTime() + DISPATCH_LEASE_MS).toISOString(),
			);
			if (!marked) throw new Error('PostgreSQL Guardrail dispatch mark was not confirmed');
		},
		async releasePreDispatch(reason) {
			const released = await owner.lifecycle.admission.releaseMany(
				requestId, new Date().toISOString(), reason,
			);
			if (released < 1) throw new Error('PostgreSQL Guardrail pre-dispatch release was not confirmed');
		},
		async forfeitPostDispatch(reason) {
			const forfeited = await owner.lifecycle.forfeitDispatched(reason);
			if (forfeited < 1) throw new Error('PostgreSQL Guardrail post-dispatch forfeit was not confirmed');
		},
		close: () => owner.close(),
	};
	return Object.freeze(port);
}
