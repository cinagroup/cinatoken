import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenApi } from './api'
import {
	GUARDRAIL_BUILTINS,
	guardrailConfigSchema,
	type Guardrail,
} from './guardrail-contracts'

const scope = {
	expectedUserId: 'user-1',
	expectedWorkspaceId: 'workspace-1',
	expectedAccountScopeKey: 'organization:org-1',
}
const context = {
	workspaceId: 'workspace-1',
	userId: 'user-1',
	accountScopeKey: 'organization:org-1',
	budgetCurrency: 'CNY',
}
const row: Guardrail = {
	id: 'policy-1',
	workspaceId: 'workspace-1',
	ownerUserId: 'user-1',
	name: 'Policy',
	description: null,
	status: 'active',
	isWorkspaceDefault: false,
	isAccountDefault: false,
	accountScopeKey: null,
	designatedVersion: 1,
	latestVersion: 2,
	config: { allowed_models: [], data_collection: 'deny' },
	createdAt: '2026-09-27T00:00:00Z',
	updatedAt: '2026-09-27T00:00:00Z',
	versionCreatedAt: '2026-09-27T00:00:00Z',
	adminManaged: false,
	canEdit: true,
	canArchive: true,
	canRestore: false,
	canAssign: true,
}
const binding = {
	id: 'binding-1',
	workspaceId: 'workspace-1',
	guardrailId: 'policy-1',
	guardrailName: 'Policy',
	scopeType: 'user',
	scopeId: 'user-1',
	createdByUserId: 'user-1',
	createdAt: '2026-09-27T00:00:00Z',
	managementSource: null,
	assignedByUserId: 'user-1',
	canUnbind: true,
}
const trace = [
	{
		assignmentId: 'binding-1',
		guardrailId: 'policy-1',
		guardrailName: 'Policy',
		version: 1,
		scopeType: 'user',
		scopeId: 'user-1',
	},
]
const nullRange = { minimum: null, maximum: null }
const preview = {
	success: true,
	data: {
		...context,
		apiKeyId: null,
		pricingCurrency: 'USD',
		trace,
		effective: {
			allowedModels: [],
			ignoredModels: [],
			allowedProviders: null,
			ignoredProviders: [],
			dataCollection: 'deny',
			requireZdr: false,
			zdr: {
				anthropic: false,
				openai: true,
				google: false,
				xai: false,
				other: false,
			},
			contentFilterBuiltins: [],
			inputFilters: [],
			outputFilters: [],
			budgets: [
				{
					guardrailId: 'policy-1',
					guardrailName: 'Policy',
					version: 1,
					scopeType: 'user',
					scopeId: 'user-1',
					limit: 0.123456,
					period: 'daily',
				},
			],
		},
		routeCandidates: {
			count: 0,
			modelIds: [],
			providers: [],
			examples: [],
			truncated: false,
			requiresEndpointEvidence: true,
			routeEvidence: {
				required: true,
				checkedCount: 0,
				eligibleCount: 0,
				excludedCount: 0,
				excludedByReason: { policy_missing: 2 },
				eligibleExamples: [],
			},
			plannerEvidence: {
				checkedCount: 0,
				staticallyEligibleCount: 0,
				excludedCount: 0,
				excludedByReason: { endpoint_binding_missing: 1 },
				operationCapabilities: { verifiedCount: 0, requestDependentCount: 0 },
				outputCapacity: {
					applicableCount: 0,
					knownCount: 0,
					unknownCount: 0,
					minimumTokens: null,
					maximumTokens: null,
				},
				pricing: {
					evidenceReadyCount: 0,
					comparableCount: 0,
					requestDependentCount: 0,
					promptPerMillion: nullRange,
					completionPerMillion: nullRange,
					request: nullRange,
					image: nullRange,
					evaluatedAt: '2026-09-27T00:00:00Z',
					businessTimezone: 'Asia/Shanghai',
				},
				performance: {
					windowSeconds: 300,
					checkedRoutes: 0,
					truncated: false,
					sampledRoutes: 0,
					unsampledRoutes: 0,
					sampleCount: 0,
					p50LatencyMs: null,
					p50ThroughputTokensPerSecond: null,
				},
				requestDependent: {
					wildcardOperationCount: 0,
					explicitEndpointOptInCount: 0,
				},
				circuit: { evaluated: false, scope: 'dispatch_isolate' },
			},
		},
	},
}
const conflict = {
	success: false,
	code: 'guardrail_effective_conflict',
	message: 'Invalid stored policy',
	...context,
	apiKeyId: null,
	pricingCurrency: 'USD',
	trace,
}
function fixture(body: unknown, status = 200) {
	const calls: { path: string; init: RequestInit }[] = []
	const api = createCinaTokenApi(async (path, init = {}) => {
		calls.push({ path: String(path), init })
		return Response.json(body, { status })
	})
	return { api, calls }
}
function list(rows: Guardrail[] = []) {
	return { success: true, data: { ...context, guardrails: rows } }
}
test('empty Guardrail list verifies account context and uses same-origin Cookie transport', async () => {
	const f = fixture(list())
	assert.deepEqual((await f.api.guardrails(scope)).guardrails, [])
	assert.equal(f.calls[0].path, '/api/user/guardrails')
	assert.equal(f.calls[0].init.credentials, 'same-origin')
	assert.equal(f.calls[0].init.cache, 'no-store')
	const headers = new Headers(f.calls[0].init.headers)
	assert.equal(
		headers.get('X-CinaToken-Workspace'),
		encodeURIComponent(scope.expectedWorkspaceId)
	)
	for (const name of [
		'Authorization',
		'New-Api-User',
		'X-User-Id',
		'X-API-Key',
	])
		assert.equal(headers.has(name), false)
	await assert.rejects(
		fixture({
			success: true,
			data: { ...context, userId: 'other', guardrails: [] },
		}).api.guardrails(scope),
		/another Guardrail account/
	)
	await assert.rejects(
		fixture({
			success: true,
			data: { ...context, workspaceId: 'other', guardrails: [] },
		}).api.guardrails(scope),
		(error) =>
			error instanceof CinaTokenApiError && error.code === 'workspace-mismatch'
	)
})
test('account default may originate in another workspace and owner but cannot grant write authority', async () => {
	const accountDefault = {
		...row,
		workspaceId: 'other-workspace',
		ownerUserId: 'other-member',
		isAccountDefault: true,
		accountScopeKey: 'organization:org-1',
		canEdit: false,
		canArchive: false,
		canAssign: false,
	}
	assert.equal(
		(await fixture(list([accountDefault])).api.guardrails(scope)).guardrails[0]
			.ownerUserId,
		'other-member'
	)
	for (const wrong of [
		{ ...accountDefault, accountScopeKey: 'organization:other' },
		{ ...accountDefault, canEdit: true },
		{ ...accountDefault, ownerUserId: 'user-1', canEdit: true },
	])
		await assert.rejects(fixture(list([wrong])).api.guardrails(scope))
})
test('foreign regular rows, duplicated identities and invalid lifecycle permissions fail closed', async () => {
	for (const rows of [
		[{ ...row, ownerUserId: 'other' }],
		[{ ...row, workspaceId: 'other' }],
		[row, row],
		[{ ...row, adminManaged: true }],
		[{ ...row, status: 'archived' as const }],
		[{ ...row, isWorkspaceDefault: true }],
	])
		await assert.rejects(fixture(list(rows)).api.guardrails(scope))
})
test('empty versions and bindings require the requested identity and top context', async () => {
	assert.deepEqual(
		(
			await fixture({
				success: true,
				...context,
				guardrailId: 'policy-1',
				data: [],
			}).api.guardrailVersions('policy-1', scope)
		).data,
		[]
	)
	assert.deepEqual(
		(
			await fixture({
				success: true,
				...context,
				guardrailId: 'policy-1',
				data: [],
			}).api.guardrailAssignments('policy-1', scope)
		).data,
		[]
	)
	for (const method of ['guardrailVersions', 'guardrailAssignments'] as const) {
		await assert.rejects(
			fixture({
				success: true,
				...context,
				guardrailId: 'wrong',
				data: [],
			}).api[method]('policy-1', scope)
		)
		await assert.rejects(
			fixture({
				success: true,
				...context,
				accountScopeKey: 'organization:other',
				guardrailId: 'policy-1',
				data: [],
			}).api[method]('policy-1', scope)
		)
	}
})
test('managed bindings retain provenance and reject unauthorized unbinding permissions', async () => {
	const managed = {
		...binding,
		createdByUserId: null,
		managementSource: 'management_api',
		canUnbind: false,
	}
	assert.equal(
		(
			await fixture({
				success: true,
				...context,
				guardrailId: 'policy-1',
				data: [managed],
			}).api.guardrailAssignments('policy-1', scope)
		).data[0].managementSource,
		'management_api'
	)
	for (const wrong of [
		{ ...managed, canUnbind: true },
		{ ...binding, scopeId: 'other-user' },
		{ ...binding, guardrailId: 'other' },
		{ ...binding, workspaceId: 'other' },
	])
		await assert.rejects(
			fixture({
				success: true,
				...context,
				guardrailId: 'policy-1',
				data: [wrong],
			}).api.guardrailAssignments('policy-1', scope)
		)
})
test('create and version writes carry only policy fields and preserve explicit empty allowlists', async () => {
	for (const create of [true, false]) {
		const f = fixture({ success: true, ...context, data: row }, 201)
		const input = {
			name: ' Policy ',
			description: null,
			config: {
				allowed_models: [],
				budget: { limit: 0.123456, period: 'daily' as const },
			},
		}
		if (create) await f.api.createGuardrail(input, scope)
		else await f.api.addGuardrailVersion('policy-1', input, scope)
		assert.equal(f.calls[0].init.method, 'POST')
		assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), {
			...input,
			name: 'Policy',
		})
	}
	await assert.rejects(
		fixture({
			success: true,
			...context,
			data: { ...row, id: 'wrong' },
		}).api.patchGuardrail('policy-1', { description: null }, scope)
	)
})
test('bindings replace only the current user or explicit owned key scope and preserve target identity', async () => {
	const f = fixture({ success: true, ...context, data: binding })
	await f.api.bindGuardrail(
		'policy-1',
		{ scopeType: 'user', scopeId: 'user-1' },
		scope
	)
	assert.equal(f.calls[0].init.method, 'PUT')
	assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), {
		scope_type: 'user',
		scope_id: 'user-1',
	})
	await assert.rejects(
		f.api.bindGuardrail(
			'policy-1',
			{ scopeType: 'user', scopeId: 'other' },
			scope
		),
		/another user/
	)
	await assert.rejects(
		fixture({
			success: true,
			...context,
			data: { ...binding, guardrailId: 'old-policy' },
		}).api.bindGuardrail(
			'policy-1',
			{ scopeType: 'user', scopeId: 'user-1' },
			scope
		),
		/binding/
	)
	const unbind = fixture({ success: true, ...context })
	await unbind.api.unbindGuardrail(
		{ scopeType: 'api_key', scopeId: 'key/with space' },
		scope
	)
	assert.equal(
		unbind.calls[0].path,
		'/api/user/guardrails/assignments/api_key/key%2Fwith%20space'
	)
	assert.equal(unbind.calls[0].init.method, 'DELETE')
})
test('lifecycle and designation reject invalid versions and validate response context', async () => {
	const f = fixture({ success: true, ...context, data: row })
	await f.api.designateGuardrailVersion('policy-1', 1, scope)
	assert.equal(f.calls[0].path, '/api/user/guardrails/policy-1/designate')
	assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { version: 1 })
	assert.throws(
		() => f.api.designateGuardrailVersion('policy-1', 0, scope),
		TypeError
	)
	const archive = fixture({ success: true, ...context })
	await archive.api.archiveGuardrail('policy-1', scope)
	assert.equal(archive.calls[0].init.method, 'DELETE')
	await assert.rejects(
		fixture({
			success: true,
			...context,
			userId: 'other',
		}).api.archiveGuardrail('policy-1', scope)
	)
})
test('typed effective preview separates USD pricing from configured budget currency and preserves unknown evidence', async () => {
	const f = fixture(preview)
	const value = await f.api.effectiveGuardrails(null, scope)
	assert.equal(value.success, true)
	if (!value.success) return
	assert.equal(value.data.pricingCurrency, 'USD')
	assert.equal(value.data.budgetCurrency, 'CNY')
	assert.equal(value.data.effective.budgets[0].limit, 0.123456)
	assert.equal(
		value.data.routeCandidates.plannerEvidence.pricing.promptPerMillion.minimum,
		null
	)
	assert.deepEqual(
		value.data.routeCandidates.plannerEvidence.excludedByReason,
		{ endpoint_binding_missing: 1 }
	)
	const key = fixture({
		...preview,
		data: { ...preview.data, apiKeyId: 'key/with space' },
	})
	await key.api.effectiveGuardrails('key/with space', scope)
	assert.equal(
		key.calls[0].path,
		'/api/user/guardrails/effective?api_key_id=key%2Fwith+space'
	)
})
test('only exact effective conflict is parsed as diagnostic, with validated trace and account scope', async () => {
	assert.equal(
		(await fixture(conflict, 409).api.effectiveGuardrails(null, scope)).success,
		false
	)
	for (const wrong of [
		{ ...conflict, code: 'other' },
		{ ...conflict, trace: [{ ...trace[0], version: 0 }] },
		{ ...conflict, userId: 'other' },
		{ ...conflict, accountScopeKey: 'organization:other' },
		{ ...conflict, apiKeyId: 'other-key' },
	])
		await assert.rejects(
			fixture(wrong, 409).api.effectiveGuardrails(null, scope)
		)
	await assert.rejects(
		fixture(conflict, 409).api.patchGuardrail(
			'policy-1',
			{ description: null },
			scope
		),
		(error) => error instanceof CinaTokenApiError && error.status === 409
	)
})
test('workspace conflict, 401/403 and ordinary preview errors never become empty success', async () => {
	await assert.rejects(
		fixture(
			{ success: false, code: 'workspace_mismatch' },
			409
		).api.effectiveGuardrails(null, scope),
		(error) =>
			error instanceof CinaTokenApiError && error.code === 'workspace-mismatch'
	)
	for (const status of [401, 403, 429, 500, 503])
		await assert.rejects(
			fixture(
				{ success: false, message: 'failed' },
				status
			).api.effectiveGuardrails(null, scope),
			(error) => error instanceof CinaTokenApiError && error.status === status
		)
	await assert.rejects(
		fixture({
			success: true,
			data: { ...preview.data, trace: [{ ...trace[0], scopeType: 'invalid' }] },
		}).api.effectiveGuardrails(null, scope)
	)
})

