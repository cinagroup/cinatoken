import type { CatalogModel } from './catalog-contracts'

const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`
export function buildCatalogExample(
	model: CatalogModel,
	protocol: string,
	rawOrigin = 'https://api.cinatoken.com',
	prompt = 'Hello'
): string | null {
	if (
		!model.protocols.some((value) => value === protocol) ||
		!model.input_modalities?.includes('text') ||
		!model.output_modalities?.includes('text')
	)
		return null
	let origin: URL
	try {
		origin = new URL(rawOrigin)
	} catch {
		return null
	}
	if (
		!['http:', 'https:'].includes(origin.protocol) ||
		origin.username ||
		origin.password
	)
		return null
	let path: string
	let payload: unknown
	const headers = [
		"-H 'Authorization: Bearer YOUR_API_KEY'",
		"-H 'Content-Type: application/json'",
	]
	if (protocol === 'openai') {
		path = '/v1/chat/completions'
		payload = { model: model.id, messages: [{ role: 'user', content: prompt }] }
	} else if (protocol === 'anthropic') {
		if (model.max_tokens === 0) return null
		path = '/v1/messages'
		payload = {
			model: model.id,
			max_tokens: Math.min(model.max_tokens ?? 128, 128),
			messages: [{ role: 'user', content: prompt }],
		}
		headers.push("-H 'anthropic-version: 2023-06-01'")
	} else if (protocol === 'gemini') {
		path = `/v1beta/models/${encodeURIComponent(model.id)}:generateContent`
		payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }] }
	} else return null
	return [
		`curl ${shellQuote(`${origin.origin}${path}`)}`,
		...headers,
		`--data ${shellQuote(JSON.stringify(payload, null, 2))}`,
	].join(' \\\n  ')
}
