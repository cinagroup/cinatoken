import type { RouteAwareBudgetAdmission } from './request-budget-admission';
import { observeResourceCleanup, type ResourceCompletion } from './resource-completion';
import type { PostgresChatBudgetRequestOwner } from './postgres-chat-budget-request-owner';

/**
 * Register before response handoff. On a streamed response, the DB sessions
 * remain owned until the bounded usage writer finishes. On an early exit, both
 * ledgers must reach a terminal state before their sessions are closed.
 */
export function chatBudgetOwnerResourceCompletion(
	owner: PostgresChatBudgetRequestOwner,
	admission: RouteAwareBudgetAdmission | null,
	settlement: Promise<void> | null,
): ResourceCompletion {
	return observeResourceCleanup(async () => {
		let cleanupError: unknown;
		try {
			if (settlement) {
				await settlement;
			} else if (admission) {
				const cleanup = await Promise.allSettled([
					admission.terminateGuardrailUnknown('request_ended_without_usage_settlement'),
					admission.ordinaryLease.terminateUnknown('request_ended_without_usage_settlement'),
				]);
				const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
				if (failures.length > 0) {
					throw new AggregateError(failures, 'Chat foreground budget cleanup unconfirmed');
				}
			}
		} catch (error) {
			cleanupError = error;
		} finally {
			try { await owner.close(); }
			catch (error) {
				if (cleanupError !== undefined) {
					throw new AggregateError([cleanupError, error], 'Chat budget settlement and owner close failed');
				}
				throw error;
			}
		}
		if (cleanupError !== undefined) throw cleanupError;
	});
}