test('verified effective conflict leaves authorized repair requests available with the same Cookie context', async () => {
	const calls: string[] = []
	let repaired = false
	const api = createCinaTokenApi(async (path, init = {}) => {
		calls.push(`${init.method ?? 'GET'} ${String(path)}`)
		if (String(path) === '/api/user/guardrails/effective')
			return Response.json(repaired ? preview : conflict, {
				status: repaired ? 200 : 409,
			})
		if (init.method === 'PATCH') {
			repaired = true
			return Response.json({ success: true, ...context, data: row })
		}
		if (init.method === 'DELETE')
			return Response.json({ success: true, ...context })
		throw new Error('Unexpected request')
	})
	assert.equal((await api.effectiveGuardrails(null, scope)).success, false)
	await api.patchGuardrail(
		'policy-1',
		{ description: 'Repair description' },
		scope
	)
	await api.unbindGuardrail({ scopeType: 'user', scopeId: 'user-1' }, scope)
	assert.equal((await api.effectiveGuardrails(null, scope)).success, true)
	assert.equal(calls.filter((path) => path.includes('gateway-keys')).length, 0)
	assert.deepEqual(calls.slice(1, 3), [
		'PATCH /api/user/guardrails/policy-1',
		'DELETE /api/user/guardrails/assignments/user/user-1',
	])
})
test('failed mutation is sent once and cancellation rejects a late successful response', async () => {
	const f = fixture({ success: false, message: 'blocked' }, 403)
	await assert.rejects(
		f.api.createGuardrail(
			{ name: 'Test', description: null, config: {} },
			scope
		)
	)
	assert.equal(f.calls.length, 1)
	const controller = new AbortController()
	const api = createCinaTokenApi(async () => {
		controller.abort()
		return Response.json(list([row]))
	})
	await assert.rejects(
		api.guardrails({ ...scope, signal: controller.signal }),
		(error) => error instanceof CinaTokenApiError && error.code === 'cancelled'
	)
})
test('policy schema covers seven deterministic filters and rejects unsupported, duplicate and unsafe financial shapes', () => {
	assert.deepEqual(guardrailConfigSchema.parse({}), {})
	assert.deepEqual(
		guardrailConfigSchema.parse({ allowed_models: [] }).allowed_models,
		[]
	)
	assert.equal(
		guardrailConfigSchema.parse({
			content_filter_builtins: GUARDRAIL_BUILTINS.map((slug) => ({
				slug,
				action: slug === 'regex-prompt-injection' ? 'flag' : 'redact',
			})),
		}).content_filter_builtins?.length,
		7
	)
	const invalid = [
		{ content_filter_builtins: [{ slug: 'person-name', action: 'block' }] },
		{ content_filter_builtins: [{ slug: 'email', action: 'flag' }] },
		{ openrouter: { enable_free_model_training: false } },
		{ budget: { limit: 0.0000001, period: 'daily' } },
		{ budget: { limit: 1_000_000_001, period: 'daily' } },
		{ data_collection: 'allow' },
		{
			input_filters: [
				{ id: 'a', pattern: 'test', action: 'block' },
				{ id: 'a', pattern: 'test2', action: 'block' },
			],
		},
	]
	for (const config of invalid)
		assert.equal(guardrailConfigSchema.safeParse(config).success, false)
})
