import { z } from 'zod'
import type { RequestOptions } from './api'
import {
	WORKSPACE_BUDGET_MICROS_PER_UNIT,
	setWorkspaceBudgetInputSchema,
	workspaceBudgetIntervalSchema,
	workspaceBudgetScopeSchema,
	workspaceBudgetUpdateResponseSchema,
	workspaceBudgetsResponseSchema,
	type SetWorkspaceBudgetInput,
	type WorkspaceBudgetContext,
	type WorkspaceBudgetInterval,
	type WorkspaceBudgetUpdate,
} from './workspace-budget-contracts'

export type WorkspaceBudgetRequestOptions = RequestOptions & {
	expectedWorkspaceId: string
}
type BudgetTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: RequestOptions
	): Promise<T>
	checkWorkspace(actual: string, options: RequestOptions): void
	invalidResponse(message: string): never
}

/** Read access and write authority differ; only the server's canManage metadata describes current authority. */
export function createWorkspaceBudgetApi(transport: BudgetTransport) {
	return {
		workspaceBudgets: async (
			options: WorkspaceBudgetRequestOptions
		): Promise<WorkspaceBudgetContext> => {
			workspaceBudgetScopeSchema.parse(options.expectedWorkspaceId)
			const result = await transport.send(
				'/api/user/workspace-budgets',
				workspaceBudgetsResponseSchema,
				{},
				options
			)
			transport.checkWorkspace(result.workspaceId, options)
			result.data.forEach((row) =>
				transport.checkWorkspace(row.workspaceId, options)
			)
			return {
				budgets: result.data,
				workspaceId: result.workspaceId,
				billingCurrency: result.billingCurrency,
				canManage: result.canManage,
			}
		},
		setWorkspaceBudget: async (
			interval: WorkspaceBudgetInterval,
			input: SetWorkspaceBudgetInput,
			options: WorkspaceBudgetRequestOptions
		): Promise<WorkspaceBudgetUpdate> => {
			workspaceBudgetScopeSchema.parse(options.expectedWorkspaceId)
			const normalizedInterval = workspaceBudgetIntervalSchema.parse(interval)
			const body = setWorkspaceBudgetInputSchema.parse(input)
			const result = await transport.send(
				`/api/user/workspace-budgets/${normalizedInterval}`,
				workspaceBudgetUpdateResponseSchema,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				},
				options
			)
			transport.checkWorkspace(result.workspaceId, options)
			transport.checkWorkspace(result.data.workspaceId, options)
			const normalizedAmount =
				Math.round(body.limit_usd * WORKSPACE_BUDGET_MICROS_PER_UNIT) /
				WORKSPACE_BUDGET_MICROS_PER_UNIT
			if (
				result.data.resetInterval !== normalizedInterval ||
				result.data.limitUsd !== normalizedAmount
			)
				transport.invalidResponse(
					'Server returned another workspace budget configuration'
				)
			return {
				budget: result.data,
				workspaceId: result.workspaceId,
				billingCurrency: result.billingCurrency,
			}
		},
		deleteWorkspaceBudget: async (
			interval: WorkspaceBudgetInterval,
			options: WorkspaceBudgetRequestOptions
		): Promise<void> => {
			workspaceBudgetScopeSchema.parse(options.expectedWorkspaceId)
			const normalizedInterval = workspaceBudgetIntervalSchema.parse(interval)
			await transport.send(
				`/api/user/workspace-budgets/${normalizedInterval}`,
				z
					.object({ success: z.literal(true), deleted: z.literal(true) })
					.strict(),
				{ method: 'DELETE' },
				options
			)
		},
	}
}
