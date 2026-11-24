/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
/**
 * Shared helpers for Admin Playground / Simulator image APIs
 * (`/images/generations` JSON and `/images/edits` multipart).
 */
import {
	isImageGenerationModel,
	type ModelKindFields,
} from './model-modalities'
import { previewPayloads, MAX_PREVIEW_TEXT_CHARS } from './native-media'

/** OpenAI Images operation: text-to-image vs image edit. */
export type ImageOperation = 'generations' | 'edits'

/** Align with Proxy `openai-images-driver` limits (admin must not depend on `@octafuse/proxy`). */
export const IMAGE_MAX_REFERENCE_COUNT = 5
export const IMAGE_MAX_BYTES_PER_FILE = 20 * 1024 * 1024
export const IMAGE_MAX_TOTAL_UPLOAD_BYTES =
	IMAGE_MAX_REFERENCE_COUNT * IMAGE_MAX_BYTES_PER_FILE

/** Default request body for `POST …/images/generations` (model field overwritten at send). */
export const IMAGE_GENERATIONS_BODY_TEMPLATE = `{
  "model": "<auto>",
  "prompt": "a red apple on a white background",
  "n": 1,
  "size": "1024x1024",
  "quality": "low"
}`

/**
 * Default JSON fields for images/edits (reference images are uploaded separately as multipart files).
 * model field overwritten at send.
 */
export const IMAGE_EDITS_BODY_TEMPLATE = `{
  "model": "<auto>",
  "prompt": "make the apple green",
  "n": 1,
  "size": "1024x1024",
  "quality": "low"
}`

const IMAGE_SAMPLE_PROMPT = 'a red apple on a white background'
const IMAGE_EDIT_PROMPT = 'make the apple green'
const SEEDREAM_SAMPLE_PROMPT = '一只戴着墨镜的橘猫，坐在海边，日落，超写实。'
const MINIMAX_SAMPLE_PROMPT =
	'A red paper lantern over a quiet canal at dusk, cinematic lighting'
const DASHSCOPE_NATIVE_PROMPT = '一只橙色的猫坐在窗边'

export type ImageSampleFamily =
	| 'gpt'
	| 'seedream-lite'
	| 'seedream-pro'
	| 'qwen'
	| 'wan'
	| 'glm'
	| 'grok'
	| 'grok-quality'
	| 'gemini'
	| 'minimax'
	| 'unknown'

export type ImageBodyTemplateInput = {
	protocol: string
	adapter?: string | null
	modelId?: string | null
	providerModelName?: string | null
	operation?: ImageOperation
}

/** 用供应商模型名识别族；没有供应商模型名时回退到目录模型 ID。`pro|flash` 归入 Seedream pro。 */
export function imageSampleFamily(
	input: ImageBodyTemplateInput
): ImageSampleFamily {
	const provider = input.providerModelName?.trim() ?? ''
	const name = provider || input.modelId?.trim() || ''
	if (/seedream/i.test(name))
		return /pro|flash/i.test(name) ? 'seedream-pro' : 'seedream-lite'
	if (/minimax-image|^image-01/i.test(name)) return 'minimax'
	if (/qwen/i.test(name)) return 'qwen'
	if (/wan2|wanx/i.test(name)) return 'wan'
	if (/grok/i.test(name)) return /quality/i.test(name) ? 'grok-quality' : 'grok'
	if (/gemini|imagen/i.test(name)) return 'gemini'
	if (/glm/i.test(name)) return 'glm'
	if (/gpt-image/i.test(name)) return 'gpt'
	const adapter = input.adapter?.trim() ?? ''
	if (adapter === 'dashscope-image-qwen') return 'qwen'
	if (adapter === 'dashscope-image-wan') return 'wan'
	if (adapter === 'minimax-image') return 'minimax'
	if (adapter === 'volcengine-image') return 'seedream-lite'
	if (adapter === 'gemini-image') return 'gemini'
	return 'unknown'
}

function prettyJson(value: unknown): string {
	return JSON.stringify(value, null, 2)
}

