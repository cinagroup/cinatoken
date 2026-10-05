import { z } from 'zod'
import type { CreateGatewayKeyInput } from '../contracts'

const optionalLimit = z
	.string()
	.trim()
	.superRefine((value, context) => {
		if (!value) return
		const number = Number(value)
		if (
			!/^(?:\d+(?:\.\d{1,6})?|\.\d{1,6})$/.test(value) ||
			!Number.isFinite(number) ||
			!Number.isSafeInteger(Math.round(number * 1_000_000))
		) {
			context.addIssue({
				code: 'custom',
				message: 'cinatoken.account.keys.limitInvalid',
			})
		}
	})

export const createKeySchema = z.object({
	name: z.string().trim().max(128, 'cinatoken.account.keys.nameInvalid'),
	limit: optionalLimit,
	reset: z.enum(['lifetime', 'daily', 'weekly', 'monthly']),
	expiresAt: z
		.string()
		.refine(
			(value) =>
				!value ||
				(Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now()),
			'cinatoken.account.keys.expiryInvalid'
		),
})

export type CreateKeyForm = z.infer<typeof createKeySchema>

export function createKeyInput(values: CreateKeyForm): CreateGatewayKeyInput {
	return {
		name: values.name.trim() || undefined,
		limit: values.limit.trim() === '' ? null : Number(values.limit),
		limit_reset: values.reset === 'lifetime' ? null : values.reset,
		expires_at: values.expiresAt
			? new Date(values.expiresAt).toISOString()
			: null,
	}
}
