import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	buildWorkspaceBudgetIntent,
	normalizeWorkspaceBudgetLimitMicros,
	workspaceBudgetAmount,
} from '../../../core/src/workspace-budgets'
import { CinaTokenApiError, createCinaTokenApi } from './api'
import {
	WORKSPACE_BUDGET_INTERVALS,
	setWorkspaceBudgetInputSchema,
	workspaceBudgetSchema,
	type WorkspaceBudget,
} from './workspace-budget-contracts'

const options = { expectedWorkspaceId: 'workspace:production' }
const budget: WorkspaceBudget = {
	id: 'budget:daily',
	workspaceId: options.expectedWorkspaceId,
	limitUsd: 10,
	resetInterval: 'daily',
	periodStart: '2026-09-27T00:00:00.000Z',
	periodEnd: '2026-09-28T00:00:00.000Z',
	spentUsd: 2.25,
	reservedUsd: 0.25,
	remainingUsd: 7.5,
	createdAt: '2026-08-31T00:00:00.000Z',
	updatedAt: '2026-09-27T00:00:00.000Z',
}

function transport(
	handler: (path: string, init: RequestInit) => Response | Promise<Response>
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) =>
		handler(String(input), init ?? {})) as typeof fetch
}
function code(expected: CinaTokenApiError['code'], status?: number) {
	return (error: unknown) =>
		error instanceof CinaTokenApiError &&
		error.code === expected &&
		(status === undefined || error.status === status)
}
function list(
	data: WorkspaceBudget[] = [],
	metadata: Record<string, unknown> = {}
): Response {
	return Response.json({
		success: true,
		data,
		workspaceId: options.expectedWorkspaceId,
		billingCurrency: 'CNY',
		canManage: false,
		...metadata,
	})
}

test('budget requests use same-origin Cookie transport and workspace preconditions for every verb', async () => {
	const calls: string[] = []
	const api = createCinaTokenApi(
		transport((path, init) => {
			const method = init.method ?? 'GET'
			calls.push(`${method} ${path}`)
			assert.equal(init.credentials, 'same-origin')
			assert.equal(init.cache, 'no-store')
			assert.equal(
				new Headers(init.headers).get('X-CinaToken-Workspace'),
				'workspace%3Aproduction'
			)
			assert.equal(new Headers(init.headers).has('New-Api-User'), false)
			if (method === 'GET') return list([budget], { canManage: true })
			if (method === 'DELETE')
				return Response.json({ success: true, deleted: true })
			assert.equal(
				new Headers(init.headers).get('Content-Type'),
				'application/json'
			)
			assert.deepEqual(JSON.parse(String(init.body)), { limit_usd: 10 })
			return Response.json({
				success: true,
				data: budget,
				workspaceId: options.expectedWorkspaceId,
				billingCurrency: 'CNY',
			})
		})
	)
	assert.deepEqual(await api.workspaceBudgets(options), {
		budgets: [budget],
		workspaceId: options.expectedWorkspaceId,
		billingCurrency: 'CNY',
		canManage: true,
	})
	assert.deepEqual(
		await api.setWorkspaceBudget('daily', { limit_usd: 10 }, options),
		{ budget, workspaceId: options.expectedWorkspaceId, billingCurrency: 'CNY' }
	)
	assert.equal(await api.deleteWorkspaceBudget('daily', options), undefined)
	assert.deepEqual(calls, [
		'GET /api/user/workspace-budgets',
		'PUT /api/user/workspace-budgets/daily',
		'DELETE /api/user/workspace-budgets/daily',
	])
})

test('member read access never implies budget management permission', async () => {
	let writes = 0
	const api = createCinaTokenApi(
		transport((_path, init) => {
			if (!init.method) return list([budget])
			writes++
			return Response.json(
				{
					success: false,
					message: 'Workspace administrator access is required',
				},
				{ status: 403 }
			)
		})
	)
	assert.equal((await api.workspaceBudgets(options)).canManage, false)
	await assert.rejects(
		api.setWorkspaceBudget('daily', { limit_usd: 20 }, options),
		code('http', 403)
	)
	await assert.rejects(
		api.deleteWorkspaceBudget('daily', options),
		code('http', 403)
	)
	assert.equal(writes, 2)
})