function openaiImageSample(
	family: ImageSampleFamily,
	operation: ImageOperation
): Record<string, unknown> {
	const prompt = operation === 'edits' ? IMAGE_EDIT_PROMPT : IMAGE_SAMPLE_PROMPT
	switch (family) {
		case 'gpt':
			return {
				model: '<auto>',
				prompt,
				n: 1,
				size: '1024x1024',
				quality: 'low',
			}
		case 'seedream-lite':
			return {
				model: '<auto>',
				prompt: SEEDREAM_SAMPLE_PROMPT,
				n: 1,
				size: '2K',
				watermark: false,
			}
		case 'seedream-pro':
			return {
				model: '<auto>',
				prompt: SEEDREAM_SAMPLE_PROMPT,
				n: 1,
				size: '1K',
				watermark: false,
			}
		case 'qwen':
			return {
				model: '<auto>',
				prompt: IMAGE_SAMPLE_PROMPT,
				n: 1,
				size: '1024*1024',
				parameters: { negative_prompt: 'blurry', seed: 42 },
			}
		case 'wan':
			return { model: '<auto>', prompt: IMAGE_SAMPLE_PROMPT, n: 1, size: '1K' }
		case 'glm':
			return {
				model: '<auto>',
				prompt: IMAGE_SAMPLE_PROMPT,
				n: 1,
				size: '1280x1280',
			}
		case 'grok':
			return {
				model: '<auto>',
				prompt: IMAGE_SAMPLE_PROMPT,
				n: 1,
				resolution: '1k',
				aspect_ratio: '1:1',
				quality: 'low',
			}
		case 'grok-quality':
			return {
				model: '<auto>',
				prompt: IMAGE_SAMPLE_PROMPT,
				n: 1,
				resolution: '1k',
				aspect_ratio: '1:1',
			}
		case 'gemini':
			return {
				model: '<auto>',
				prompt: IMAGE_SAMPLE_PROMPT,
				n: 1,
				size: '1024x1024',
				response_format: 'b64_json',
			}
		case 'minimax':
			return {
				model: '<auto>',
				prompt: MINIMAX_SAMPLE_PROMPT,
				n: 1,
				aspect_ratio: '1:1',
				response_format: 'url',
				prompt_optimizer: true,
				aigc_watermark: false,
			}
		default:
			return { model: '<auto>', prompt: IMAGE_SAMPLE_PROMPT, n: 1 }
	}
}

function dashscopeNativeSample(
	family: ImageSampleFamily
): Record<string, unknown> {
	let size: string | undefined
	if (family === 'wan') size = '1K'
	if (family === 'qwen') size = '1024*1024'
	return {
		model: '<auto>',
		input: {
			messages: [
				{ role: 'user', content: [{ text: DASHSCOPE_NATIVE_PROMPT }] },
			],
		},
		parameters: size ? { size, n: 1 } : { n: 1 },
	}
}

function geminiNativeImageSample(): Record<string, unknown> {
	return {
		contents: [{ role: 'user', parts: [{ text: IMAGE_SAMPLE_PROMPT }] }],
		generationConfig: {
			responseModalities: ['TEXT', 'IMAGE'],
			imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
		},
	}
}

function volcengineNativeSample(
	family: ImageSampleFamily
): Record<string, unknown> {
	return {
		model: '<auto>',
		prompt: SEEDREAM_SAMPLE_PROMPT,
		size: family === 'seedream-pro' ? '1K' : '2K',
		response_format: 'url',
		watermark: false,
		stream: false,
		sequential_image_generation: 'disabled',
	}
}

/** MiniMax 文生图 / 图生图共用 POST /v1/image_generation。 */
export const MINIMAX_IMAGE_BODY_TEMPLATE = `{
  "model": "<auto>",
  "prompt": "A red paper lantern over a quiet canal at dusk, cinematic lighting",
  "aspect_ratio": "1:1",
  "response_format": "url",
  "n": 1
}`

/**
 * 按模型族生成生图请求样例。尺寸取该型号官方支持的最低档。
 * OpenAI 入口只放该族的官方字段；原生透传按同一族选尺寸。
 */
export function imageBodyTemplateFor(input: ImageBodyTemplateInput): string {
	const protocol = input.protocol.trim().toLowerCase()
	const adapter = input.adapter?.trim() ?? ''
	const operation = input.operation ?? 'generations'
	const family = imageSampleFamily(input)
	if (protocol === 'gemini' && adapter !== 'gemini-image') {
		return prettyJson(geminiNativeImageSample())
	}
	if (protocol === 'volcengine' && adapter !== 'volcengine-image') {
		return prettyJson(volcengineNativeSample(family))
	}
	if (protocol === 'minimax' && adapter !== 'minimax-image') {
		return MINIMAX_IMAGE_BODY_TEMPLATE
	}
	if (
		protocol === 'dashscope' &&
		adapter !== 'dashscope-image-qwen' &&
		adapter !== 'dashscope-image-wan'
	) {
		return prettyJson(dashscopeNativeSample(family))
	}
	return prettyJson(openaiImageSample(family, operation))
}

