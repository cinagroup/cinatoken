/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

const amount = z.number().finite().nonnegative()
export const userWalletFields = {
	wallet_granted: amount.optional(),
	wallet_spent: amount.optional(),
	// Historical overage remains signed; never clamp an administrator's ledger view.
	wallet_balance: z.number().finite().optional(),
}

/** Old servers omit the extension. Partial ledger data must not become editable. */
export function completeUserWallet(value: {
	wallet_granted?: number
	wallet_spent?: number
	wallet_balance?: number
}): boolean {
	const fields = [
		value.wallet_granted,
		value.wallet_spent,
		value.wallet_balance,
	]
	return (
		fields.every((field) => field === undefined) ||
		fields.every((field) => field !== undefined)
	)
}
