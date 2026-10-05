/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { ChainOperationsApi } from './chain-operations-api'
import type { ChainOperationsSearch } from './chain-operations-search'

export type ChainOperationKind = 'withdrawals' | 'nft-mints'
export type ChainOperationsSession = {
	scopeKey: string
	reconciliationKey: string
	subject: string
	enabled: boolean
	revalidate?: () => Promise<unknown>
}
export type ChainOperationsScreenProps = {
	kind: ChainOperationKind
	session: ChainOperationsSession
	search: ChainOperationsSearch
	onSearchChange?: (next: ChainOperationsSearch) => void
	api?: ChainOperationsApi
}