/** 火山方舟 / BytePlus Seedream 原生生图默认样例（未识别型号时用 lite 最低档 `2K`）。 */
export const VOLCENGINE_IMAGE_BODY_TEMPLATE = imageBodyTemplateFor({
	protocol: 'volcengine',
})

export function isImageRouteModel(m: ModelKindFields): boolean {
	return isImageGenerationModel(m)
}

/** Validate reference image files before send (Playground / Simulator). */
export function validateEditImageFiles(
	files: File[]
): { ok: true } | { ok: false; error: string } {
	if (files.length === 0) {
		return { ok: false, error: 'At least one reference image is required' }
	}
	if (files.length > IMAGE_MAX_REFERENCE_COUNT) {
		return {
			ok: false,
			error: `At most ${IMAGE_MAX_REFERENCE_COUNT} reference images are allowed`,
		}
	}
	let total = 0
	for (const file of files) {
		if (file.size > IMAGE_MAX_BYTES_PER_FILE) {
			return {
				ok: false,
				error: `each image must be at most ${IMAGE_MAX_BYTES_PER_FILE} bytes`,
			}
		}
		total += file.size
		if (total > IMAGE_MAX_TOTAL_UPLOAD_BYTES) {
			return {
				ok: false,
				error: `total image upload must be at most ${IMAGE_MAX_TOTAL_UPLOAD_BYTES} bytes`,
			}
		}
	}
	return { ok: true }
}

/** Read a File as a data URL (for Playground JSON → server multipart). */
export function readFileAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => {
			if (typeof reader.result === 'string') resolve(reader.result)
			else reject(new Error('Failed to read file as data URL'))
		}
		reader.onerror = () =>
			reject(reader.error ?? new Error('Failed to read file'))
		reader.readAsDataURL(file)
	})
}

export type ImagePreviewItem =
	{ kind: 'b64'; src: string } | { kind: 'url'; src: string }

export type ParsedImagesGenerationsResponse = {
	images: ImagePreviewItem[]
	count: number
	/** Short usage line for Admin panels (image count + optional quality/size from request). */
	usageHint: string | null
}

/**
 * Parse OpenAI-compatible images generations JSON into preview URLs / data URLs.
 */
