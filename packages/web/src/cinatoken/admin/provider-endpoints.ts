/** Browser mirror of Core's write-side endpoint contract; no gateway runtime imports. */
export const PROVIDER_PROTOCOLS = [
	'openai',
	'anthropic',
	'gemini',
	'dashscope',
] as const
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number]
export const PROVIDER_CAPABILITIES = {
	openai: [
		'chat',
		'responses',
		'embeddings',
		'rerank',
		'images.generations',
		'images.edits',
		'audio.transcriptions',
		'audio.speech',
	],
	anthropic: ['messages'],
	gemini: ['models.generate', 'generateContent', 'streamGenerateContent'],
	dashscope: [
		'audio.transcriptions',
		'audio.transcriptions.multimodal',
		'audio.transcriptions.tasks',
		'audio.speech',
		'audio.speech.multimodal',
		'audio.realtime.inference',
		'audio.realtime.session',
		'audio.hotwords',
		'audio.voices',
	],
} as const
export type ProviderCapability =
	(typeof PROVIDER_CAPABILITIES)[ProviderProtocol][number]
export type ProviderProtocolEndpoints = {
	base?: string
	endpoints?: Partial<Record<ProviderCapability, string>>
	auth?: 'query-key' | 'bearer'
}
export type ProviderEndpoints = Partial<
	Record<ProviderProtocol, ProviderProtocolEndpoints>
>

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function text(value: unknown): string | null {
	if (value == null) return null
	return String(value).trim() || null
}
function invalid(): never {
	throw new Error('Provider endpoints are invalid')
}
function validateUrl(value: string, websocket: boolean): void {
	let url: URL
	try {
		url = new URL(
			value.replace(/\{(?:model|action|task_id)\}/gu, 'placeholder')
		)
	} catch {
		return invalid()
	}
	const protocols = websocket ? ['ws:', 'wss:'] : ['http:', 'https:']
	if (!protocols.includes(url.protocol)) invalid()
}

/** Core accepts JSON text, objects, null and empty text. Empty protocols disappear. */
export function normalizeProviderEndpoints(input: unknown): ProviderEndpoints {
	let value = input
	if (typeof input === 'string') {
		if (!input.trim()) return {}
		try {
			value = JSON.parse(input)
		} catch {
			return invalid()
		}
	}
	if (value == null) return {}
	if (!object(value)) return invalid()
	const result: ProviderEndpoints = {}
	for (const [key, raw] of Object.entries(value)) {
		if (
			!(PROVIDER_PROTOCOLS as readonly string[]).includes(key) ||
			!object(raw)
		)
			invalid()
		const protocol = key as ProviderProtocol
		const base = text(raw.base)
		if (base) validateUrl(base, false)
		const endpoints: Partial<Record<ProviderCapability, string>> = {}
		if (raw.endpoints != null) {
			if (!object(raw.endpoints)) invalid()
			for (const [capability, rawUrl] of Object.entries(raw.endpoints)) {
				if (
					!(PROVIDER_CAPABILITIES[protocol] as readonly string[]).includes(
						capability
					)
				)
					invalid()
				const url = text(rawUrl)
				if (!url) continue
				const realtime =
					protocol === 'dashscope' &&
					['audio.realtime.inference', 'audio.realtime.session'].includes(
						capability
					)
				validateUrl(url, realtime)
				if (
					protocol === 'gemini' &&
					(!url.includes('{model}') ||
						(capability === 'models.generate' && !url.includes('{action}')))
				)
					invalid()
				if (
					protocol === 'dashscope' &&
					capability === 'audio.transcriptions.tasks' &&
					!url.includes('{task_id}')
				)
					invalid()
				endpoints[capability as ProviderCapability] = url
			}
		}
		if (!base && !Object.keys(endpoints).length) continue
		if (
			raw.auth != null &&
			raw.auth !== '' &&
			(protocol !== 'gemini' ||
				!['query-key', 'bearer'].includes(String(raw.auth)))
		)
			invalid()
		const config: ProviderProtocolEndpoints = {}
		if (base) config.base = base.replace(/\/+$/u, '')
		if (Object.keys(endpoints).length) config.endpoints = endpoints
		if (
			protocol === 'gemini' &&
			(raw.auth === 'query-key' || raw.auth === 'bearer')
		)
			config.auth = raw.auth
		result[protocol] = config
	}
	return result
}

const secretUrlParameters = new Set([
	'key',
	'apikey',
	'token',
	'accesstoken',
	'authorization',
	'secret',
	'password',
	'credential',
	'signature',
	'xgoogapikey',
])

/** Read DTOs fail closed rather than caching credentials or silently rewriting a URL. */
export function providerEndpointsHaveCredentials(
	endpoints: ProviderEndpoints
): boolean {
	for (const config of Object.values(endpoints)) {
		for (const value of [
			config.base,
			...Object.values(config.endpoints ?? {}),
		]) {
			if (!value) continue
			const url = new URL(
				value.replace(/\{(?:model|action|task_id)\}/gu, 'placeholder')
			)
			if (url.username || url.password) return true
			for (const name of url.searchParams.keys()) {
				if (
					secretUrlParameters.has(name.toLowerCase().replace(/[^a-z0-9]/gu, ''))
				)
					return true
			}
		}
	}
	return false
}
