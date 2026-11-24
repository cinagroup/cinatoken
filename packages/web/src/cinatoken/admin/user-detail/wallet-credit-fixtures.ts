/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type {
	WalletCreditInput,
	WalletCreditReceipt,
} from './wallet-credit-contracts'

export const walletCreditFixtureUserId = 'f2b74bc0-32f3-4613-aea7-96f723d08e12'
export const walletCreditFixtureInput: WalletCreditInput = {
	amount: 5.000001,
	kind: 'topup',
	external_ref: 'QA-ORDER-20261018-001',
	reason: 'Synthetic order for local verification',
}
export const walletCreditFixtureReceipt: WalletCreditReceipt = {
	version: 1,
	userId: walletCreditFixtureUserId,
	externalRef: walletCreditFixtureInput.external_ref,
	amountMicros: 5000001,
	kind: 'topup',
	auditId: 'd2b74bc0-32f3-4613-aea7-96f723d08e12',
	creditedAt: '2026-10-18T00:00:00.000Z',
	before: { walletGranted: 20, walletSpent: 3, walletBalance: 17 },
	after: { walletGranted: 25.000001, walletSpent: 3, walletBalance: 22.000001 },
}
