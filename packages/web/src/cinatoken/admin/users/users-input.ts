/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

export class UserInputError extends Error {
	constructor() {
		super('User input is invalid')
		this.name = 'UserInputError'
	}
}

export type UserCreateDraft = {
	email: string
	externalSystem: string
	externalUserId: string
	budgetMax: string
	budgetBase: string
	budgetPeriod: 'none' | 'daily' | 'weekly' | 'monthly'
	metadata: string
}

export const emptyUserCreateDraft: UserCreateDraft = {
	email: '',
	externalSystem: '',
	externalUserId: '',
	budgetMax: '',
	budgetBase: '',
	budgetPeriod: 'none',
	metadata: '',
}

export const userCreateDraftSchema = z.strictObject({
	email: z.string().min(1).max(320),
	externalSystem: z.string().max(600),
	externalUserId: z.string().max(600),
	budgetMax: z.string().max(80),
	budgetBase: z.string().max(80),
	budgetPeriod: z.enum(['none', 'daily', 'weekly', 'monthly']),
	metadata: z.string().max(16_384),
})

const amount = z.number().finite().nonnegative().max(1_000_000_000_000)
const createBodySchema = z
	.strictObject({
		email: z.email().max(320),
		external_system: z.string().min(1).max(600).nullable(),
		external_user_id: z.string().min(1).max(600).nullable(),
		budget_max: amount.nullable(),
		budget_base: amount.optional(),
		budget_period: z.enum(['none', 'daily', 'weekly', 'monthly']),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.refine(
		(value) =>
			(value.external_system === null) === (value.external_user_id === null)
	)
export type UserCreateInput = z.infer<typeof createBodySchema>

function parseAmount(raw: string): number | undefined {
	const value = raw.trim()
	if (!value) return undefined
	if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) throw new UserInputError()
	const number = Number(value)
	if (!amount.safeParse(number).success) throw new UserInputError()
	return number
}

export function normalizeUserCreate(draft: UserCreateDraft): UserCreateInput {
	let metadata: Record<string, unknown> | undefined
	if (draft.metadata.trim()) {
		if (draft.metadata.length > 16_384) throw new UserInputError()
		try {
			const parsed: unknown = JSON.parse(draft.metadata)
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
				throw new UserInputError()
			metadata = parsed as Record<string, unknown>
		} catch {
			throw new UserInputError()
		}
	}
	const budgetMax = parseAmount(draft.budgetMax)
	const budgetBase = parseAmount(draft.budgetBase)
	const candidate = {
		email: draft.email.trim(),
		external_system: draft.externalSystem.trim() || null,
		external_user_id: draft.externalUserId.trim() || null,
		budget_max: budgetMax ?? null,
		budget_period: draft.budgetPeriod,
		...(budgetBase === undefined ? {} : { budget_base: budgetBase }),
		...(metadata === undefined ? {} : { metadata }),
	}
	const checked = createBodySchema.safeParse(candidate)
	if (!checked.success) throw new UserInputError()
	return checked.data
}
