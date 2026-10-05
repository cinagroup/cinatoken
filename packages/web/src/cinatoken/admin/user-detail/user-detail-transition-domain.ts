/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { UserBudgetTransitionInput } from './user-detail-contracts'
import { UserDetailInputError } from './user-detail-domain'

export type BudgetTransitionDraft = {
	targetBase: string
	period: UserBudgetTransitionInput['budget_period']
	resetAt: string
	carryover: UserBudgetTransitionInput['carryover_strategy']
	resetSpent: boolean
	reason: string
}

export function buildBudgetTransitionInput(
	draft: BudgetTransitionDraft
): UserBudgetTransitionInput {
	const raw = draft.targetBase.trim()
	if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(raw))
		throw new UserDetailInputError()
	const base = Number(raw)
	if (!Number.isFinite(base) || base > 1_000_000_000_000)
		throw new UserDetailInputError()
	if (!['none', 'daily', 'weekly', 'monthly'].includes(draft.period))
		throw new UserDetailInputError()
	if (draft.carryover !== 'remaining_or_overage' && draft.carryover !== 'none')
		throw new UserDetailInputError()
	const reason = draft.reason.trim()
	if (reason.length > 256) throw new UserDetailInputError()
	const input: UserBudgetTransitionInput = {
		target_budget_base: base,
		budget_period: draft.period,
		carryover_strategy: draft.carryover,
		reset_spent: draft.resetSpent,
		reason: reason || 'gwui:budget-transition',
	}
	const resetAt = draft.resetAt.trim()
	if (resetAt) {
		if (draft.period === 'none') throw new UserDetailInputError()
		const seconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(resetAt)
			? `${resetAt}:00`
			: resetAt
		if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(seconds))
			throw new UserDetailInputError()
		const iso = `${seconds}Z`
		if (
			!Number.isFinite(Date.parse(iso)) ||
			new Date(iso).toISOString().slice(0, 19) !== seconds ||
			Date.parse(iso) < Date.now() + 5 * 60_000
		)
			throw new UserDetailInputError()
		input.budget_reset_at = iso
	}
	return input
}
