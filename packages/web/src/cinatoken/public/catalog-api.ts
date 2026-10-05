import type { z } from 'zod'
import {
	catalogDetailSchema,
	catalogModelsSchema,
	catalogProvidersSchema,
	catalogStatsRangeSchema,
	catalogStatsSchema,
	type CatalogStatsRange,
} from './catalog-contracts'

export type CatalogRequestOptions = { signal?: AbortSignal; timeoutMs?: number }
export class PublicCatalogError extends Error {
	constructor(
		readonly code:
			'http' | 'invalid-response' | 'network' | 'timeout' | 'cancelled',
		readonly status = 0,
		readonly retryAfter: string | null = null
	) {
		super(`Public catalog ${code}${status ? ` (${status})` : ''}`)
		this.name = 'PublicCatalogError'
	}
}

function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(new PublicCatalogError('cancelled'))
		if (signal.aborted) abort()
		else signal.addEventListener('abort', abort, { once: true })
		task.then(
			(value) => {
				signal.removeEventListener('abort', abort)
				resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', abort)
				reject(error)
			}
		)
	})
}

const MAX_CATALOG_RESPONSE_BYTES = 16 * 1024 * 1024

function cancelResponseBody(response: Response): void {
	void response.body?.cancel().catch(() => undefined)
}

async function readCatalogJson(
	response: Response,
	signal: AbortSignal
): Promise<unknown> {
	if (!response.body) throw new TypeError('Missing public catalog body')
	const reader = response.body.getReader()
	let cancelled = false
	const cancelReader = () => {
		if (cancelled) return
		cancelled = true
		// An uncooperative source's cancel promise must not delay the timeout.
		void reader.cancel().catch(() => undefined)
	}
	signal.addEventListener('abort', cancelReader, { once: true })
	let complete = false
	try {
		if (signal.aborted) throw new PublicCatalogError('cancelled')
		const declared = response.headers.get('content-length')
		if (
			declared !== null &&
			(!/^\d+$/.test(declared) ||
				!Number.isSafeInteger(Number(declared)) ||
				Number(declared) > MAX_CATALOG_RESPONSE_BYTES)
		)
			throw new TypeError('Invalid public catalog body size')
		const decoder = new TextDecoder('utf-8', {
			fatal: true,
			ignoreBOM: false,
		})
		const parts: string[] = []
		let bytes = 0
		while (true) {
			const item = await abortable(reader.read(), signal)
			if (signal.aborted) throw new PublicCatalogError('cancelled')
			if (item.done) break
			if (!(item.value instanceof Uint8Array))
				throw new TypeError('Invalid public catalog body chunk')
			bytes += item.value.byteLength
			if (bytes > MAX_CATALOG_RESPONSE_BYTES)
				throw new TypeError('Public catalog body is too large')
			parts.push(decoder.decode(item.value, { stream: true }))
		}
		parts.push(decoder.decode())
		const value: unknown = JSON.parse(parts.join(''))
		complete = true
		return value
	} finally {
		signal.removeEventListener('abort', cancelReader)
		if (!complete) cancelReader()
		reader.releaseLock()
	}
}

function hasControls(value: string): boolean {
	return Array.from(value).some(
		(character) =>
			character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
	)
}
function segment(value: string, maximum: number, slug = false): string {
	if (
		!value ||
		value.length > maximum ||
		value.trim() !== value ||
		value === '.' ||
		value === '..' ||
		hasControls(value) ||
		/[/\\]/.test(value) ||
		(slug && !/^[A-Za-z0-9._:~-]+$/.test(value))
	)
		throw new TypeError('Invalid catalog path')
	return encodeURIComponent(value)
}

function retryAfter(value: string | null): string | null {
	if (!value || value.length > 128) return null
	if (
		/^\d{1,5}$/.test(value) ||
		(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
			value
		) &&
			Number.isFinite(Date.parse(value)))
	)
		return value
	return null
}

