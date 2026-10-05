import { z } from 'zod'
import { withdrawalAmountSchema } from '../../withdrawal-contracts'

export const withdrawalFormSchema = z.object({
	amount: z
		.string()
		.trim()
		.regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u, 'invalidAmount')
		.refine(
			(value) => withdrawalAmountSchema.safeParse(Number(value)).success,
			'invalidAmount'
		),
})
export type WithdrawalForm = z.infer<typeof withdrawalFormSchema>
