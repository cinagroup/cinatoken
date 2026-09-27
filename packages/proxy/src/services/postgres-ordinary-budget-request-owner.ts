import postgres from 'postgres';
import type { GatewayRepositories, PostgresDatabaseClient } from '@octafuse/core';
import type {
	OrdinaryBudgetRepositories,
	ReserveOrdinaryBudgetParams,
} from './ordinary-budget-lifecycle';
import {
	openPostgresOrdinaryBudgetAdmissionOwner,
} from './postgres-ordinary-budget-admission';
import {
	openPostgresOrdinaryBudgetRecoveryOwner,
} from './postgres-ordinary-budget-recovery';
import {
	createRouteAwareBudgetAdmission,
	type CreateRouteAwareBudgetAdmissionParams,
	type RouteAwareBudgetAdmission,
} from './request-budget-admission';

type SqlFactory = (
	connectionString: string,
	options: { max: 1 },
) => PostgresDatabaseClient['raw'];
type RequestIdentity = Readonly<Pick<ReserveOrdinaryBudgetParams,
	'requestId' | 'userId' | 'apiKeyId' | 'expectedBudgetEpoch'>>;

export class PostgresOrdinaryBudgetRequestCleanupUnconfirmedError extends Error {
	constructor(cause: unknown) {
		super('PostgreSQL ordinary budget request owner cleanup was not confirmed', { cause });
		this.name = 'PostgresOrdinaryBudgetRequestCleanupUnconfirmedError';
	}
}

function validIdentity(identity: RequestIdentity): RequestIdentity {
	if (typeof identity?.requestId !== 'string' || identity.requestId.length < 1
		|| identity.requestId.length > 128
		|| typeof identity.userId !== 'string' || identity.userId.length < 1
		|| identity.userId.length > 512
		|| typeof identity.apiKeyId !== 'string' || identity.apiKeyId.length < 1
		|| identity.apiKeyId.length > 512
		|| !Number.isSafeInteger(identity.expectedBudgetEpoch)
		|| identity.expectedBudgetEpoch < 0) {
		throw new TypeError('PostgreSQL ordinary budget request identity invalid');
	}
	return Object.freeze({ ...identity });
}

function assertRequestId(requestId: string, identity: RequestIdentity): void {
	if (requestId !== identity.requestId) {
		throw new TypeError('PostgreSQL ordinary budget request identity mismatch');
	}
}

function assertAdmissionIdentity(
	params: Pick<ReserveOrdinaryBudgetParams,
		'requestId' | 'userId' | 'apiKeyId' | 'expectedBudgetEpoch'>,
	identity: RequestIdentity,
): void {
	if (params.requestId !== identity.requestId
		|| params.userId !== identity.userId
		|| params.apiKeyId !== identity.apiKeyId
		|| params.expectedBudgetEpoch !== identity.expectedBudgetEpoch) {
		throw new TypeError('PostgreSQL ordinary budget request identity mismatch');
	}
}

/**
 * Explicit request-local composition of the independent v350 admission and
 * v354 recovery LOGINs. The caller must close this owner in its request finally
 * block; no route opens it by default. Unknown COMMIT results are never replayed.
 */