/** Anonymous transport is deliberately independent of the Cookie/account API. */
export function createPublicCatalogApi(request: typeof fetch = fetch) {
	async function get<T>(
		path: string,
		schema: z.ZodType<T>,
		options: CatalogRequestOptions
	): Promise<T> {
		const timeoutMs = options.timeoutMs ?? 8_000
		if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
			throw new TypeError('Invalid catalog timeout')
		const controller = new AbortController()
		const cancel = () => controller.abort(options.signal?.reason)
		if (options.signal?.aborted) throw new PublicCatalogError('cancelled')
		options.signal?.addEventListener('abort', cancel, { once: true })
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			controller.abort()
		}, timeoutMs)
		try {
			const pending = request(path, {
				method: 'GET',
				credentials: 'omit',
				redirect: 'error',
				headers: { Accept: 'application/json' },
				signal: controller.signal,
			})
			const response = await abortable(
				pending.then((value) => {
					if (controller.signal.aborted) cancelResponseBody(value)
					return value
				}),
				controller.signal
			)
			if (!response.ok) {
				cancelResponseBody(response)
				throw new PublicCatalogError(
					'http',
					response.status,
					retryAfter(response.headers.get('retry-after'))
				)
			}
			if (response.status !== 200) {
				cancelResponseBody(response)
				throw new PublicCatalogError('invalid-response', response.status)
			}
			if (
				response.headers
					.get('content-type')
					?.split(';')[0]
					?.trim()
					.toLowerCase() !== 'application/json'
			) {
				cancelResponseBody(response)
				throw new PublicCatalogError('invalid-response', response.status)
			}
			let body: unknown
			try {
				body = await readCatalogJson(response, controller.signal)
			} catch {
				throw new PublicCatalogError('invalid-response', response.status)
			}
			const value = schema.safeParse(body)
			if (!value.success)
				throw new PublicCatalogError('invalid-response', response.status)
			if (options.signal?.aborted) throw new PublicCatalogError('cancelled')
			if (timedOut) throw new PublicCatalogError('timeout')
			return value.data
		} catch (error) {
			if (options.signal?.aborted) throw new PublicCatalogError('cancelled')
			if (timedOut) throw new PublicCatalogError('timeout')
			if (error instanceof PublicCatalogError) throw error
			throw new PublicCatalogError('network')
		} finally {
			clearTimeout(timer)
			options.signal?.removeEventListener('abort', cancel)
		}
	}
	return {
		models: (
			input: { routeGroups?: readonly string[] } = {},
			options: CatalogRequestOptions = {}
		) => {
			const groups = input.routeGroups ?? []
			if (
				groups.length > 32 ||
				groups.some(
					(group) =>
						!group ||
						group.length > 80 ||
						hasControls(group) ||
						group.includes(',') ||
						group.trim() !== group
				)
			)
				throw new TypeError('Invalid catalog route groups')
			const query = new URLSearchParams()
			if (groups.length)
				query.set(
					'route_groups',
					[...new Set(groups.map((group) => group.toLowerCase()))].join(',')
				)
			return get(
				`/api/public/catalog/models${query.size ? `?${query}` : ''}`,
				catalogModelsSchema,
				options
			)
		},
		model: async (
			vendor: string,
			slug: string,
			options: CatalogRequestOptions = {}
		) => {
			const value = await get(
				`/api/public/catalog/model/${segment(vendor, 80)}/${segment(slug, 256, true)}`,
				catalogDetailSchema,
				options
			)
			if (
				value.data.slug !== slug ||
				value.data.vendor.toLowerCase() !== vendor.toLowerCase()
			)
				throw new PublicCatalogError('invalid-response', 200)
			return value
		},
		providers: (options: CatalogRequestOptions = {}) =>
			get('/api/public/catalog/providers', catalogProvidersSchema, options),
		stats: async (
			range: CatalogStatsRange = '7d',
			options: CatalogRequestOptions = {}
		) => {
			const parsedRange = catalogStatsRangeSchema.parse(range)
			const value = await get(
				`/api/public/catalog/stats/models?range=${parsedRange}`,
				catalogStatsSchema,
				options
			)
			if (value.range !== parsedRange)
				throw new PublicCatalogError('invalid-response', 200)
			return value
		},
	}
}
export type PublicCatalogApi = ReturnType<typeof createPublicCatalogApi>
