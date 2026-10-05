/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { CinaTokenApiError } from '../../api'
import type { AdminSharedKeyAuditPage } from './audit-contracts'
import type { AdminSharedKeysApi } from './shared-key-api'
import { AdminSharedKeyInputError } from './shared-key-errors'
import type {
	AdminSharedKeyGovernanceMarker,
	AdminSharedKeyMarker,
	AdminSharedKeyReviewMarker,
} from './shared-key-marker'
import type { AdminSharedKeyWriteRecovery } from './shared-key-recovery'
import { validateAdminSharedKeySearch } from './shared-key-search'
import type { AdminSharedKeyBoundOptions } from './shared-key-subject'

export type SharedKeyRecoveryStage =
	'subject' | 'detail' | 'audit' | 'review' | 'storage'
export class SharedKeyManualRecoveryError extends Error {
	constructor(
		readonly stage: SharedKeyRecoveryStage,
		readonly status = 0
	) {
		super('Manual review could not be completed')
	}
}
async function guarded<T>(
	stage: SharedKeyRecoveryStage,
	action: () => Promise<T>,
	signal?: AbortSignal
): Promise<T> {
	try {
		signal?.throwIfAborted()
		const result = await action()
		signal?.throwIfAborted()
		return result
	} catch (error) {
		throw new SharedKeyManualRecoveryError(
			stage,
			error instanceof CinaTokenApiError ? error.status : 0
		)
	}
}
export type GovernanceRecoveryEvidence = {
	kind: 'governance'
	marker: AdminSharedKeyGovernanceMarker
	row: Awaited<ReturnType<AdminSharedKeysApi['adminSharedKeyRecoveryDetail']>>
	audit: AdminSharedKeyAuditPage
}
export type ReviewRecoveryEvidence = {
	kind: 'review'
	marker: AdminSharedKeyReviewMarker
	result: Awaited<ReturnType<AdminSharedKeysApi['reviewAdminEarnings']>>
}
export type SharedKeyRecoveryEvidence =
	GovernanceRecoveryEvidence | ReviewRecoveryEvidence
async function verifyRecoveryCapability(
	api: AdminSharedKeysApi,
	options: AdminSharedKeyBoundOptions,
	kind: 'governance' | 'review'
): Promise<void> {
	const page = await guarded(
		'detail',
		() => api.adminSharedKeyList(validateAdminSharedKeySearch({}), options),
		options.signal
	)
	const allowed =
		kind === 'governance'
			? page.capabilities.can_write
			: page.capabilities.can_review_earnings
	if (!allowed) throw new SharedKeyManualRecoveryError('subject', 403)
}
export async function inspectSharedKeyRecovery(
	api: AdminSharedKeysApi,
	marker: AdminSharedKeyMarker,
	options: AdminSharedKeyBoundOptions
): Promise<SharedKeyRecoveryEvidence> {
	await guarded(
		'subject',
		() => api.verifyAdminSharedKeyRecoverySubject(options),
		options.signal
	)
	if (marker.kind === 'review') {
		const result = await guarded(
			'review',
			() =>
				api.reviewAdminEarnings(
					{ since: marker.since, limit: marker.limit },
					false,
					options
				),
			options.signal
		)
		return { kind: 'review', marker, result }
	}
	await verifyRecoveryCapability(api, options, 'governance')
	const row = await guarded(
		'detail',
		() => api.adminSharedKeyRecoveryDetail(marker.keyId, options),
		options.signal
	)
	if (row && !row.capabilities.can_write)
		throw new SharedKeyManualRecoveryError('subject', 403)
	const audit = await guarded(
		'audit',
		() => api.adminSharedKeyAudit(marker.keyId, null, options),
		options.signal
	)
	return { kind: 'governance', marker, row, audit }
}
export async function readSharedKeyRecoveryAudit(
	api: AdminSharedKeysApi,
	marker: AdminSharedKeyGovernanceMarker,
	cursor: string | null,
	options: AdminSharedKeyBoundOptions
): Promise<AdminSharedKeyAuditPage> {
	await guarded(
		'subject',
		() => api.verifyAdminSharedKeyRecoverySubject(options),
		options.signal
	)
	return guarded(
		'audit',
		() => api.adminSharedKeyAudit(marker.keyId, cursor, options),
		options.signal
	)
}
/** This acknowledges uncertainty. It never confirms, replays, or compensates the original operation. */
export async function acknowledgeSharedKeyRecovery(
	api: AdminSharedKeysApi,
	store: AdminSharedKeyWriteRecovery,
	identity: string,
	evidence: SharedKeyRecoveryEvidence,
	acknowledged: boolean,
	options: AdminSharedKeyBoundOptions
): Promise<void> {
	if (!acknowledged) throw new AdminSharedKeyInputError()
	await guarded(
		'subject',
		() => api.verifyAdminSharedKeyRecoverySubject(options),
		options.signal
	)
	await verifyRecoveryCapability(api, options, evidence.kind)
	await guarded(
		'subject',
		() => api.verifyAdminSharedKeyRecoverySubject(options),
		options.signal
	)
	options.signal?.throwIfAborted()
	try {
		store.acknowledgeUnknown(identity, evidence.marker)
	} catch {
		throw new SharedKeyManualRecoveryError('storage')
	}
}