export async function openPostgresOrdinaryBudgetRequestOwner(
	params: {
		runtimeClient: PostgresDatabaseClient;
		runtimeConnectionString: string;
		admissionConnectionString: string;
		recoveryConnectionString: string;
		identity: RequestIdentity;
	},
	factories: {
		admission?: SqlFactory;
		recovery?: SqlFactory;
	} = {},
): Promise<{
	readonly identity: RequestIdentity;
	readonly ordinaryBudgetRepositories: OrdinaryBudgetRepositories;
	createAdmission(
		repositories: GatewayRepositories,
		params: CreateRouteAwareBudgetAdmissionParams,
	): Promise<RouteAwareBudgetAdmission>;
	close(): Promise<void>;
}> {
	const identity = validIdentity(params.identity);
	if (params.admissionConnectionString === params.recoveryConnectionString) {
		throw new TypeError('PostgreSQL ordinary budget admission and recovery connections must be distinct');
	}
	let admissionSql: PostgresDatabaseClient['raw'] | undefined;
	const admissionFactory: SqlFactory = (connectionString, options) => {
		admissionSql = (factories.admission ?? postgres)(connectionString, options);
		return admissionSql;
	};
	const admissionOwner = await openPostgresOrdinaryBudgetAdmissionOwner({
		runtimeClient: params.runtimeClient,
		runtimeConnectionString: params.runtimeConnectionString,
		admissionConnectionString: params.admissionConnectionString,
	}, admissionFactory);
	let recoveryOwner: Awaited<ReturnType<typeof openPostgresOrdinaryBudgetRecoveryOwner>>;
	try {
		recoveryOwner = await openPostgresOrdinaryBudgetRecoveryOwner({
			runtimeClient: params.runtimeClient,
			runtimeConnectionString: params.runtimeConnectionString,
			recoveryConnectionString: params.recoveryConnectionString,
		}, (connectionString, options) => {
			const recoverySql = (factories.recovery ?? postgres)(connectionString, options);
			if (recoverySql === admissionSql) {
				throw new TypeError('PostgreSQL ordinary budget admission and recovery clients must be distinct');
			}
			return recoverySql;
		});
	} catch (error) {
		try { await admissionOwner.close(); }
		catch (cleanupError) {
			throw new PostgresOrdinaryBudgetRequestCleanupUnconfirmedError(
				new AggregateError([error, cleanupError], 'Owner open and cleanup both failed'),
			);
		}
		throw error;
	}

	let state: 'open' | 'closing' = 'open';
	let closing: Promise<void> | undefined;
	const assertOpen = (): void => {
		if (state !== 'open') throw new Error('PostgreSQL ordinary budget request owner is closed');
	};
	const admission = admissionOwner.ordinaryBudgetRepositories.userBudgets;
	const recovery = recoveryOwner.recovery;
	const ordinaryBudgetRepositories: OrdinaryBudgetRepositories = {
		userBudgets: {
			reserve: reserveParams => {
				assertOpen();
				assertAdmissionIdentity(reserveParams, identity);
				return admission.reserve(reserveParams);
			},
			markDispatched: (requestId, nowIso, expiresAtIso) => {
				assertOpen();
				assertRequestId(requestId, identity);
				return admission.markDispatched(requestId, nowIso, expiresAtIso);
			},
			release: (requestId, nowIso, reason) => {
				assertOpen();
				assertRequestId(requestId, identity);
				return admission.release(requestId, nowIso, reason);
			},
			forfeitDispatched: (requestId, nowIso, reason) => {
				assertOpen();
				assertRequestId(requestId, identity);
				return recovery.forfeitDispatched(requestId, nowIso, reason);
			},
			expireBefore: (nowIso, limit) => {
				assertOpen();
				return recovery.expireBefore(nowIso, limit);
			},
		},
	};
	return {
		identity,
		ordinaryBudgetRepositories,
		async createAdmission(repositories, admissionParams) {
			assertOpen();
			assertAdmissionIdentity(admissionParams.ordinary, identity);
			return createRouteAwareBudgetAdmission(repositories, admissionParams, {
				ordinaryBudgetRepositories,
				ordinaryRecoveryFailureMode: 'fail_closed',
			});
		},
		close() {
			closing ??= (async () => {
				state = 'closing';
				const results = await Promise.allSettled([
					admissionOwner.close(), recoveryOwner.close(),
				]);
				const failures = results.flatMap(result =>
					result.status === 'rejected' ? [result.reason] : []);
				if (failures.length > 0) {
					throw new PostgresOrdinaryBudgetRequestCleanupUnconfirmedError(
						new AggregateError(failures, 'One or more owner closes were unconfirmed'),
					);
				}
			})();
			return closing;
		},
	};
}
