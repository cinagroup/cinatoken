/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type {
	ChainOperationsApi,
	ChainWriteOptions,
} from './chain-operations-api'
import { ChainOperationError } from './chain-operations-errors'
import type { ChainOperationsSearch } from './chain-operations-search'
import type { ChainOperationKind } from './types'

/** Read-only observations and fresh identity checks never replay a queue/refund POST. */
export async function reviewUnknownChainOperation(input: {
	api: ChainOperationsApi
	kind: ChainOperationKind
	search: ChainOperationsSearch
	options: ChainWriteOptions
	reviewedExternal: boolean
	acceptsUnknown: boolean
}) {
	if (!input.reviewedExternal || !input.acceptsUnknown || input.search.invalid)
		throw new ChainOperationError('input')
	await input.api.verifyChainOperationSubject(input.options)
	input.options.signal?.throwIfAborted()
	const observation =
		input.kind === 'withdrawals'
			? await input.api.chainWithdrawalList(input.search, input.options)
			: await input.api.chainNftMintList(input.search, input.options)
	input.options.signal?.throwIfAborted()
	await input.api.verifyChainOperationSubject(input.options)
	input.options.signal?.throwIfAborted()
	return observation
}