test('configured daily weekly monthly and lifetime periods all use the backend UTC boundaries', async () => {
	for (const resetInterval of WORKSPACE_BUDGET_INTERVALS) {
		const intent = buildWorkspaceBudgetIntent(
			{
				id: `budget:${resetInterval}`,
				workspace_id: budget.workspaceId,
				reset_interval: resetInterval,
				limit_micros: 10_000_000,
				config_epoch: 0,
				workspace_created_at: budget.createdAt,
				created_at: budget.createdAt,
				updated_at: budget.updatedAt,
			},
			new Date('2026-09-27T16:00:00.000Z')
		)
		const row = {
			...budget,
			id: intent.assignmentId,
			resetInterval,
			periodStart: intent.periodStart,
			periodEnd: intent.periodEnd,
		}
		const api = createCinaTokenApi(
			transport((path) => {
				assert.equal(path, `/api/user/workspace-budgets/${resetInterval}`)
				return Response.json({
					success: true,
					data: row,
					workspaceId: row.workspaceId,
					billingCurrency: 'USD',
				})
			})
		)
		const received = await api.setWorkspaceBudget(
			resetInterval,
			{ limit_usd: 10 },
			options
		)
		assert.equal(received.budget.periodStart, intent.periodStart)
		assert.equal(received.budget.periodEnd, intent.periodEnd)
		if (resetInterval === 'weekly')
			assert.equal(new Date(intent.periodStart).getUTCDay(), 1)
		if (resetInterval === 'monthly')
			assert.equal(new Date(intent.periodStart).getUTCDate(), 1)
		if (resetInterval === 'lifetime')
			assert.equal(intent.periodEnd, '9999-12-31T23:59:59.999Z')
	}
})

test('input precision matches backend rounding without inventing an extra decimal-place restriction', async () => {
	for (const limit_usd of [0.0000005, 0.000001, 0.123456789, 10.25]) {
		const micros = normalizeWorkspaceBudgetLimitMicros(limit_usd)
		assert.equal(
			setWorkspaceBudgetInputSchema.parse({ limit_usd }).limit_usd,
			limit_usd
		)
		const row = { ...budget, limitUsd: workspaceBudgetAmount(micros) }
		const api = createCinaTokenApi(
			transport((_path, init) => {
				assert.deepEqual(JSON.parse(String(init.body)), { limit_usd })
				return Response.json({
					success: true,
					data: row,
					workspaceId: row.workspaceId,
					billingCurrency: 'CNY',
				})
			})
		)
		assert.equal(
			(await api.setWorkspaceBudget('daily', { limit_usd }, options)).budget
				.limitUsd,
			micros / 1_000_000
		)
	}
})

test('zero, sub-micro rounding to zero and unsafe budgets fail before issuing writes', async () => {
	let writes = 0
	const api = createCinaTokenApi(
		transport(() => {
			writes++
			return Response.json({})
		})
	)
	for (const limit_usd of [
		0,
		-1,
		0.00000049,
		Number.POSITIVE_INFINITY,
		Number.NaN,
		Number.MAX_SAFE_INTEGER,
	]) {
		assert.throws(
			() => normalizeWorkspaceBudgetLimitMicros(limit_usd),
			TypeError
		)
		await assert.rejects(
			api.setWorkspaceBudget('daily', { limit_usd }, options)
		)
	}
	await assert.rejects(
		api.setWorkspaceBudget(
			'daily',
			{ limit_usd: 10, workspace_id: 'other' } as { limit_usd: number },
			options
		)
	)
	await assert.rejects(api.workspaceBudgets({ expectedWorkspaceId: '' }))
	assert.equal(writes, 0)
})

test('stored maximum safe micro-unit values remain readable after main-unit conversion', () => {
	const amount = workspaceBudgetAmount(Number.MAX_SAFE_INTEGER)
	assert.equal(
		workspaceBudgetSchema.safeParse({ ...budget, limitUsd: amount }).success,
		true
	)
	assert.equal(
		workspaceBudgetSchema.safeParse({ ...budget, spentUsd: -1 }).success,
		false
	)
})

test('empty budget contexts require server scope, currency and authority metadata', async () => {
	for (const metadata of [
		{ workspaceId: undefined },
		{ billingCurrency: undefined },
		{ billingCurrency: 'usd' },
		{ canManage: undefined },
		{ canManage: 'true' },
	]) {
		const api = createCinaTokenApi(transport(() => list([], metadata)))
		await assert.rejects(
			api.workspaceBudgets(options),
			code('invalid-response')
		)
	}
	const api = createCinaTokenApi(
		transport(() => list([], { workspaceId: 'workspace:other' }))
	)
	await assert.rejects(
		api.workspaceBudgets(options),
		code('workspace-mismatch')
	)
})

test('every row must belong to the returned workspace, with at most one budget per period', async () => {
	const foreign = createCinaTokenApi(
		transport(() => list([{ ...budget, workspaceId: 'workspace:other' }]))
	)
	await assert.rejects(
		foreign.workspaceBudgets(options),
		code('workspace-mismatch')
	)
	for (const rows of [
		[budget, { ...budget, id: 'budget:duplicate' }],
		[budget, { ...budget, resetInterval: 'weekly' as const }],
	]) {
		const api = createCinaTokenApi(transport(() => list(rows)))
		await assert.rejects(
			api.workspaceBudgets(options),
			code('invalid-response')
		)
	}
})

