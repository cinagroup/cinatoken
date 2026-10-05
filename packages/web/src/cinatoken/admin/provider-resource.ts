import type { ProviderJson, ProviderJsonObject } from './provider-contracts'

export type ProviderDashScopeResult = {
	body: ProviderJsonObject
	redactedPaths: string[]
}
const credentialFields = new Set([
	'apikey',
	'authorization',
	'accesstoken',
	'refreshtoken',
	'clientsecret',
	'privatekey',
	'encryptedapikey',
	'encryptedkey',
	'password',
])
function pointer(value: string): string {
	return value.replace(/~/gu, '~0').replace(/\//gu, '~1')
}

/** Preserve diagnostics and native fields, marking only credential fields or known secret bytes. */
export function redactProviderResource(
	body: ProviderJsonObject,
	knownSecrets: readonly string[] = []
): ProviderDashScopeResult {
	const values = knownSecrets
		.filter((value) => typeof value === 'string' && value.length > 0)
		.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)])
	const redactedPaths: string[] = []
	function redact(value: ProviderJson, path: string): ProviderJson {
		if (typeof value === 'string') {
			let result = value
			for (const secret of values)
				result = result.split(secret).join('[REDACTED]')
			if (result !== value) redactedPaths.push(path)
			return result
		}
		if (Array.isArray(value))
			return value.map((item, index) => redact(item, path + '/' + index))
		if (value !== null && typeof value === 'object') {
			const result: ProviderJsonObject = {}
			for (const [key, item] of Object.entries(value)) {
				const itemPath = path + '/' + pointer(key)
				let output: ProviderJson
				if (
					credentialFields.has(key.toLowerCase().replace(/[^a-z0-9]/gu, ''))
				) {
					output = '[REDACTED]'
					redactedPaths.push(itemPath)
				} else output = redact(item, itemPath)
				Object.defineProperty(result, key, {
					value: output,
					enumerable: true,
					configurable: true,
					writable: true,
				})
			}
			return result
		}
		return value
	}
	return { body: redact(body, '') as ProviderJsonObject, redactedPaths }
}