function asPreviewObject(value: unknown): Record<string, unknown> | null {
	return value != null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function collectOpenAiImagePreviews(data: unknown[]): ImagePreviewItem[] {
	const images: ImagePreviewItem[] = []
	for (const item of data) {
		if (images.length >= 100) break
		if (!item || typeof item !== 'object') continue
		const row = item as { b64_json?: unknown; url?: unknown }
		if (typeof row.b64_json === 'string' && row.b64_json.trim()) {
			const b64 = row.b64_json.trim()
			const src = b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`
			images.push({ kind: 'b64', src })
			continue
		}
		if (typeof row.url === 'string' && row.url.trim()) {
			images.push({ kind: 'url', src: row.url.trim() })
		}
	}
	return images
}

/** DashScope multimodal-generation: `output.choices[].message.content[].image`. */
function collectDashScopeImagePreviews(
	parsed: Record<string, unknown>
): ImagePreviewItem[] {
	const output = asPreviewObject(parsed.output)
	const choices = Array.isArray(output?.choices) ? output.choices : []
	const images: ImagePreviewItem[] = []
	for (const choice of choices) {
		if (images.length >= 100) break
		const message = asPreviewObject(asPreviewObject(choice)?.message)
		const content = Array.isArray(message?.content) ? message.content : []
		for (const part of content) {
			if (images.length >= 100) break
			const image = asPreviewObject(part)?.image
			if (typeof image !== 'string' || !image.trim()) continue
			const src = image.trim()
			images.push(
				src.startsWith('data:') ? { kind: 'b64', src } : { kind: 'url', src }
			)
		}
	}
	return images
}

/** MiniMax image_generation：`data.image_urls` 或 `data.image_base64`。 */
export function collectMiniMaxImagePreviews(
	parsed: Record<string, unknown>
): ImagePreviewItem[] {
	const data = asPreviewObject(parsed.data)
	if (!data) return []
	const images: ImagePreviewItem[] = []
	const urls = Array.isArray(data.image_urls) ? data.image_urls : []
	for (const url of urls) {
		if (images.length >= 100) break
		if (typeof url !== 'string' || !url.trim()) continue
		images.push({ kind: 'url', src: url.trim() })
	}
	const encoded = Array.isArray(data.image_base64) ? data.image_base64 : []
	for (const raw of encoded) {
		if (images.length >= 100) break
		if (typeof raw !== 'string' || !raw.trim()) continue
		const value = raw.trim()
		images.push({
			kind: 'b64',
			src: value.startsWith('data:')
				? value
				: `data:image/jpeg;base64,${value}`,
		})
	}
	return images
}

/** Gemini generateContent：非 thought 的 `inlineData` 转成 data URL，并带出文本 part。 */
export function collectGeminiInlineDataPreviews(
	parsed: Record<string, unknown>
): {
	images: ImagePreviewItem[]
	texts: string[]
} {
	const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : []
	const images: ImagePreviewItem[] = []
	const texts: string[] = []
	for (const candidate of candidates) {
		if (images.length >= 100) break
		const content = asPreviewObject(asPreviewObject(candidate)?.content)
		const parts = Array.isArray(content?.parts) ? content.parts : []
		for (const part of parts) {
			if (images.length >= 100) break
			const row = asPreviewObject(part)
			if (!row || row.thought === true) continue
			if (typeof row.text === 'string' && row.text.trim() && texts.length < 100)
				texts.push(row.text.trim().slice(0, 80))
			const inline =
				asPreviewObject(row.inlineData) ?? asPreviewObject(row.inline_data)
			if (!inline) continue
			const data = typeof inline.data === 'string' ? inline.data.trim() : ''
			if (!data) continue
			let mime = 'image/png'
			if (typeof inline.mimeType === 'string') mime = inline.mimeType
			else if (typeof inline.mime_type === 'string') mime = inline.mime_type
			if (!mime.startsWith('image/')) continue
			images.push({
				kind: 'b64',
				src: data.startsWith('data:') ? data : `data:${mime};base64,${data}`,
			})
		}
	}
	return { images, texts }
}

/** Read both native JSON and complete SSE image events without repeating previews. */
export function parseImagesGenerationsResponse(
	jsonText: string,
	requestMeta?: { quality?: string; size?: string; n?: number }
): ParsedImagesGenerationsResponse {
	const empty = { images: [], count: 0, usageHint: null }
	const previews: ImagePreviewItem[] = []
	let caption: string | undefined
	for (const record of previewPayloads(jsonText)) {
		if (previews.length >= 100) break
		if (Array.isArray(record.data))
			previews.push(...collectOpenAiImagePreviews(record.data))
		const gemini = collectGeminiInlineDataPreviews(record)
		if (!caption) caption = gemini.texts[0]
		previews.push(
			...collectMiniMaxImagePreviews(record),
			...gemini.images,
			...collectDashScopeImagePreviews(record)
		)
		// Volcengine's SSE image event is a single item rather than a data array.
		if (record.type === 'image_generation.partial_succeeded')
			previews.push(...collectOpenAiImagePreviews([record]))
	}
	const seen = new Set<string>()
	const images = previews.filter((image) => {
		if (
			!safeImagePreviewSource(image.src) ||
			seen.has(image.src) ||
			seen.size >= 100
		)
			return false
		seen.add(image.src)
		return true
	})
	if (!images.length) return empty
	const parts = [`${images.length} image${images.length === 1 ? '' : 's'}`]
	if (caption) parts.push(caption)
	if (requestMeta?.quality) parts.push(`quality=${requestMeta.quality}`)
	if (requestMeta?.size) parts.push(`size=${requestMeta.size}`)
	if (requestMeta?.n != null && Number.isFinite(requestMeta.n))
		parts.push(`n=${requestMeta.n}`)
	return { images, count: images.length, usageHint: parts.join(' · ') }
}
export function safeImagePreviewSource(src: string): boolean {
	if (src.length > MAX_PREVIEW_TEXT_CHARS) return false
	if (/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/iu.test(src))
		return true
	if (src.length > 16_384) return false
	try {
		const url = new URL(src)
		return (
			['http:', 'https:'].includes(url.protocol) &&
			!url.username &&
			!url.password
		)
	} catch {
		return false
	}
}

/** Extract quality/size/n from a request body object for usage hints. */
export function imageRequestMetaFromBody(body: Record<string, unknown>): {
	quality?: string
	size?: string
	n?: number
} {
	const quality = typeof body.quality === 'string' ? body.quality : undefined
	const size = typeof body.size === 'string' ? body.size : undefined
	const nRaw = body.n
	let n: number | undefined
	if (typeof nRaw === 'number' && Number.isFinite(nRaw)) n = nRaw
	else if (
		typeof nRaw === 'string' &&
		nRaw.trim() &&
		Number.isFinite(Number(nRaw))
	)
		n = Number(nRaw)
	return { quality, size, n }
}
