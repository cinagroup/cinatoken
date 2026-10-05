/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { defaultParseSearch } from '@tanstack/react-router'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	canRejectChainWithdrawal,
	chainTransactionUrl,
	chainRejectReasonSchema,
} from './chain-operations-contracts'
import {
	chainWithdrawalFixture,
	chainNftMintFixture,
} from './chain-operations-fixtures'
import { chainRecordFieldValues } from './chain-operations-format'
import {
	chainOperationsListPath,
	chainOperationsLocalPage,
	validateChainOperationsSearch,
} from './chain-operations-search'
import { chainOperationsMessages } from './messages'

test('all withdrawal and NFT processing statuses have canonical safe filter URLs', () => {
	for (const kind of ['withdrawals', 'nft-mints'] as const) {
		const initial = kind === 'withdrawals' ? 'requested' : 'pending'
		for (const status of [
			initial,
			'processing',
			'submitted',
			'confirmed',
			'failed',
		]) {
			const search = validateChainOperationsSearch(
				{ status, page: '3', limit: '20' },
				kind
			)
			assert.equal(search.invalid, false)
			assert.equal(
				chainOperationsListPath(kind, search),
				'/api/admin/' + kind + '?status=' + status
			)
		}
		assert.equal(
			chainOperationsListPath(kind, validateChainOperationsSearch({}, kind)),
			'/api/admin/' + kind
		)
	}
})
test('malformed public search or financial and credential URL inputs prevent a list request', () => {
	for (const input of [
		{ limit: 0 },
		{ limit: '01' },
		{ page: -1 },
		{ page: [] },
		{ status: 'javascript:' },
		{ reason: 'private reason' },
		{ amount: 500 },
		{ walletAddress: 'private wallet' },
		{ key: 'private credential' },
		{ subject: 'other-user' },
		{ page: '100001' },
		{ limit: '21' },
		{ status: 'pending' },
	]) {
		const result = validateChainOperationsSearch(input, 'withdrawals')
		assert.equal(result.invalid, true)
		assert.throws(() => chainOperationsListPath('withdrawals', result))
		assert.equal('reason' in result, false)
		assert.equal('amount' in result, false)
	}
})
test('TanStack duplicate public parameters and a forged invalid flag cannot erase invalid URL state', () => {
	for (const raw of [
		'?status=requested&status=failed',
		'?page=1&page=2',
		'?limit=5&limit=10',
		'?reason=private&invalid=false',
		'?status=impossible&invalid=false',
		'?invalid=false&invalid=false',
	]) {
		const parsed = defaultParseSearch(raw)
		const result = validateChainOperationsSearch(parsed, 'withdrawals')
		assert.equal(result.invalid, true, raw)
		assert.throws(() => chainOperationsListPath('withdrawals', result))
	}
	assert.equal(
		validateChainOperationsSearch(
			{ status: 'all', page: 1, limit: 5, invalid: true },
			'withdrawals'
		).invalid,
		true
	)
	assert.throws(() =>
		chainOperationsListPath('withdrawals', {
			status: 'requested&reason=private' as 'requested',
			page: 1,
			limit: 5,
			invalid: false,
		})
	)
})
test('local pagination preserves all returned records and does not manufacture server pagination totals', () => {
	const rows = Array.from({ length: 43 }, (_, id) => ({ id }))
	assert.equal(chainOperationsLocalPage(rows, 1).rows.length, 20)
	assert.equal(chainOperationsLocalPage(rows, 2).rows[0].id, 20)
	assert.equal(chainOperationsLocalPage(rows, 3).rows.length, 3)
	assert.equal(chainOperationsLocalPage(rows, 4).outOfRange, true)
	assert.equal(chainOperationsLocalPage(rows, 4).totalPages, 3)
	assert.equal(chainOperationsLocalPage([], 1).outOfRange, false)
})
test('only requested withdrawals without a transaction offer rejection; processing never does', () => {
	assert.equal(canRejectChainWithdrawal(chainWithdrawalFixture), true)
	assert.equal(
		canRejectChainWithdrawal({
			...chainWithdrawalFixture,
			status: 'processing',
		}),
		false
	)
	assert.equal(
		canRejectChainWithdrawal({
			...chainWithdrawalFixture,
			status: 'submitted',
		}),
		false
	)
	assert.equal(
		canRejectChainWithdrawal({
			...chainWithdrawalFixture,
			txHash: '0x' + 'a'.repeat(64),
		}),
		false
	)
	assert.equal(canRejectChainWithdrawal(chainNftMintFixture), false)
})
test('explorer links require a supported chain and a real transaction hash, not a storage URL or guessed chain', () => {
	const hash = '0x' + 'a'.repeat(64)
	assert.equal(
		chainTransactionUrl({ chainId: 84532, txHash: hash }),
		'https://sepolia.basescan.org/tx/' + hash
	)
	assert.equal(
		chainTransactionUrl({ chainId: 8453, txHash: hash }),
		'https://basescan.org/tx/' + hash
	)
	for (const chainId of [1, 999, null])
		assert.equal(chainTransactionUrl({ chainId, txHash: hash }), null)
	for (const txHash of [
		'javascript:alert(1)',
		'https://example.test',
		'0xabc',
		null,
	])
		assert.equal(chainTransactionUrl({ chainId: 84532, txHash }), null)
})
test('withdrawal detail preserves amount/fee/net/token/currency/chain/timestamps and NFT detail preserves snapshots', () => {
	const fields = Object.fromEntries(
		chainRecordFieldValues(
			{ ...chainWithdrawalFixture, currency: 'CNY', tokenAmount: null },
			'en',
			'not recorded'
		)
	)
	for (const key of [
		'id',
		'user',
		'wallet',
		'status',
		'time',
		'updatedAt',
		'confirmedAt',
		'chainId',
		'tx',
		'failureReason',
		'amount',
		'fee',
		'net',
		'tokenAmount',
		'currency',
	])
		assert.equal(typeof fields[key], 'string')
	assert.equal(fields.currency, 'CNY')
	assert.equal(fields.tokenAmount, 'not recorded')
	assert.notEqual(fields.amount, '$12.50')
	const nft = Object.fromEntries(
		chainRecordFieldValues(chainNftMintFixture, 'en', 'not recorded')
	)
	assert.equal(nft.tokenId, '200')
	assert.equal(nft.valueSnapshot, '$250.00')
})
test('reason length follows the server Unicode character limit and rejects hidden controls', () => {
	assert.equal(
		chainRejectReasonSchema.safeParse('😀'.repeat(500)).success,
		true
	)
	assert.equal(
		chainRejectReasonSchema.safeParse('😀'.repeat(501)).success,
		false
	)
	assert.equal(chainRejectReasonSchema.safeParse('a\u200Bb').success, false)
	assert.equal(chainRejectReasonSchema.parse(' reviewed '), 'reviewed')
})
test('every supported language has complete independent operation, queue, conflict and unknown-recovery copy', () => {
	const expected = Object.keys(chainOperationsMessages.en).sort()
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const messages = chainOperationsMessages[locale]
		assert.deepEqual(Object.keys(messages).sort(), expected)
		for (const value of Object.values(messages))
			assert.equal(value.trim().length > 0, true)
		assert.equal(messages.queued.includes('{{count}}'), true)
		assert.equal(messages.queueConfirmHelp.includes('{{limit}}'), true)
		assert.notEqual(messages.manualReviewHelp, messages.rejected)
	}
	for (const locale of ['zh', 'ja', 'ko'] as const) {
		assert.notEqual(
			chainOperationsMessages[locale].processingReview,
			chainOperationsMessages.en.processingReview
		)
		assert.notEqual(
			chainOperationsMessages[locale].unknownWrite,
			chainOperationsMessages.en.unknownWrite
		)
	}
})
