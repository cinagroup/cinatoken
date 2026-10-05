/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export type DataPolicyStatus = 'verified' | 'expired' | 'unknown'

export type DataPolicyEditable = {
	status: DataPolicyStatus
	retention_days: number | null
	training_allowed: boolean
	zdr_supported: boolean
	evidence_url: string | null
	expires_at: string | null
}

export type DataPolicyDraft = {
	status: DataPolicyStatus
	retentionDays: string
	trainingAllowed: boolean
	zdrSupported: boolean
	evidenceUrl: string
	expiresLocal: string
	originalExpiresLocal: string
	originalExpiresAt: string | null
}

export type DataPolicyFormErrorCode =
	'retention' | 'evidence' | 'expiry' | 'verifiedEvidence' | 'verifiedExpiry'

export class DataPolicyFormError extends Error {
	constructor(readonly code: DataPolicyFormErrorCode) {
		super(code)
		this.name = 'DataPolicyFormError'
	}
}

function localDateTime(value: string | null): string {
	if (!value) return ''
	const date = new Date(value)
	if (!Number.isFinite(date.getTime())) return ''
	const pad = (part: number): string => String(part).padStart(2, '0')
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function draftFromDataPolicy(row: DataPolicyEditable): DataPolicyDraft {
	const expiresLocal = localDateTime(row.expires_at)
	return {
		status: row.status,
		retentionDays:
			row.retention_days === null ? '' : String(row.retention_days),
		trainingAllowed: row.training_allowed,
		zdrSupported: row.zdr_supported,
		evidenceUrl: row.evidence_url ?? '',
		expiresLocal,
		originalExpiresLocal: expiresLocal,
		originalExpiresAt: row.expires_at,
	}
}

/** Keep the reviewed expiry in the draft; the PUT contract canonicalizes dates to milliseconds. */
function expiryFromDraft(draft: DataPolicyDraft): string | null {
	const raw = draft.expiresLocal.trim()
	if (!raw) return null
	if (raw === draft.originalExpiresLocal && draft.originalExpiresAt)
		return draft.originalExpiresAt
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(raw))
		throw new DataPolicyFormError('expiry')
	const date = new Date(raw)
	if (!Number.isFinite(date.getTime())) throw new DataPolicyFormError('expiry')
	const canonical = localDateTime(date.toISOString())
	if (canonical.slice(0, raw.length) !== raw)
		throw new DataPolicyFormError('expiry')
	return date.toISOString()
}

export function buildDataPolicyInput(
	draft: DataPolicyDraft,
	now = Date.now()
): DataPolicyEditable {
	const retentionRaw = draft.retentionDays.trim()
	const retentionDays = retentionRaw === '' ? null : Number(retentionRaw)
	if (
		retentionDays !== null &&
		(!/^\d+$/.test(retentionRaw) ||
			!Number.isInteger(retentionDays) ||
			retentionDays < 0 ||
			retentionDays > 36500)
	)
		throw new DataPolicyFormError('retention')
	let evidenceUrl: string | null = null
	if (draft.evidenceUrl.trim()) {
		try {
			const url = new URL(draft.evidenceUrl.trim())
			if (url.protocol !== 'https:' || url.username || url.password)
				throw new DataPolicyFormError('evidence')
			evidenceUrl = url.toString()
		} catch {
			throw new DataPolicyFormError('evidence')
		}
	}
	const expiresAt = expiryFromDraft(draft)
	if (draft.status === 'verified') {
		if (!evidenceUrl) throw new DataPolicyFormError('verifiedEvidence')
		if (!expiresAt || Date.parse(expiresAt) <= now)
			throw new DataPolicyFormError('verifiedExpiry')
	}
	return {
		status: draft.status,
		retention_days: retentionDays,
		training_allowed: draft.trainingAllowed,
		zdr_supported: draft.zdrSupported,
		evidence_url: evidenceUrl,
		expires_at: expiresAt,
	}
}
