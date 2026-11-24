/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	walletCreditFormInput,
	walletCreditInputSchema,
	walletCreditMatches,
	walletCreditReceiptSchema,
	walletCreditObservationSchema,
	validWalletCreditReference,
	walletCreditMicros,
} from './wallet-credit-contracts'
import {
	walletCreditFixtureInput as input,
	walletCreditFixtureReceipt as receipt,
	walletCreditFixtureUserId as userId,
} from './wallet-credit-fixtures'
import { WalletCreditRecovery } from './wallet-credit-recovery'

test('credit form accepts signed exact micro-units and freezes only supported fields', () => {
	assert.deepEqual(
		walletCreditFormInput({
			amount: ' 5.000001 ',
			kind: 'topup',
			external_ref: '  ORDER  ',
			reason: '  QA  ',
		}),
		{ amount: 5.000001, kind: 'topup', external_ref: 'ORDER', reason: 'QA' }
	)
	assert.equal(
		walletCreditFormInput({
			amount: '-0.000001',
			kind: 'refund',
			external_ref: 'ORDER',
			reason: '',
		}).amount,
		-0.000001
	)
	for (const amount of [
		'0',
		'-0',
		'1e-6',
		'0.0000001',
		'NaN',
		'Infinity',
		'+1',
		'01',
		'9007199254.740991',
	])
		assert.throws(
			() =>
				walletCreditFormInput({
					amount,
					kind: 'topup',
					external_ref: 'ORDER',
					reason: '',
				}),
			amount
		)
	for (const amount of [true, '1', [], 0, 1e-7, Infinity, 9007199254.740992])
		assert.equal(
			walletCreditInputSchema.safeParse({ ...input, amount }).success,
			false
		)
})
test('references remain literal Unicode and reject invalid UTF16, formatting and overlong values', () => {
	for (const ref of [
		'ORDER',
		'order',
		'é',
		'e\u0301',
		'😀'.repeat(255),
		' literal ',
	])
		assert.equal(validWalletCreditReference(ref), true, ref)
	for (const ref of [
		'',
		' ',
		'x'.repeat(256),
		'😀'.repeat(256),
		'x\ny',
		'x\u200by',
		'\uD800',
		'\uDC00',
	])
		assert.equal(validWalletCreditReference(ref), false)
})
test('large decimal text cannot silently change one micro-unit during Number conversion', () => {
	for (const amount of [
		'9000000000.000001',
		'-9000000000.000001',
		'9000000000.000003',
		'-9000000000.000003',
		'9007199254.740991',
		'-9007199254.740991',
	])
		assert.throws(
			() =>
				walletCreditFormInput({
					amount,
					kind: 'admin_adjust',
					external_ref: 'ORDER',
					reason: '',
				}),
			amount
		)
	for (const amount of [
		'9000000000',
		'9000000000.000002',
		'-9000000000.000002',
		'1.000001',
		'-0.000001',
	])
		assert.equal(
			walletCreditFormInput({
				amount,
				kind: 'admin_adjust',
				external_ref: 'ORDER',
				reason: '',
			}).amount,
			Number(amount)
		)
})
test('receipt validates exact counters, immutable operation math and identity', () => {
	assert.ok(walletCreditReceiptSchema.safeParse(receipt).success)
	assert.equal(walletCreditMatches(receipt, userId, input), true)
	for (const patch of [
		{ userId: crypto.randomUUID() },
		{ externalRef: 'another' },
		{ kind: 'refund' },
		{ amountMicros: 1 },
	])
		assert.equal(
			walletCreditMatches(
				{ ...receipt, ...patch } as typeof receipt,
				userId,
				input
			),
			false
		)
	for (const patch of [
		{ amountMicros: 0 },
		{ amountMicros: Number.MAX_SAFE_INTEGER + 1 },
		{ creditedAt: '2026-10-18' },
		{ after: { ...receipt.after, walletGranted: 25 } },
		{ after: { ...receipt.after, walletSpent: 4 } },
		{ before: { ...receipt.before, walletBalance: 16 } },
		{ after: { ...receipt.after, walletBalance: 0 } },
	])
		assert.equal(
			walletCreditReceiptSchema.safeParse({ ...receipt, ...patch }).success,
			false
		)
	assert.equal(walletCreditMicros(0.000001), 1)
	assert.equal(walletCreditMicros(0.0000001), null)
	assert.equal(
		walletCreditObservationSchema.safeParse({ version: 2, status: 'not_found' })
			.success,
		false
	)
})
function storage() {
	const values = new Map<string, string>()
	return {
		values,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value)
		},
		removeItem: (key: string) => {
			values.delete(key)
		},
	}
}
const identity = JSON.stringify(['portal-1', 'subject-1', 1])
test('frozen order survives remount/scope refresh but remains isolated by principal and target user', () => {
	const db = storage(),
		first = new WalletCreditRecovery(db),
		mutableInput = { ...input },
		marker = first.mark(identity, userId, mutableInput)
	mutableInput.amount = 999
	const second = new WalletCreditRecovery(db)
	assert.deepEqual(
		second.marker(JSON.stringify(['portal-1', 'subject-1', 5]), userId),
		marker
	)
	assert.equal(second.marker(identity, userId)?.input.amount, 5.000001)
	assert.equal(second.status(identity, crypto.randomUUID()), 'ready')
	assert.equal(
		second.status(JSON.stringify(['portal-1', 'subject-2', 1]), userId),
		'ready'
	)
	assert.throws(() => second.mark(identity, userId, input))
	assert.equal(second.status(identity, userId), 'pending')
	assert.throws(() =>
		second.confirm(identity, marker, { ...receipt, externalRef: 'wrong' })
	)
	assert.equal(second.status(identity, userId), 'pending')
	second.confirm(identity, marker, receipt)
	assert.equal(second.status(identity, userId), 'ready')
})
test('a late receipt cannot release a newer generation or altered frozen payload', () => {
	const db = storage(),
		store = new WalletCreditRecovery(db),
		old = store.mark(identity, userId, input)
	store.confirm(identity, old, receipt)
	const current = store.mark(identity, userId, input)
	assert.throws(() => store.confirm(identity, old, receipt))
	assert.equal(store.marker(identity, userId)?.generation, current.generation)
	assert.throws(() =>
		store.confirm(
			identity,
			{ ...current, input: { ...input, amount: 1 } },
			receipt
		)
	)
	assert.equal(store.status(identity, userId), 'pending')
})
test('corrupt, absent, failed or non-retained storage cannot enable another credit', () => {
	assert.equal(
		new WalletCreditRecovery(null).status(identity, userId),
		'unavailable'
	)
	const db = storage(),
		store = new WalletCreditRecovery(db)
	store.mark(identity, userId, input)
	const key = [...db.values.keys()][0]
	db.values.set(key, '{broken')
	assert.equal(store.status(identity, userId), 'pending')
	assert.equal(store.marker(identity, userId), null)
	assert.throws(() => store.mark(identity, userId, input))
	const faulty = new WalletCreditRecovery({
		getItem: () => null,
		setItem: () => {},
		removeItem: () => {},
	})
	assert.throws(() => faulty.mark(identity, userId, input))
	assert.equal(faulty.status(identity, userId), 'unavailable')
})
test('a failed removal restores the marker and prevents additional writes', () => {
	const db = storage(),
		store = new WalletCreditRecovery({
			...db,
			removeItem: () => {
				throw new Error('Storage failed')
			},
		})
	const marker = store.mark(identity, userId, input)
	assert.throws(() => store.confirm(identity, marker, receipt))
	assert.equal(store.status(identity, userId), 'unavailable')
	assert.ok(store.marker(identity, userId))
})
