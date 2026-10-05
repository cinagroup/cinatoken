/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DataPolicyListRow } from './data-policy-contracts'
import { filterDataPolicies, dataPolicySummary } from './data-policy-view'

const row = {
	route_target_id: 'target-1',
	model_id: 'model-1',
	provider_id: 'provider-1',
	provider_name: 'Provider A',
	provider_model_name: 'Model A',
	upstream_protocol: 'openai',
	upstream_operation: null,
	route_group: null,
	subject_fingerprint: 'abc',
	retention_days: 30,
	training_allowed: false,
	zdr_supported: true,
	evidence_url: 'https://example.com/a',
	verified_by: 'admin-1',
	verified_at: '2026-01-01T00:00:00.000Z',
	expires_at: '2027-01-01T00:00:00.000Z',
	status: 'verified',
	invalidated_at: null,
	invalidation_reason: null,
	updated_at: '2026-01-01T00:00:00.000Z',
	subject_matches_current: true,
	effective_status: 'verified',
} satisfies DataPolicyListRow

test('effective status, not stored status, controls verified filters and summary', () => {
	const changed: DataPolicyListRow = {
		...row,
		route_target_id: 'target-2',
		subject_matches_current: false,
		effective_status: 'unknown',
	}
	assert.deepEqual(dataPolicySummary([row, changed]), {
		total: 2,
		verified: 1,
		unconfigured: 0,
	})
	assert.deepEqual(
		filterDataPolicies([row, changed], { q: '', status: 'verified' }).map(
			(item) => item.route_target_id
		),
		['target-1']
	)
})

test('unconfigured targets remain in the list and searchable', () => {
	const unconfigured: DataPolicyListRow = {
		...row,
		route_target_id: 'empty-target',
		subject_fingerprint: null,
		status: 'unknown',
		effective_status: 'unknown',
	}
	assert.equal(dataPolicySummary([row, unconfigured]).unconfigured, 1)
	assert.deepEqual(
		filterDataPolicies([row, unconfigured], {
			q: 'EMPTY-TARGET',
			status: 'unknown',
		}).map((item) => item.route_target_id),
		['empty-target']
	)
})
