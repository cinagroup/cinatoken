import { z } from 'zod'
import type { CreateManagementKeyInput } from '../contracts'

export const managementKeyFormSchema = z.object({
	name: z
		.string()
		.trim()
		.min(1, 'cinatoken.account.managementKeys.nameRequired')
		.max(128, 'cinatoken.account.managementKeys.nameInvalid'),
	expiresAt: z
		.string()
		.refine(
			(value) =>
				!value ||
				(Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now()),
			'cinatoken.account.keys.expiryInvalid'
		),
})

export type ManagementKeyForm = z.infer<typeof managementKeyFormSchema>

export function managementKeyInput(
	values: ManagementKeyForm
): CreateManagementKeyInput {
	return {
		name: values.name.trim(),
		expires_at: values.expiresAt
			? new Date(values.expiresAt).toISOString()
			: null,
	}
}