test('budget periods reject malformed dates but preserve legitimate exhausted limits', async () => {
	const exhausted = { ...budget, spentUsd: 20, reservedUsd: 5, remainingUsd: 0 }
	const api = createCinaTokenApi(transport(() => list([exhausted])))
	assert.equal((await api.workspaceBudgets(options)).budgets[0].remainingUsd, 0)
	for (const row of [
		{ ...budget, periodStart: '' },
		{ ...budget, periodEnd: budget.periodStart },
		{ ...budget, createdAt: 'invalid-date' },
		{ ...budget, reservedUsd: null },
	]) {
		const invalid = createCinaTokenApi(
			transport(() =>
				Response.json({
					success: true,
					data: [row],
					workspaceId: budget.workspaceId,
					billingCurrency: 'USD',
					canManage: false,
				})
			)
		)
		await assert.rejects(
			invalid.workspaceBudgets(options),
			code('invalid-response')
		)
	}
})

test('a PUT acknowledgment must match interval, normalized amount and both scope identities', async () => {
	const base = {
		success: true,
		data: budget,
		workspaceId: budget.workspaceId,
		billingCurrency: 'CNY',
	}
	for (const payload of [
		{ ...base, data: { ...budget, resetInterval: 'weekly' } },
		{ ...base, data: { ...budget, limitUsd: 11 } },
		{ ...base, billingCurrency: undefined },
	]) {
		const api = createCinaTokenApi(transport(() => Response.json(payload)))
		await assert.rejects(
			api.setWorkspaceBudget('daily', { limit_usd: 10 }, options),
			code('invalid-response')
		)
	}
	for (const payload of [
		{ ...base, workspaceId: 'workspace:other' },
		{ ...base, data: { ...budget, workspaceId: 'workspace:other' } },
	]) {
		const api = createCinaTokenApi(transport(() => Response.json(payload)))
		await assert.rejects(
			api.setWorkspaceBudget('daily', { limit_usd: 10 }, options),
			code('workspace-mismatch')
		)
	}
})

test('ordering violations remain authoritative server failures and are never retried', async () => {
	let writes = 0
	const api = createCinaTokenApi(
		transport(() => {
			writes++
			return Response.json(
				{
					success: false,
					message:
						'Workspace budget limits must satisfy lifetime > monthly > weekly > daily',
				},
				{ status: 400 }
			)
		})
	)
	await assert.rejects(
		api.setWorkspaceBudget('weekly', { limit_usd: 5 }, options),
		code('http', 400)
	)
	assert.equal(writes, 1)
})

test('budget status errors remain distinct from a workspace conflict across all operations', async () => {
	for (const status of [401, 403, 404, 409, 503]) {
		let calls = 0
		const api = createCinaTokenApi(
			transport(() => {
				calls++
				return Response.json(
					{
						success: false,
						code: status === 409 ? 'workspace_mismatch' : undefined,
					},
					{ status }
				)
			})
		)
		const expected = status === 409 ? 'workspace-mismatch' : 'http'
		await assert.rejects(api.workspaceBudgets(options), code(expected, status))
		await assert.rejects(
			api.setWorkspaceBudget('daily', { limit_usd: 10 }, options),
			code(expected, status)
		)
		await assert.rejects(
			api.deleteWorkspaceBudget('daily', options),
			code(expected, status)
		)
		assert.equal(calls, 3)
	}
})

test('HTTP 200 business failures and missing delete confirmation never imply a saved configuration', async () => {
	const rejected = createCinaTokenApi(
		transport(() => Response.json({ success: false, message: 'Rejected' }))
	)
	await assert.rejects(
		rejected.setWorkspaceBudget('daily', { limit_usd: 10 }, options),
		code('business', 200)
	)
	const unconfirmed = createCinaTokenApi(
		transport(() => Response.json({ success: true }))
	)
	await assert.rejects(
		unconfirmed.deleteWorkspaceBudget('daily', options),
		code('invalid-response')
	)
})

test('a cancelled budget write cannot report success after a late server response', async () => {
	const controller = new AbortController()
	const api = createCinaTokenApi(
		transport(() => {
			controller.abort()
			return Response.json({
				success: true,
				data: budget,
				workspaceId: budget.workspaceId,
				billingCurrency: 'CNY',
			})
		})
	)
	await assert.rejects(
		api.setWorkspaceBudget(
			'daily',
			{ limit_usd: 10 },
			{ ...options, signal: controller.signal }
		),
		code('cancelled')
	)
})
