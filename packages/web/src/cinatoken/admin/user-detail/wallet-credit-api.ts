/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { ADMIN_DOMAIN_SUBJECT_HEADER } from '../domain-transport'
import type { UserDetailOptions, UserDetailTransport } from './user-detail-api'
import { userDetailPath } from './user-detail-domain'
import { createUserFactorReadApi } from './user-factor-preview'
import {
	WalletCreditClientError,
	walletCreditInputSchema,
	walletCreditMatches,
	walletCreditObservationSchema,
	walletCreditReceiptSchema,
	walletCreditSnapshotSchema,
	validWalletCreditReference,
	type WalletCreditInput,
} from './wallet-credit-contracts'

const observation = z.object({
	success: z.literal(true),
	data: walletCreditObservationSchema,
})
const acknowledgement = z.object({
	success: z.literal(true),
	status: z.enum(['applied', 'duplicate']),
	data: walletCreditSnapshotSchema.safeExtend({
		status: z.enum(['applied', 'duplicate']),
		receipt: walletCreditReceiptSchema,
	}),
})
export function createUserWalletCreditApi(transport: UserDetailTransport) {
	const verify = createUserFactorReadApi(transport).verifyUserFactorSubject
	function path(userId: string) {
		if (!z.string().uuid().safeParse(userId).success)
			throw new WalletCreditClientError('input')
		return userDetailPath(userId) + '/wallet/credit'
	}
	async function read(
		userId: string,
		reference: string,
		subject: string,
		options: UserDetailOptions
	) {
		if (!validWalletCreditReference(reference))
			throw new WalletCreditClientError('input')
		options.signal?.throwIfAborted()
		const result = await transport.send(
			path(userId) +
				'/receipt?' +
				new URLSearchParams({ external_ref: reference }),
			observation,
			{
				cache: 'no-store',
				headers: { [ADMIN_DOMAIN_SUBJECT_HEADER]: subject },
			},
			options
		)
		options.signal?.throwIfAborted()
		if (
			result.data.status === 'recorded' &&
			(result.data.receipt.userId !== userId ||
				result.data.receipt.externalRef !== reference)
		)
			transport.invalidResponse('Wallet receipt identity differs')
		return result.data
	}
	return {
		async userWalletCreditReceipt(
			userId: string,
			reference: string,
			options: UserDetailOptions
		) {
			return read(userId, reference, await verify(options), options)
		},
		async creditUserWallet(
			userId: string,
			raw: WalletCreditInput,
			options: UserDetailOptions
		) {
			// Freeze the reviewed payload before the first asynchronous identity check.
			const input = walletCreditInputSchema.parse(raw),
				endpoint = path(userId)
			const subject = await verify(options)
			const before = await read(userId, input.external_ref, subject, options)
			if (before.status === 'legacy_unverified')
				throw new WalletCreditClientError('legacy')
			if (before.status === 'recorded') {
				if (!walletCreditMatches(before.receipt, userId, input))
					throw new WalletCreditClientError('conflict')
				return before.receipt
			}
			if (!options.onDispatch) throw new WalletCreditClientError('storage')
			options.signal?.throwIfAborted()
			options.onDispatch('wallet-credit')
			const result = await transport.send(
				endpoint + '/verified',
				acknowledgement,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						[ADMIN_DOMAIN_SUBJECT_HEADER]: subject,
					},
					body: JSON.stringify({ ...input, require_receipt_version: 1 }),
				},
				options
			)
			options.signal?.throwIfAborted()
			const data = result.data,
				receipt = data.receipt
			if (
				result.status !== data.status ||
				!walletCreditMatches(receipt, userId, input)
			)
				transport.invalidResponse('Wallet acknowledgement differs')
			return receipt
		},
	}
}
