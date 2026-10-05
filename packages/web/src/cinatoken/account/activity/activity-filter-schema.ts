import { z } from 'zod'

function text(maximum: number) {
	return z
		.string()
		.trim()
		.max(maximum, 'cinatoken.account.activity.filterInvalid')
		.refine(
			(value) =>
				Array.from(value).every(
					(character) =>
						character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
				),
			'cinatoken.account.activity.filterInvalid'
		)
}

export const activityFormSchema = z
	.object({
		range: z.enum(['7d', '30d', '90d']),
		status: z.enum(['', 'success', 'error', 'incomplete', 'cancelled']),
		api_key_id: text(128),
		model_id: text(256),
		provider_name: text(200),
	})
	.strict()

export type ActivityFilterForm = z.infer<typeof activityFormSchema>
export const EMPTY_ACTIVITY_FILTERS: ActivityFilterForm = {
	range: '7d',
	status: '',
	api_key_id: '',
	model_id: '',
	provider_name: '',
}
