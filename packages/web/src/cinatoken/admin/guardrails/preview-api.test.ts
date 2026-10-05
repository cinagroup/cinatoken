/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import * as React from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { guardrailMessages } from '../../account/guardrails/messages'
import { CinaTokenApiError } from '../../api'
import { bindAdminDomainFixtureApi } from '../domain-api-test-fixture'
import { AdminDomainWriteError } from '../domain-write-recovery'
import {
	AdminGuardrailPreview,
	AdminGuardrailPreviewEvidence,
} from './AdminGuardrailPreview'
import { createAdminGuardrailPreviewApi } from './preview-api'
import type { AdminGuardrailPreviewResult } from './preview-contracts'

const secret = 'PRIVATE-GUARDRAIL-CONFIG'
const target = {
	workspaceId: 'workspace/one',
	userId: 'user/one',
	apiKeyId: null,
}
const scope = {
	...target,
	accountScopeKey: 'account/one',
	budgetCurrency: 'EUR',
	pricingCurrency: 'USD',
}
const trace = [
	{
		assignmentId: 'assignment/one',
		guardrailId: 'guardrail/one',
		guardrailName: 'Policy',
		version: 2,
		scopeType: 'user',
		scopeId: target.userId,
	},
]
const range = { minimum: 0.0001, maximum: 0.0002 }
const success = {
	success: true,
	data: {
		...scope,
		trace,
		effective: {
			allowedModels: ['model/one'],
			ignoredModels: [],
			allowedProviders: null,
			ignoredProviders: [],
			dataCollection: 'deny',
			requireZdr: true,
			zdr: {
				anthropic: true,
				openai: false,
				google: false,
				xai: false,
				other: false,
			},
			contentFilterBuiltins: [{ slug: 'email', action: 'redact' }],
			inputFilters: [{ id: 'input-one', action: 'block', label: 'Input' }],
			outputFilters: [],
			budgets: [
				{
					guardrailId: 'guardrail/one',
					guardrailName: 'Policy',
					version: 2,
					scopeType: 'user',
					scopeId: target.userId,
					limit: 12.25,
					period: 'daily',
				},
			],
		},
		routeCandidates: {
			count: 1,
			modelIds: ['model/one'],
			providers: ['Provider One'],
			examples: [
				{
					modelId: 'model/one',
					provider: 'Provider One',
					protocol: 'openai',
					operation: 'chat',
					routeGroup: 'default',
				},
			],
			truncated: false,
			requiresEndpointEvidence: true,
			routeEvidence: {
				required: true,
				checkedCount: 1,
				eligibleCount: 0,
				excludedCount: 1,
				excludedByReason: { policy_missing: 1 },
				eligibleExamples: [],
			},
			plannerEvidence: {
				checkedCount: 0,
				staticallyEligibleCount: 0,
				excludedCount: 0,
				excludedByReason: {},
				operationCapabilities: {
					verifiedCount: 0,
					requestDependentCount: 0,
				},
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
					promptPerMillion: range,
					completionPerMillion: range,
					request: { minimum: null, maximum: null },
					image: { minimum: null, maximum: null },
					evaluatedAt: '2026-09-28T00:00:00Z',
					businessTimezone: 'Asia/Singapore',
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

function fixture(
	reply: (path: string, init: RequestInit) => Response | Promise<Response>
) {
	const calls: Array<{ path: string; init: RequestInit }> = []
	const rawApi = createAdminGuardrailPreviewApi(async (path, init = {}) => {
		calls.push({ path: String(path), init })
		return reply(String(path), init)
	})
	const api = bindAdminDomainFixtureApi(rawApi, { previewGuardrail: 1 })
	return { api, rawApi, calls }
}

const invalid = (error: unknown): boolean =>
	error instanceof CinaTokenApiError && error.code === 'invalid-response'

test('preview refuses an unbound Console read before request dispatch', async () => {
	const f = fixture(() => Response.json(success))
	await assert.rejects(
		f.rawApi.previewGuardrail(target),
		(error: unknown) =>
			error instanceof AdminDomainWriteError && error.code === 'subject'
	)
	assert.equal(f.calls.length, 0)
})

test('Admin preview sends exact same-origin Cookie query and strips unknown config from every layer', async () => {
	const raw = {
		...success,
		data: {
			...success.data,
			config: { secret },
			trace: [{ ...trace[0], config: { secret } }],
			effective: {
				...success.data.effective,
				inputFilters: success.data.effective.inputFilters,
				budgets: [{ ...success.data.effective.budgets[0], secret }],
			},
			routeCandidates: {
				...success.data.routeCandidates,
				plannerEvidence: {
					...success.data.routeCandidates.plannerEvidence,
					credential: secret,
				},
			},
		},
	}
	const { api, calls } = fixture(() => Response.json(raw))
	const result = await api.previewGuardrail(target, {
		expectedWorkspaceId: secret,
	} as never)
	assert.equal(result.kind, 'ready')
	assert.equal(JSON.stringify(result).includes(secret), false)
	if (result.kind !== 'ready') return
	assert.equal(result.preview.budgetCurrency, 'EUR')
	assert.equal(result.preview.pricingCurrency, 'USD')
	assert.deepEqual(result.preview.trace, trace)
	assert.equal(
		result.preview.routeCandidates.routeEvidence.excludedByReason
			.policy_missing,
		1
	)
	assert.equal(
		calls[0]?.path,
		'/api/admin/guardrails/effective?workspace_id=workspace%2Fone&user_id=user%2Fone'
	)
	assert.equal(calls[0]?.init.credentials, 'same-origin')
	assert.equal(calls[0]?.init.cache, 'no-store')
	assert.equal(
		new Headers(calls[0]?.init.headers).get(
			'X-CinaToken-Expected-Console-Subject'
		),
		'fixture-subject'
	)
	for (const header of [
		'Authorization',
		'X-CinaToken-Workspace',
		'New-Api-User',
	])
		assert.equal(new Headers(calls[0]?.init.headers).get(header), null)
	assert.equal(calls[0]?.init.method, 'GET')
	assert.equal(calls[0]?.init.body, undefined)
})

test('only a typed HTTP 409 is a displayable conflict; server message is discarded', async () => {
	const conflict = {
		success: false,
		code: 'guardrail_effective_conflict',
		message: secret,
		...scope,
		trace: [{ ...trace[0], config: { secret } }],
		config: { secret },
	}
	const { api, calls } = fixture(() => Response.json(conflict, { status: 409 }))
	const result = await api
		.previewGuardrail({ ...target, apiKeyId: 'key/one' })
		.catch((error) => error)
	assert.equal(result instanceof CinaTokenApiError, true)
	assert.equal(calls[0]?.path?.includes('api_key_id=key%2Fone'), true)
	const accepted = fixture(() => Response.json(conflict, { status: 409 }))
	const displayed = await accepted.api.previewGuardrail(target)
	assert.equal(displayed.kind, 'conflict')
	assert.equal(JSON.stringify(displayed).includes(secret), false)
	if (displayed.kind !== 'conflict') return
	assert.equal(displayed.code, 'guardrail_effective_conflict')
	assert.equal(displayed.budgetCurrency, 'EUR')
	assert.equal(displayed.pricingCurrency, 'USD')
	assert.deepEqual(displayed.trace, trace)
	for (const response of [
		Response.json({ ...conflict, code: 'workspace_mismatch' }, { status: 409 }),
		Response.json({ ...conflict, trace: null }, { status: 409 }),
		Response.json(conflict, { status: 200 }),
	])
		await assert.rejects(
			fixture(() => response).api.previewGuardrail(target),
			(error: unknown) =>
				error instanceof Error && !error.message.includes(secret)
		)
})

test('Admin preview rejects foreign scope, invalid currency, unsafe input and sanitized HTTP failure', async () => {
	for (const data of [
		{ ...success.data, workspaceId: 'other' },
		{ ...success.data, userId: 'other' },
		{ ...success.data, apiKeyId: 'key/other' },
		{ ...success.data, budgetCurrency: 'bad' },
		{ ...success.data, pricingCurrency: 'EUR' },
	])
		await assert.rejects(
			fixture(() =>
				Response.json({ success: true, data })
			).api.previewGuardrail(target),
			invalid
		)
	await assert.rejects(
		fixture(() =>
			Response.json({
				...success,
				data: {
					...success.data,
					effective: {
						...success.data.effective,
						inputFilters: [
							{ id: 'input-one', action: 'block', pattern: secret },
						],
					},
				},
			})
		).api.previewGuardrail(target),
		invalid
	)
	const invalidTarget = fixture(() => Response.json(success))
	await assert.rejects(
		invalidTarget.api.previewGuardrail({ ...target, userId: '  user/one ' }),
		TypeError
	)
	assert.equal(invalidTarget.calls.length, 0)
	for (const status of [401, 403, 503]) {
		const denied = fixture(() =>
			Response.json({ success: false, message: secret }, { status })
		)
		await assert.rejects(
			denied.api.previewGuardrail(target),
			(error: unknown) =>
				error instanceof CinaTokenApiError &&
				error.status === status &&
				!error.message.includes(secret)
		)
	}
})

test('abort remains authoritative if an injected request ignores its signal', async () => {
	let finish: ((response: Response) => void) | undefined
	const { api } = fixture(
		() =>
			new Promise<Response>((resolve) => {
				finish = resolve
			})
	)
	const abort = new AbortController()
	const pending = api.previewGuardrail(target, { signal: abort.signal })
	abort.abort()
	finish?.(Response.json(success))
	await assert.rejects(
		pending,
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'cancelled'
	)
})

async function render(
	locale: keyof typeof guardrailMessages,
	result?: AdminGuardrailPreviewResult
): Promise<string> {
	// Shared UI primitives use the classic JSX transform in the Node test runner.
	Object.assign(globalThis, { React })
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		fallbackLng: false,
		interpolation: { escapeValue: false },
		resources: Object.fromEntries(
			Object.entries(guardrailMessages).map(([language, messages]) => [
				language,
				{ translation: { cinatoken: { account: { guardrails: messages } } } },
			])
		),
	})
	return renderToStaticMarkup(
		React.createElement(
			I18nextProvider,
			{ i18n },
			result
				? React.createElement(AdminGuardrailPreviewEvidence, { result })
				: React.createElement(AdminGuardrailPreview, {
						api: fixture(() => Response.json(success)).api,
						scopeKey: 'verified-console',
						canRead: true,
						readOptions: (signal?: AbortSignal) => ({
							signal,
							expectedConsoleSubject: 'fixture-subject',
							expectedUserId: 'fixture-user',
						}),
					})
		)
	)
}

test('four-language Admin preview form and rich evidence render currencies, trace and planner limits', async () => {
	const projected = await fixture(() =>
		Response.json(success)
	).api.previewGuardrail(target)
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const form = await render(locale)
		assert.ok(form.includes(guardrailMessages[locale].previewTitle))
		assert.ok(form.includes(guardrailMessages[locale].previewUserId))
		assert.ok(form.includes(guardrailMessages[locale].previewApiKeyId))
		const evidence = await render(locale, projected)
		assert.ok(
			evidence.includes(guardrailMessages[locale].previewPlannerPricing)
		)
		assert.ok(
			evidence.includes(guardrailMessages[locale].previewPlannerEvidence)
		)
		assert.ok(evidence.includes('EUR'))
		assert.ok(evidence.includes('USD'))
		assert.ok(evidence.includes('Asia/Singapore'))
		assert.ok(evidence.includes('Provider One'))
		assert.ok(evidence.includes('Policy'))
		assert.equal(evidence.includes(secret), false)
	}
	const conflict = await fixture(() =>
		Response.json(
			{
				success: false,
				code: 'guardrail_effective_conflict',
				message: secret,
				...scope,
				trace,
			},
			{ status: 409 }
		)
	).api.previewGuardrail(target)
	const conflictHtml = await render('en', conflict)
	assert.ok(conflictHtml.includes(guardrailMessages.en.previewConflict))
	assert.ok(conflictHtml.includes('Policy'))
	assert.equal(conflictHtml.includes(secret), false)
})
