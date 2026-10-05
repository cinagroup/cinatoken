/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { auditLogsResponseSchema } from './audit-log-contracts'
import { auditDiffs, auditDisplay, auditTime } from './audit-log-display'
import {
	auditLogsPath,
	defaultAuditEvents,
	parseAuditActorId,
	validateAuditLogSearch,
} from './audit-log-domain'

const row = {
	id: 'audit-1',
	user_id: 'user-1',
	api_key_id: 'key-1',
	user_email: 'a@example.test',
	event_type: 'guardrail_redacted',
	actor_type: 'admin',
	actor_id: 'admin:gateway_master_key',
	source: 'gateway_guardrails',
	before_spent: 0,
	after_spent: 0,
	delta_spent: 0,
	before_budget_max: null,
	after_budget_max: null,
	before_budget_base: 0,
	after_budget_base: 0,
	request_log_id: null,
	change_payload: null,
	before_user_snapshot: null,
	after_user_snapshot: null,
	changed_fields: null,
	created_at: '2026-09-28 02:05:06',
	private_db_column: 'must not enter page state',
}
const page = (value: object) => ({
	success: true,
	data: [value],
	total: 1,
	page: 1,
	page_size: 50,
	private_response_column: 'strip',
})

test('audit DTO projects extras, accepts Core event/source and strict UTC', () => {
	const parsed = auditLogsResponseSchema.parse(page(row))
	assert.equal(parsed.data[0].created_at, '2026-09-28T02:05:06.000Z')
	assert.equal('private_db_column' in parsed.data[0], false)
	assert.equal('private_response_column' in parsed, false)
	assert.equal(parsed.data[0].event_type, 'guardrail_redacted')
	assert.equal(
		auditLogsResponseSchema.safeParse(
			page({ ...row, event_type: 'future_legal_event', source: 'new_source' })
		).success,
		true
	)
	for (const created_at of [
		'2026-02-30 02:05:06',
		'2026-09-28T02:05:06+08:00',
		'bad',
	])
		assert.equal(
			auditLogsResponseSchema.safeParse(page({ ...row, created_at })).success,
			false
		)
	assert.equal(
		auditLogsResponseSchema.safeParse(page({ ...row, before_spent: Infinity }))
			.success,
		false
	)
	assert.equal(parseAuditActorId('admin:gateway_master_key').kind, 'admin')
})

test('all events is truly unfiltered; default shortcut excludes only usage charge', () => {
	const all = validateAuditLogSearch({
		page: '3',
		user_id: 'u 1',
		api_key_id: 'key-1',
		user_email: 'exact@example.test',
		start_date: '2026-09-28 00:00:00',
	})
	const path = new URL(auditLogsPath(all), 'https://example.test')
	assert.equal(path.searchParams.get('page'), '3')
	assert.equal(path.searchParams.get('page_size'), '50')
	assert.equal(path.searchParams.get('user_email'), 'exact@example.test')
	assert.equal(path.searchParams.get('user_id'), 'u 1')
	assert.equal(path.searchParams.has('event_type'), false)
	assert.equal(path.searchParams.has('end_date'), false)
	assert.equal(defaultAuditEvents.includes('usage_charge'), false)
	assert.equal(defaultAuditEvents.includes('guardrail_redacted'), true)
	const selected = validateAuditLogSearch({
		event_type: ['admin_adjust', 'future_legal_event'],
		source: ['gateway_guardrails', 'new_source'],
		actor_kind: ['admin'],
		reason_code: ['test_reason'],
	})
	const params = new URL(auditLogsPath(selected), 'https://example.test')
		.searchParams
	assert.deepEqual(params.getAll('event_type'), [
		'admin_adjust',
		'future_legal_event',
	])
	assert.deepEqual(params.getAll('source'), [
		'gateway_guardrails',
		'new_source',
	])
	assert.deepEqual(params.getAll('actor_kind'), ['admin'])
})

test('snapshot presence separates no limit, a finite limit and unknown history', () => {
	const unknown = auditDisplay(auditLogsResponseSchema.parse(page(row)).data[0])
	for (const field of [
		'beforeSpent',
		'afterSpent',
		'deltaSpent',
		'beforeMax',
		'afterMax',
		'beforeBase',
		'afterBase',
	] as const)
		assert.equal(unknown[field].kind, 'missing')
	const toFinite = auditDisplay(
		auditLogsResponseSchema.parse(
			page({
				...row,
				before_user_snapshot: JSON.stringify({
					budget_spent: 1,
					budget_max: null,
					budget_base: 2,
					budget_period: 'monthly',
					budget_reset_at: null,
				}),
				after_user_snapshot: JSON.stringify({
					budget_spent: 3,
					budget_max: 10,
					budget_base: 4,
					budget_period: 'weekly',
					budget_reset_at: '2026-10-01T00:00:00.000Z',
				}),
				before_spent: 1,
				after_spent: 3,
				delta_spent: 2,
				before_budget_max: null,
				after_budget_max: 10,
				before_budget_base: 2,
				after_budget_base: 4,
			})
		).data[0]
	)
	assert.equal(toFinite.beforeMax.kind, 'null')
	assert.deepEqual(toFinite.afterMax, { kind: 'value', value: 10 })
	assert.deepEqual(toFinite.deltaSpent, { kind: 'value', value: 2 })
	assert.equal(toFinite.beforeReset.kind, 'null')
	assert.deepEqual(toFinite.afterPeriod, { kind: 'value', value: 'weekly' })
	const toNull = auditDisplay(
		auditLogsResponseSchema.parse(
			page({
				...row,
				before_user_snapshot: '{"budget_max":20}',
				after_user_snapshot: '{"budget_max":null}',
				before_budget_max: 20,
				after_budget_max: null,
			})
		).data[0]
	)
	assert.deepEqual(toNull.beforeMax, { kind: 'value', value: 20 })
	assert.equal(toNull.afterMax.kind, 'null')
	const missingOneSide = auditDisplay(
		auditLogsResponseSchema.parse(
			page({
				...row,
				before_user_snapshot: '{}',
				after_user_snapshot: '{"budget_max":null}',
			})
		).data[0]
	)
	assert.equal(missingOneSide.beforeMax.kind, 'null')
	assert.equal(missingOneSide.afterMax.kind, 'null')
})

test('payload and snapshot details remain text, redacted and distinguish missing from null', () => {
	const parsed = auditLogsResponseSchema.parse(
		page({
			...row,
			before_user_snapshot: '{"status":null}',
			after_user_snapshot: '{"status":"active"}',
			change_payload:
				'{"metadata":{"from":{"api_key":"sk-secretsecretsecret"},"to":{"api_key":"sk-othersecretsecret"}},"note":"Bearer secret"}',
			changed_fields: '["status"]',
		})
	).data[0]
	const diffs = auditDiffs(parsed, 'MISSING', 'NULL')
	assert.deepEqual(
		diffs.find((part) => part.field === 'status'),
		{ group: 'snapshot', field: 'status', before: 'NULL', after: 'active' }
	)
	assert.equal(JSON.stringify(diffs).includes('sk-secret'), false)
	assert.equal(JSON.stringify(diffs).includes('Bearer secret'), false)
	assert.equal(
		auditTime('2026-09-28 02:05:06', null, 'en'),
		auditTime('2026-09-28T02:05:06.000Z', null, 'en')
	)
})
