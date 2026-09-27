import type { PostgresDatabaseClient } from '@octafuse/core';
import type { OrdinaryBudgetRepositories } from './ordinary-budget-lifecycle';
import type { GuardrailBudgetRequestPort } from './request-budget-admission';
import { openPostgresOrdinaryBudgetRequestOwner } from './postgres-ordinary-budget-request-owner';
import { openPostgresGuardrailBudgetRequestPortV356 } from './postgres-guardrail-budget-request-port-v356';
import type { FinalChatQuoteInput } from './chat-final-quote-input';

type OrdinaryOwner = Awaited<ReturnType<typeof openPostgresOrdinaryBudgetRequestOwner>>;
type GuardrailOwner = Awaited<ReturnType<typeof openPostgresGuardrailBudgetRequestPortV356>>;
export type PostgresChatBudgetRequestIdentity = Readonly<{
	requestId: string;
	userId: string;
	apiKeyId: string;
	expectedBudgetEpoch: number;
}>;
export type PostgresChatBudgetRequestOwner = Readonly<{
	ordinaryBudgetRepositories: OrdinaryBudgetRepositories;
	guardrailBudgetRequestPort: GuardrailBudgetRequestPort;
	close(): Promise<void>;
}>;
export type PostgresChatBudgetRequestOwnerParams = Readonly<{
	runtimeClient: PostgresDatabaseClient;
	runtimeConnectionString: string;
	admissionConnectionString: string;
	recoveryConnectionString: string;
	/** Final post-transform request bytes for a future DB quote issuer. */
	finalQuoteInput?: FinalChatQuoteInput;
	identity: PostgresChatBudgetRequestIdentity;
}>;

export class PostgresChatBudgetRequestCleanupUnconfirmedError extends Error {
	constructor(cause: unknown) {
		super('PostgreSQL Chat budget request owner cleanup was not confirmed', { cause });
		this.name = 'PostgresChatBudgetRequestCleanupUnconfirmedError';
	}
}

/**
 * Default-off request composition. Ordinary and Guardrail ledgers share a
 * request identity, but each owner creates its own direct LOGIN clients. An
 * uncertain partial-open or close keeps the request's resource receipt open.
 */
export async function openPostgresChatBudgetRequestOwner(
	params: PostgresChatBudgetRequestOwnerParams,
	openers: {
		ordinary?: typeof openPostgresOrdinaryBudgetRequestOwner;
		guardrail?: typeof openPostgresGuardrailBudgetRequestPortV356;
	} = {},
): Promise<PostgresChatBudgetRequestOwner> {
	const fixed = Object.freeze({ ...params, identity: Object.freeze({ ...params.identity }) });
	if (fixed.finalQuoteInput && fixed.finalQuoteInput.requestId !== fixed.identity.requestId) {
		throw new TypeError('PostgreSQL Chat final quote request identity mismatch');
	}
	const ordinary: OrdinaryOwner = await (openers.ordinary ?? openPostgresOrdinaryBudgetRequestOwner)({
		runtimeClient: fixed.runtimeClient,
		runtimeConnectionString: fixed.runtimeConnectionString,
		admissionConnectionString: fixed.admissionConnectionString,
		recoveryConnectionString: fixed.recoveryConnectionString,
		identity: fixed.identity,
	});
	let guardrail: GuardrailOwner;
	try {
		guardrail = await (openers.guardrail ?? openPostgresGuardrailBudgetRequestPortV356)({
			runtimeClient: fixed.runtimeClient,
			runtimeConnectionString: fixed.runtimeConnectionString,
			admissionConnectionString: fixed.admissionConnectionString,
			requestId: fixed.identity.requestId,
			userId: fixed.identity.userId,
			apiKeyId: fixed.identity.apiKeyId,
		});
	} catch (error) {
		try { await ordinary.close(); }
		catch (cleanupError) {
			throw new PostgresChatBudgetRequestCleanupUnconfirmedError(
				new AggregateError([error, cleanupError], 'Chat budget owner open and cleanup failed'),
			);
		}
		throw error;
	}
	let closing: Promise<void> | undefined;
	return Object.freeze({
		ordinaryBudgetRepositories: ordinary.ordinaryBudgetRepositories,
		guardrailBudgetRequestPort: guardrail,
		close() {
			closing ??= (async () => {
				const results = await Promise.allSettled([ordinary.close(), guardrail.close()]);
				const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
				if (errors.length > 0) {
					throw new PostgresChatBudgetRequestCleanupUnconfirmedError(
						new AggregateError(errors, 'One or more Chat budget owner closes were unconfirmed'),
					);
				}
			})();
			return closing;
		},
	});
}
