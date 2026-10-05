/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	buildDataPolicyInput,
	draftFromDataPolicy,
	DataPolicyFormError,
	type DataPolicyDraft,
} from './data-policy-form'

const base: DataPolicyDraft = {
	status: 'unknown',
	retentionDays: '',
	trainingAllowed: true,
	zdrSupported: false,
	evidenceUrl: '',
	expiresLocal: '',
	originalExpiresLocal: '',
	originalExpiresAt: null,
}

function fails(
	draft: DataPolicyDraft,
	code: DataPolicyFormError['code']
): void {
	assert.throws(
		() => buildDataPolicyInput(draft),
		(error: unknown) => {
			assert.ok(error instanceof DataPolicyFormError)
			assert.equal(error.code, code)
			return true
		}
	)
}

test('unconfigured policy can be represented without pretending verification', () => {
	assert.deepEqual(buildDataPolicyInput(base), {
		status: 'unknown',
		retention_days: null,
		training_allowed: true,
		zdr_supported: false,
		evidence_url: null,
		expires_at: null,
	})
})

test('retention accepts zero and 36500, rejects fractional and out-of-range values', () => {
	assert.equal(
		buildDataPolicyInput({ ...base, retentionDays: '0' }).retention_days,
		0
	)
	assert.equal(
		buildDataPolicyInput({ ...base, retentionDays: '36500' }).retention_days,
		36500
	)
	for (const value of ['-1', '36501', '1.5', '1e2', 'Infinity'])
		fails({ ...base, retentionDays: value }, 'retention')
})

test('evidence must use HTTPS without URL credentials', () => {
	fails({ ...base, evidenceUrl: 'http://example.com/policy' }, 'evidence')
	fails(
		{ ...base, evidenceUrl: 'https://user:pass@example.com/policy' },
		'evidence'
	)
	assert.equal(
		buildDataPolicyInput({
			...base,
			evidenceUrl: ' https://example.com/policy ',
		}).evidence_url,
		'https://example.com/policy'
	)
})

test('verified requires evidence and a future expiry', () => {
	const future = new Date(Date.now() + 3_600_000)
	const local = draftFromDataPolicy({
		status: 'verified',
		retention_days: null,
		training_allowed: false,
		zdr_supported: true,
		evidence_url: 'https://example.com/a',
		expires_at: future.toISOString(),
	})
	assert.equal(buildDataPolicyInput(local).status, 'verified')
	fails({ ...local, evidenceUrl: '' }, 'verifiedEvidence')
	fails({ ...local, expiresLocal: '' }, 'verifiedExpiry')
	assert.deepEqual(buildDataPolicyInput(local).expires_at, future.toISOString())
})

test('invalid local calendar time is rejected', () => {
	fails({ ...base, expiresLocal: '2026-02-30T12:00:00' }, 'expiry')
})
