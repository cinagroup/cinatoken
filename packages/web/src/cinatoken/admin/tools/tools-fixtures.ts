/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { ToolAuditPage } from './tools-audit'
import type { ToolDetail, ToolOverview } from './tools-contracts'
import {
	toolProviders,
	toolFamilies,
	type ToolFamily,
	type ToolProvider,
} from './tools-domain'
import { encodeToolToken } from './tools-token'

const keys = {
	'web-search': [
		'BILLING_CURRENCY',
		'WEB_SEARCH_ACTIVE',
		'WEB_SEARCH_API_KEY',
		'WEB_SEARCH_CATALOG',
		'WEB_SEARCH_COST',
		'WEB_SEARCH_PROVIDER',
	],
	'web-fetch': [
		'BILLING_CURRENCY',
		'WEB_FETCH_ACTIVE',
		'WEB_FETCH_API_KEY',
		'WEB_FETCH_CATALOG',
		'WEB_FETCH_COST',
		'WEB_FETCH_PROVIDER',
	],
	'web-deep-search': [
		'BILLING_CURRENCY',
		'WEB_DEEP_SEARCH_ACTIVE',
		'WEB_DEEP_SEARCH_CATALOG',
	],
	'ai-detection': [
		'AI_DETECTION_ACTIVE',
		'AI_DETECTION_CATALOG',
		'BILLING_CURRENCY',
	],
}
export const fixtureAuditId = '00000000-0000-4000-8000-000000000001'
export const fixtureSubject = 'tools-qa/ops team%2F'
export const fixtureAuth = {
	authenticated: true,
	verification: 'verified',
	principalType: 'console',
	subject: fixtureSubject,
}
export const fixtureCaps = {
	can_write: true,
	can_reveal: true,
	can_playground: true,
	can_invocations: true,
}
export function fixtureVersion(family: ToolFamily): string {
	return encodeToolToken({
		v: 1,
		family,
		readSet: keys[family].map((key) => ({ key, revision: null })),
	})
}
export function fixtureDetail(
	family: ToolFamily = 'web-search',
	provider: ToolProvider = toolProviders[family][0]
): ToolDetail {
	const ai = family === 'ai-detection',
		version = fixtureVersion(family)
	return {
		family,
		provider,
		version,
		billingCurrency: { value: 'USD', source: 'missing' },
		familyState: {
			family,
			version,
			source: 'missing',
			catalogState: 'missing',
			savedActive: null,
			activeState: 'missing',
			effectiveProvider: provider,
			configurationReady: true,
			configurationIssue: 'none',
			editable: true,
			editBlockedCode: null,
		},
		configuration: {
			provider,
			implemented: true,
			entrySource: 'default',
			configured: true,
			credentials: (ai ? ['secretId', 'secretKey'] : ['apiKey']).map(
				(field) => ({
					field: field as 'apiKey' | 'secretId' | 'secretKey',
					required: true,
					configured: true,
				})
			),
			prices: { metered: 0.001, standard: 0.002, charged: 0.003 },
			priceSource: 'default',
			unit: ai ? 'chars' : 'request',
			billingUnitChars: ai ? 2000 : null,
			isLossPricing: false,
		},
		settings: ai
			? {
					region: {
						value: 'ap-guangzhou',
						availability: 'available',
						source: 'default',
					},
					bizType: { value: '', availability: 'available', source: 'missing' },
				}
			: null,
		capabilities: { ...fixtureCaps },
	}
}
export function fixtureOverview(): ToolOverview {
	return {
		billingCurrency: { value: 'USD', source: 'missing' },
		capabilities: { ...fixtureCaps },
		families: toolFamilies.map((family) => ({
			...fixtureDetail(family).familyState,
			providers: toolProviders[family].map(
				(provider) => fixtureDetail(family, provider).configuration
			),
		})),
	}
}
export function fixtureAudit(family: ToolFamily = 'web-search'): ToolAuditPage {
	return {
		entries: [
			{
				id: fixtureAuditId,
				family,
				provider: toolProviders[family][0],
				action: 'save',
				actorKind: 'console',
				actorId: 'console:cinaauth:' + fixtureSubject,
				source: 'admin_api',
				reason: 'Fix reviewed prices',
				changedFields: [
					{ provider: toolProviders[family][0], field: 'charged' },
				],
				activeBefore: toolProviders[family][0],
				activeAfter: toolProviders[family][0],
				credentials: [],
				beforeVersion: fixtureVersion(family),
				afterVersion: fixtureVersion(family),
				createdAt: '2026-10-01T00:00:00.123456Z',
			},
		],
		next_cursor: null,
	}
}
export function fixtureResponse(data: unknown, status = 200) {
	return new Response(JSON.stringify({ success: status < 400, data }), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}
