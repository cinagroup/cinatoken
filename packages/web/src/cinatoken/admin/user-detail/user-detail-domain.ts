/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { UserDetail } from './user-detail-contracts'

export class UserDetailInputError extends Error {
	constructor() {
		super('User detail input is invalid')
		this.name = 'UserDetailInputError'
	}
}

const uuid =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
function validExternalComponent(value: string): boolean {
	if (!value || value.length > 600) return false
	try {
		const decoded = decodeURIComponent(value)
		return (
			decoded.length > 0 &&
			!Array.from(decoded).some((character) => {
				const code = character.charCodeAt(0)
				return code < 32 || code === 127
			})
		)
	} catch {
		return false
	}
}

/** Supports both documented ext: separators without decoding the whole route twice. */
export function userRouteIdentity(
	raw: string
):
	| { kind: 'uuid'; id: string }
	| { kind: 'external'; system: string; user: string }
	| null {
	if (raw.length > 1_500 || raw.trim() !== raw) return null
	if (uuid.test(raw)) return { kind: 'uuid', id: raw }
	if (!raw.startsWith('ext:')) return null
	const rest = raw.slice(4)
	const delimiter = rest.includes('\x1f') ? '\x1f' : '/'
	const index = rest.indexOf(delimiter)
	if (index < 1 || index === rest.length - 1) return null
	const system = rest.slice(0, index)
	const user = rest.slice(index + 1)
	if (!validExternalComponent(system) || !validExternalComponent(user))
		return null
	return {
		kind: 'external',
		system: decodeURIComponent(system),
		user: decodeURIComponent(user),
	}
}

export function userDetailPath(routeId: string): string {
	if (!userRouteIdentity(routeId)) throw new TypeError('Invalid user route ID')
	return `/api/admin/users/${encodeURIComponent(routeId)}`
}

/** Historical request logs are bound to immutable user ID, not the current email. */
export function userDetailRequestLogsUrl(userId: string): string {
	const identity = userRouteIdentity(userId)
	if (!identity || identity.kind !== 'uuid')
		throw new TypeError('Invalid user ID')
	return `/admin/request-logs?user_id=${encodeURIComponent(userId)}`
}

export function routeMatchesUser(routeId: string, user: UserDetail): boolean {
	const route = userRouteIdentity(routeId)
	if (!route) return false
	if (route.kind === 'uuid')
		return route.id.toLowerCase() === user.id.toLowerCase()
	return (
		route.system === user.external_system &&
		route.user === user.external_user_id
	)
}

export type UserDetailDraft = {
	email: string
	status: string
	externalSystem: string
	externalUserId: string
	metadata: string
	budgetMax: string
	budgetBase: string
	budgetSpent: string
	budgetPeriod: 'none' | 'daily' | 'weekly' | 'monthly'
	budgetResetAt: string
	resetBudget: boolean
}

function utcInput(value: string | null): string {
	return value ? value.slice(0, 19) : ''
}

export function draftFromUser(user: UserDetail): UserDetailDraft {
	return {
		email: user.email,
		status: user.status,
		externalSystem: user.external_system ?? '',
		externalUserId: user.external_user_id ?? '',
		metadata: user.metadata ? JSON.stringify(user.metadata, null, 2) : '',
		budgetMax: user.budget_max === null ? '' : String(user.budget_max),
		budgetBase: String(user.budget_base),
		budgetSpent: String(user.budget_spent),
		budgetPeriod: user.budget_period,
		budgetResetAt: utcInput(user.budget_reset_at),
		resetBudget: false,
	}
}

function money(value: string, nullable: boolean): number | null {
	const raw = value.trim()
	if (nullable && raw === '') return null
	if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(raw))
		throw new UserDetailInputError()
	const amount = Number(raw)
	if (!Number.isFinite(amount) || amount > 1_000_000_000_000)
		throw new UserDetailInputError()
	return amount
}

function metadata(value: string): Record<string, unknown> | null {
	if (!value.trim()) return null
	if (value.length > 16_384) throw new UserDetailInputError()
	try {
		const parsed: unknown = JSON.parse(value)
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
			throw new UserDetailInputError()
		return parsed as Record<string, unknown>
	} catch {
		throw new UserDetailInputError()
	}
}

