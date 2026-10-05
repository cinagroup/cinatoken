/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type {
	AdminNftMintRow,
	AdminWithdrawalRow,
} from './chain-operations-contracts'

export const chainWithdrawalFixture: AdminWithdrawalRow = {
	id: 'withdrawal-1',
	userId: 'portal-user-1',
	amount: 12.5,
	fee: 0.5,
	netAmount: 12,
	currency: 'USD',
	walletAddress: '0x' + '1'.repeat(40),
	status: 'requested',
	tokenAmount: 24,
	txHash: null,
	chainId: 84532,
	failureReason: null,
	createdAt: '2026-10-01T00:00:00.000Z',
	updatedAt: '2026-10-01T00:00:00.000Z',
	confirmedAt: null,
}
export const chainNftMintFixture: AdminNftMintRow = {
	id: 'mint-1',
	userId: 'portal-user-1',
	badgeTokenId: 200,
	tierName: 'CinaBadge',
	walletAddress: '0x' + '1'.repeat(40),
	status: 'pending',
	txHash: null,
	chainId: 84532,
	valueSnapshot: 250,
	failureReason: null,
	createdAt: '2026-10-01T00:00:00.000Z',
	confirmedAt: null,
}
export const chainListMetadataFixture = {
	scope: 'global_portal_ledger',
	withdrawalCurrencySource: 'stored_row',
	nftValueSnapshotCurrency: 'USD',
	nftValueSnapshotCurrencySource: 'seller_contribution_ledger',
	amountUnit: 'major',
	queueConfigured: true,
}
export function chainListFixture(
	kind: 'withdrawals' | 'nft-mints',
	rows: unknown[] = []
) {
	return {
		success: true,
		data: rows,
		total: rows.length,
		meta: {
			...chainListMetadataFixture,
			processEligibleStatuses:
				kind === 'withdrawals' ? ['requested', 'submitted'] : ['pending'],
			...(kind === 'withdrawals' ? { rejectEligibleStatus: 'requested' } : {}),
		},
	}
}
export const chainProcessFixture = {
	success: true,
	data: { queued: 1 },
	meta: { result: 'queued', chainConfirmation: false },
}
