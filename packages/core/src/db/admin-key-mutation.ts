import { parseApiKeyRateLimit } from '../lib/api-key-rate-limit';
import type { AdminKeyMutationWithAudit } from '../storage/gateway-repository-interfaces';
import { assertAndFinalizeUserAuditInsert } from './user-audit-catalog';
import { snapshotToJson, userRowToSnapshot, type UserAuditSnapshot } from './user-audit-snapshot';

export function assertAdminKeyMutation(mutation: AdminKeyMutationWithAudit): AdminKeyMutationWithAudit {
	const { expected, patch } = mutation;
	const hasName = Object.prototype.hasOwnProperty.call(patch, 'name');
	const hasStatus = Object.prototype.hasOwnProperty.call(patch, 'status');
	const hasMetadata = Object.prototype.hasOwnProperty.call(patch, 'metadata');
	const hasRateLimit = Object.prototype.hasOwnProperty.call(patch, 'rateLimit');
	if (!mutation.id || !expected.userId || !hasName && !hasStatus && !hasMetadata && !hasRateLimit) {
		throw new TypeError('Admin Key mutation requires an id, user and at least one field');
	}
	if (hasName && patch.name !== null && typeof patch.name !== 'string' ||
		hasStatus && typeof patch.status !== 'string' ||
		hasMetadata && patch.metadata !== null && typeof patch.metadata !== 'string' ||
		hasRateLimit && patch.rateLimit !== null && typeof patch.rateLimit !== 'string') {
		throw new TypeError('Invalid Admin Key patch field');
	}
	const changed =
		(hasName && patch.name !== expected.name) ||
		(hasStatus && patch.status !== expected.status) ||
		(hasMetadata && patch.metadata !== expected.metadata) ||
		(hasRateLimit && patch.rateLimit !== expected.rateLimit);
	if (changed && !mutation.audit) throw new TypeError('Changed Admin Key needs an audit');
	if (mutation.audit) {
		if (!mutation.expectedUserSnapshot ||
			mutation.expectedUserSnapshot.id !== expected.userId ||
			mutation.audit.beforeUserSnapshot !== snapshotToJson(mutation.expectedUserSnapshot) ||
			mutation.audit.afterUserSnapshot !== mutation.audit.beforeUserSnapshot) {
			throw new TypeError('Admin Key audit needs the matching current user snapshot');
		}
		const audit = assertAndFinalizeUserAuditInsert(mutation.audit);
		if (audit.userId !== expected.userId || audit.apiKeyId !== mutation.id ||
			audit.actorType !== 'admin' ||
			!['admin_adjust', 'key_revoked'].includes(audit.eventType)) {
			throw new TypeError('Admin Key audit does not identify the changed Key');
		}
		const repeatDelete =
			patch.status === 'revoked' && expected.status === 'revoked' &&
			audit.eventType === 'key_revoked' &&
			['admin_key_delete_tombstone', 'admin_user_key_delete_tombstone'].includes(audit.reasonCode ?? '');
		if (!changed && !repeatDelete) throw new TypeError('No-op Admin Key patch must not write a success audit');
		return { ...mutation, audit };
	}
	if (mutation.expectedUserSnapshot) throw new TypeError('Admin Key user snapshot requires an audit');
	return mutation;
}

export function matchesAdminKeyProfile(
	actual: { userId: string; workspaceId?: string; name: string | null; status: string; metadata: string | null; rateLimit?: string | null },
	expected: AdminKeyMutationWithAudit['expected']
): boolean {
	return actual.userId === expected.userId && (expected.workspaceId === undefined || actual.workspaceId === expected.workspaceId) && actual.name === expected.name &&
		actual.status === expected.status && actual.metadata === expected.metadata &&
		(expected.rateLimit === undefined || (actual.rateLimit ?? null) === expected.rateLimit);
}

/** MySQL/Postgres locking reads use the same normalization as the Admin audit snapshot. */
export function matchesAdminUserAuditSnapshot(
	actual: {
		id: string; email: string; budgetMax: string | number | null;
		budgetBase: string | number; budgetSpent: string | number;
		budgetPeriod: string; budgetResetAt: string | null;
		budgetEpoch: number; budgetReservedMicros: number; walletGranted?: string | number; walletSpent?: string | number; rateLimit?: string | null; status: string;
		metadata: string | null; chargedCostFactors: string | null;
		externalSystem: string | null; externalUserId: string | null;
	},
	expected: UserAuditSnapshot
): boolean {
	const current = userRowToSnapshot({
		id: actual.id, email: actual.email,
		budget_max: actual.budgetMax == null ? null : Number(actual.budgetMax),
		budget_base: Number(actual.budgetBase), budget_spent: Number(actual.budgetSpent),
		budget_period: actual.budgetPeriod, budget_reset_at: actual.budgetResetAt,
		budget_epoch: Number(actual.budgetEpoch),
		wallet_granted: Number(actual.walletGranted ?? 0),
		wallet_spent: Number(actual.walletSpent ?? 0),
		rate_limit: parseApiKeyRateLimit(actual.rateLimit),
		budget_reserved_micros: Number(actual.budgetReservedMicros),
		status: actual.status, metadata: actual.metadata,
		charged_cost_factors: actual.chargedCostFactors,
		external_system: actual.externalSystem,
		external_user_id: actual.externalUserId,
		created_at: '', updated_at: '',
	});
	return snapshotToJson(current) === snapshotToJson(expected);
}
