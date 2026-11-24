/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { auditWallet, formatAuditWalletMoney } from './audit-wallet'

const inspect = (before?: string | null, after?: string | null) =>
	auditWallet({ before_user_snapshot: before, after_user_snapshot: after })
const snapshot = (granted: unknown, spent: unknown) =>
	JSON.stringify({ wallet_granted: granted, wallet_spent: spent })

test('wallet history distinguishes missing, null, malformed and genuine zero without fabricating either side', () => {
	for (const before of [
		undefined,
		null,
		'',
		'{}',
		'{"wallet_granted":null,"wallet_spent":null}',
	]) {
		const value = inspect(before, snapshot(0, 0))
		assert.equal(value.granted.before.kind, 'missing')
		assert.deepEqual(value.granted.after, { kind: 'value', micros: 0n })
		assert.equal(value.granted.equal, false)
		assert.equal(value.balance.before.kind, 'missing')
	}
	for (const raw of ['{', '[]', 'null', 'true', '"not a snapshot"'])
		assert.equal(inspect(raw).balance.before.kind, 'invalid')
})
test('exact micro-unit subtraction preserves negative balance and single-sided unknown fields', () => {
	const value = inspect(
		snapshot('0.300001', '0.300002'),
		snapshot('1.000001', '0.3')
	)
	assert.deepEqual(value.balance.before, { kind: 'value', micros: -1n })
	assert.deepEqual(value.balance.after, { kind: 'value', micros: 700001n })
	assert.equal(
		inspect('{"wallet_granted":2}', snapshot(2, 0)).balance.before.kind,
		'missing'
	)
	assert.equal(
		inspect(snapshot(2, 0), '{"wallet_spent":0}').balance.after.kind,
		'missing'
	)
})
test('equal values compare exact normalized micro-units across numeric and decimal-string snapshots', () => {
	const value = inspect(snapshot(2, 0.3), snapshot('2.000000', '0.300000'))
	for (const pair of Object.values(value)) assert.equal(pair.equal, true)
	assert.equal(
		inspect(snapshot(2, 0), snapshot('2.000001', 0)).granted.equal,
		false
	)
})
test('large raw JSON number tokens retain the exact recorded micro-unit through parsing and subtraction', () => {
	const value = inspect(
		'{"wallet_granted":9007199254.740991,"wallet_spent":9007199254.740990}',
		'{"wallet_granted":9000000000.000001,"wallet_spent":9000000000}'
	)
	assert.deepEqual(value.granted.before, {
		kind: 'value',
		micros: 9007199254740991n,
	})
	assert.deepEqual(value.balance.before, { kind: 'value', micros: 1n })
	assert.deepEqual(value.granted.after, {
		kind: 'value',
		micros: 9000000000000001n,
	})
	assert.deepEqual(value.balance.after, { kind: 'value', micros: 1n })
})
test('escaped strings, fake wallet keys and nested metadata do not override top-level evidence', () => {
	const value = inspect(
		JSON.stringify({
			metadata: '"wallet_granted":999.999999; \\ 42',
			nested: { wallet_granted: 999, wallet_spent: 2 },
			wallet_granted: 3,
			wallet_spent: 2,
		})
	)
	assert.deepEqual(value.granted.before, { kind: 'value', micros: 3000000n })
	assert.deepEqual(value.balance.before, { kind: 'value', micros: 1000000n })
	assert.equal(
		inspect('{"metadata":{"wallet_granted":2,"wallet_spent":1}}').granted.before
			.kind,
		'missing'
	)
	assert.deepEqual(
		inspect('{"wallet\\u005fgranted":2,"wallet_spent":1}').balance.before,
		{ kind: 'value', micros: 1000000n }
	)
})
test('duplicate top-level keys retain JSON last-write semantics for numbers, strings and null', () => {
	assert.deepEqual(
		inspect('{"wallet_granted":1,"wallet_granted":2,"wallet_spent":0}').granted
			.before,
		{ kind: 'value', micros: 2000000n }
	)
	assert.deepEqual(
		inspect('{"wallet_granted":1,"wallet_granted":"2.000001","wallet_spent":0}')
			.granted.before,
		{ kind: 'value', micros: 2000001n }
	)
	assert.equal(
		inspect('{"wallet_granted":1,"wallet_granted":null}').granted.before.kind,
		'missing'
	)
	assert.equal(
		inspect('{"wallet_granted":1,"wallet_granted":"invalid"}').granted.before
			.kind,
		'invalid'
	)
})
test('JSON exponent numbers are accepted only when exact supported micro-units, without allowing exponent strings', () => {
	assert.deepEqual(
		inspect('{"wallet_granted":1e-6,"wallet_spent":0}').balance.before,
		{ kind: 'value', micros: 1n }
	)
	assert.deepEqual(
		inspect('{"wallet_granted":12e2,"wallet_spent":0}').granted.before,
		{ kind: 'value', micros: 1200000000n }
	)
	for (const raw of [
		'1e-7',
		'1e30',
		'1e999',
		'-1',
		'9007199254.740992',
		'0.30000000000000004',
	])
		assert.equal(
			inspect('{"wallet_granted":' + raw + ',"wallet_spent":0}').granted.before
				.kind,
			'invalid',
			raw
		)
	assert.equal(inspect(snapshot('1e-6', 0)).granted.before.kind, 'invalid')
})
test('invalid counters never coerce booleans, whitespace, objects, arrays or unsafe decimals to zero', () => {
	for (const invalid of [
		'',
		' ',
		' 2',
		'+2',
		'01',
		'NaN',
		'Infinity',
		'0.0000001',
		'-0.000001',
		true,
		[],
		{},
		'9'.repeat(129),
	]) {
		const value = inspect(snapshot(invalid, 0))
		assert.equal(value.granted.before.kind, 'invalid', JSON.stringify(invalid))
		assert.equal(value.balance.before.kind, 'invalid')
	}
	assert.deepEqual(
		inspect('{"wallet_granted":-0,"wallet_spent":0}').granted.before,
		{ kind: 'value', micros: 0n }
	)
})
test('unrelated recorded balance cannot substitute for missing components and input stays unchanged', () => {
	const log = Object.freeze({
		before_user_snapshot: '{"wallet_balance":8}',
		after_user_snapshot: snapshot(3, 4),
	})
	assert.equal(auditWallet(log).balance.before.kind, 'missing')
	assert.equal(log.before_user_snapshot, '{"wallet_balance":8}')
	assert.deepEqual(auditWallet(log).balance.after, {
		kind: 'value',
		micros: -1000000n,
	})
})
test('formatting never loses one micro-unit near the safe-micro limit and retains a negative fractional sign', () => {
	assert.equal(
		formatAuditWalletMoney(9007199254740991n, 'USD', 'en'),
		'$9,007,199,254.740991'
	)
	assert.equal(
		formatAuditWalletMoney(9000000000000001n, 'USD', 'en'),
		'$9,000,000,000.000001'
	)
	assert.equal(
		formatAuditWalletMoney(-9000000000000001n, 'USD', 'en'),
		'-$9,000,000,000.000001'
	)
	assert.equal(formatAuditWalletMoney(-1n, 'USD', 'en'), '-$0.000001')
	assert.equal(formatAuditWalletMoney(0n, 'USD', 'en'), '$0.000000')
})
test('six-decimal formatting follows all four locales and rejects invalid currency instead of throwing', () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'])
		for (const currency of ['USD', 'CNY']) {
			const expected = new Intl.NumberFormat(locale, {
				style: 'currency',
				currency,
				minimumFractionDigits: 6,
				maximumFractionDigits: 6,
			}).format(-1.000001)
			assert.equal(
				formatAuditWalletMoney(-1000001n, currency, locale),
				expected
			)
		}
	assert.equal(formatAuditWalletMoney(1n, 'not-a-currency', 'en'), null)
})
