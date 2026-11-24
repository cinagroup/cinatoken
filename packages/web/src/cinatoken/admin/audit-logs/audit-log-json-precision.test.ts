/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { AuditLog } from './audit-log-contracts'
import { auditDiffs, auditDisplay } from './audit-log-display'
import { auditCompatibilityFixture } from './audit-log-fixtures'

function diffs(patch: Partial<AuditLog>) {
	return auditDiffs(
		{
			...auditCompatibilityFixture,
			before_user_snapshot: null,
			after_user_snapshot: null,
			change_payload: null,
			changed_fields: null,
			...patch,
		},
		'MISSING',
		'NULL'
	)
}

test('audit snapshot differences preserve adjacent integers beyond binary precision', () => {
	assert.deepEqual(
		diffs({
			before_user_snapshot:
				'{"wallet_granted":9007199254740992,"negative":-9007199254740992}',
			after_user_snapshot:
				'{"wallet_granted":9007199254740993,"negative":-9007199254740993}',
		}),
		[
			{
				group: 'snapshot',
				field: 'wallet_granted',
				before: '9007199254740992',
				after: '9007199254740993',
			},
			{
				group: 'snapshot',
				field: 'negative',
				before: '-9007199254740992',
				after: '-9007199254740993',
			},
		]
	)
})

test('audit differences preserve decimal tails, exponent tokens and signed zero', () => {
	const rows = diffs({
		before_user_snapshot:
			'{"decimal":0.123456789012345678901,"exponent":1e400,"zero":-0}',
		after_user_snapshot:
			'{"decimal":0.123456789012345678902,"exponent":2E+400,"zero":0}',
	})
	assert.deepEqual(
		rows.map(({ before, after }) => [before, after]),
		[
			['0.123456789012345678901', '0.123456789012345678902'],
			['1e400', '2E+400'],
			['-0', '0'],
		]
	)
})

test('audit nested arrays and objects retain numeric tokens and numeric string types', () => {
	const rows = diffs({
		before_user_snapshot:
			'{"metadata":{"values":[9007199254740992,"9007199254740993",{"raw":"1e400"}]}}',
		after_user_snapshot:
			'{"metadata":{"values":[9007199254740993,"9007199254740993",{"raw":"1e400"}]}}',
	})
	assert.equal(rows.length, 1)
	assert.match(rows[0].before, /9007199254740992/u)
	assert.match(rows[0].after, /9007199254740993/u)
	assert.match(rows[0].after, /"9007199254740993"/u)
	assert.match(rows[0].after, /"raw": "1e400"/u)
})

test('audit type changes with matching visible labels quote only the string side', () => {
	const rows = diffs({
		before_user_snapshot:
			'{"number":1,"boolean":"false","nil":null,"text":"old","same":"same"}',
		after_user_snapshot:
			'{"number":"1","boolean":false,"nil":"NULL","text":"new","same":"same","new":"MISSING"}',
	})
	assert.deepEqual(
		rows.map(({ field, before, after }) => [field, before, after]),
		[
			['number', '1', '"1"'],
			['boolean', '"false"', 'false'],
			['nil', 'NULL', '"NULL"'],
			['text', 'old', 'new'],
			['new', 'MISSING', '"MISSING"'],
		]
	)
})

test('audit payload pairs and before/after fields keep exact numbers', () => {
	assert.deepEqual(
		diffs({
			change_payload:
				'{"amount":{"from":9007199254740992,"to":9007199254740993},"before_count":1e400,"after_count":2e400,"observed":9007199254740993,"raw":{"raw":"9007199254740993"}}',
		}),
		[
			{
				group: 'payload',
				field: 'amount',
				before: '9007199254740992',
				after: '9007199254740993',
			},
			{ group: 'payload', field: 'count', before: '1e400', after: '2e400' },
			{
				group: 'payload',
				field: 'observed',
				before: 'MISSING',
				after: '9007199254740993',
			},
			{
				group: 'payload',
				field: 'raw',
				before: 'MISSING',
				after: '{\n  "raw": "9007199254740993"\n}',
			},
		]
	)
})

test('audit precision differences continue redacting numeric credentials and nested secrets', () => {
	const rows = diffs({
		before_user_snapshot:
			'{"api_key":9007199254740992,"metadata":{"password":"private-before","count":9007199254740992}}',
		after_user_snapshot:
			'{"api_key":9007199254740993,"metadata":{"password":"private-after","count":9007199254740993}}',
		change_payload:
			'{"authorization":{"from":"Bearer private-a","to":"Bearer private-b"},"note":"https://example.test/?token=private-c&q=safe"}',
	})
	assert.equal(
		rows.some((row) => row.field === 'api_key'),
		false
	)
	const rendered = JSON.stringify(rows)
	assert.doesNotMatch(rendered, /private-/u)
	assert.match(rendered, /\[redacted\]/u)
	assert.match(rendered, /9007199254740993/u)
	assert.match(rendered, /q=safe/u)
})

test('audit malformed snapshots fail closed and invalid changed fields retain key-union fallback', () => {
	for (const raw of [
		'{broken',
		'{"value":1...[truncated]',
		'[]',
		'null',
		'1e400',
	])
		assert.deepEqual(
			diffs({
				before_user_snapshot: raw,
				after_user_snapshot: raw,
				change_payload: raw,
			}),
			[]
		)
	const rows = diffs({
		before_user_snapshot: '{"value":9007199254740992}',
		after_user_snapshot: '{"value":9007199254740993}',
		changed_fields: '[9007199254740993]',
	})
	assert.equal(rows.length, 1)
	assert.equal(rows[0].after, '9007199254740993')
})

test('audit own-key reads cannot manufacture prototype changes and preserve JSON own keys', () => {
	assert.deepEqual(
		diffs({
			before_user_snapshot: '{}',
			after_user_snapshot: '{}',
			changed_fields: '["toString","constructor","__proto__"]',
		}),
		[]
	)
	const rows = diffs({
		before_user_snapshot:
			'{"constructor":9007199254740992,"__proto__":{"n":9007199254740992}}',
		after_user_snapshot:
			'{"constructor":9007199254740993,"__proto__":{"n":9007199254740993}}',
	})
	assert.equal(rows.length, 2)
	assert.equal(rows[0].after, '9007199254740993')
	assert.match(rows[1].after, /9007199254740993/u)
})

test('audit display keeps the existing budget overview contract and diff exclusions', () => {
	const row = {
		...auditCompatibilityFixture,
		before_user_snapshot:
			'{"id":"u","budget_spent":1.5,"budget_max":10,"status":"active"}',
		after_user_snapshot:
			'{"id":"u","budget_spent":2,"budget_max":20,"status":"disabled"}',
		changed_fields: null,
		change_payload: null,
	}
	const overview = auditDisplay(row)
	assert.deepEqual(overview.beforeSpent, { kind: 'value', value: 1.5 })
	assert.deepEqual(overview.afterSpent, { kind: 'value', value: 2 })
	assert.deepEqual(auditDiffs(row, 'MISSING', 'NULL'), [
		{ group: 'snapshot', field: 'status', before: 'active', after: 'disabled' },
	])
})
