/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export const toolFamilies = [
	'web-search',
	'web-fetch',
	'web-deep-search',
	'ai-detection',
] as const
export type ToolFamily = (typeof toolFamilies)[number]
export type ToolCredentialField = 'apiKey' | 'secretId' | 'secretKey'
export const toolProviders = {
	'web-search': ['bocha', 'tavily', 'cleversee', 'tencent_wsa'],
	'web-fetch': ['firecrawl', 'tavily', 'jina'],
	'web-deep-search': ['firecrawl', 'jina'],
	'ai-detection': ['tencent_tms'],
} as const
export type ToolProvider = (typeof toolProviders)[ToolFamily][number]
export function validToolTarget(
	family: ToolFamily,
	provider: string
): provider is ToolProvider {
	return (toolProviders[family] as readonly string[]).includes(provider)
}
const docs: Record<ToolFamily, Partial<Record<ToolProvider, string>>> = {
	'web-search': {
		bocha: 'https://open.bochaai.com/',
		tavily: 'https://app.tavily.com/',
		cleversee: 'https://help.aliyun.com/zh/product/3037946.html',
		tencent_wsa: 'https://cloud.tencent.com/product/wsa',
	},
	'web-fetch': {
		firecrawl: 'https://docs.firecrawl.dev/',
		tavily:
			'https://docs.tavily.com/documentation/api-reference/endpoint/extract',
		jina: 'https://jina.ai/reader/',
	},
	'web-deep-search': {
		firecrawl: 'https://docs.firecrawl.dev/features/search',
		jina: 'https://jina.ai/reader/',
	},
	'ai-detection': {
		tencent_tms: 'https://cloud.tencent.com/document/product/1124',
	},
}
export function toolDocsHref(
	family: ToolFamily,
	provider: ToolProvider
): string | null {
	return validToolTarget(family, provider)
		? (docs[family][provider] ?? null)
		: null
}
export function toolPlaygroundHref(
	family: ToolFamily,
	provider: ToolProvider
): string {
	const params = new URLSearchParams({ mode: 'tools', tool: family, provider })
	return '/admin/playground?' + params.toString()
}
export function toolInvocationsHref(family?: ToolFamily): string {
	return family
		? '/admin/tools/invocations?' +
				new URLSearchParams({ tool: family }).toString()
		: '/admin/tools/invocations'
}
export const toolsPrefix = 'cinatoken.adminTools.'
export const familyMessageKeys: Record<ToolFamily, string> = {
	'web-search': 'webSearch',
	'web-fetch': 'webFetch',
	'web-deep-search': 'webDeepSearch',
	'ai-detection': 'aiDetection',
}
export function toolProviderLabelKey(
	family: ToolFamily,
	provider: ToolProvider
): string {
	return toolsPrefix + familyMessageKeys[family] + '.providers.' + provider
}