/** Separate profile and budget requests so an ordinary profile edit never resets budget epoch. */
export function buildUserDetailPatches(
	before: UserDetail,
	draft: UserDetailDraft
): {
	profile: Record<string, unknown> | null
	budget: Record<string, unknown> | null
} {
	const email = draft.email.trim().toLowerCase()
	if (!email || email.length > 320 || !/^\S+@\S+\.\S+$/u.test(email))
		throw new UserDetailInputError()
	const system = draft.externalSystem.trim()
	const externalUser = draft.externalUserId.trim()
	if (
		Boolean(system) !== Boolean(externalUser) ||
		system.length > 600 ||
		externalUser.length > 600
	)
		throw new UserDetailInputError()
	const profile: Record<string, unknown> = {}
	if (email !== before.email) profile.email = email
	if (draft.status !== before.status) {
		if (
			(before.status !== 'active' && before.status !== 'disabled') ||
			(draft.status !== 'active' && draft.status !== 'disabled')
		)
			throw new UserDetailInputError()
		profile.status = draft.status
	}
	if (
		system !== (before.external_system ?? '') ||
		externalUser !== (before.external_user_id ?? '')
	) {
		profile.external_system = system || null
		profile.external_user_id = externalUser || null
	}
	const originalMetadata = before.metadata
		? JSON.stringify(before.metadata)
		: null
	const nextMetadata = metadata(draft.metadata)
	if ((nextMetadata ? JSON.stringify(nextMetadata) : null) !== originalMetadata)
		profile.metadata_replace =
			nextMetadata === null ? '' : JSON.stringify(nextMetadata)

	const budget: Record<string, unknown> = {}
	if (
		draft.budgetMax.trim() !==
		(before.budget_max === null ? '' : String(before.budget_max))
	) {
		const max = money(draft.budgetMax, true)
		if (max !== before.budget_max) budget.budget_max = max
	}
	if (draft.budgetBase.trim() !== String(before.budget_base)) {
		const base = money(draft.budgetBase, false)
		if (base !== before.budget_base) budget.budget_base = base
	}
	if (draft.budgetSpent.trim() !== String(before.budget_spent)) {
		const spent = money(draft.budgetSpent, false)
		if (spent !== before.budget_spent) budget.budget_spent = spent
	}
	if (draft.budgetPeriod !== before.budget_period)
		budget.budget_period = draft.budgetPeriod
	const resetAt = draft.budgetResetAt.trim()
	const resetSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(resetAt)
		? `${resetAt}:00`
		: resetAt
	const nextReset = resetAt ? `${resetSeconds}Z` : null
	if (
		nextReset &&
		(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(nextReset) ||
			!Number.isFinite(Date.parse(nextReset)) ||
			new Date(nextReset).toISOString().slice(0, 19) !== resetSeconds)
	)
		throw new UserDetailInputError()
	if (
		nextReset !==
		(before.budget_reset_at ? before.budget_reset_at.slice(0, 19) + 'Z' : null)
	)
		budget.budget_reset_at = nextReset
	if (Object.keys(budget).length > 0 || draft.resetBudget)
		budget.reset_budget = draft.resetBudget
	return {
		profile: Object.keys(profile).length
			? { ...profile, reason: 'gwui:user-profile' }
			: null,
		budget: Object.keys(budget).length
			? { ...budget, reason: 'gwui:user-plan' }
			: null,
	}
}

export type ChargedFactorRow = { modelId: string; factor: string }
export function buildFactorPatch(
	before: UserDetail['charged_cost_factors'],
	rows: ChargedFactorRow[]
): Record<string, unknown> | null {
	const next: Record<string, number> = {}
	for (const row of rows) {
		const id = row.modelId.trim()
		if (!id || id.length > 600 || Object.hasOwn(next, id))
			throw new UserDetailInputError()
		const rawFactor = row.factor.trim()
		if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(rawFactor))
			throw new UserDetailInputError()
		const factor = Number(rawFactor)
		if (!Number.isFinite(factor) || factor > 1_000_000_000_000)
			throw new UserDetailInputError()
		next[id] = factor
	}
	const normalized = Object.keys(next).length ? next : null
	if (JSON.stringify(normalized) === JSON.stringify(before)) return null
	return {
		charged_cost_factors: normalized,
		reason: 'gwui:charged-cost-factors',
	}
}

export function createKeyMetadata(value: string): string | null {
	const parsed = metadata(value)
	return parsed ? JSON.stringify(parsed) : null
}
