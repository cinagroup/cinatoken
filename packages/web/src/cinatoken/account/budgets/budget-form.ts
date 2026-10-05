import { setWorkspaceBudgetInputSchema } from '../../workspace-budget-contracts'

export function parseBudgetDraft(value: string): number | null {
	const text = value.trim()
	if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(text)) return null
	const result = setWorkspaceBudgetInputSchema.safeParse({
		limit_usd: Number(text),
	})
	return result.success ? result.data.limit_usd : null
}
