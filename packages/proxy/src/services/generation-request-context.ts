import type { InsertRequestLogParams } from '@octafuse/core';

export type GenerationRequestContextSnapshot = Pick<
	InsertRequestLogParams,
	'httpReferer' | 'userAgent'
>;

const MAX_GENERATION_HEADER_CHARS = 512;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function boundedHeader(value: string | null): string | null {
	if (value == null) return null;
	const normalized = value.trim();
	return normalized.length > 0
		&& normalized.length <= MAX_GENERATION_HEADER_CHARS
		&& !CONTROL_CHAR_PATTERN.test(normalized)
		? normalized
		: null;
}

/**
 * Keep only the site origin from OpenRouter's application identifier header.
 * Paths, query strings, fragments, and URL credentials can contain user data or
 * secrets and are not needed to identify the calling application.
 */
export function normalizeGenerationHttpReferer(value: string | null): string | null {
	const safe = boundedHeader(value);
	if (safe == null) return null;
	try {
		const url = new URL(safe);
		if (
			(url.protocol !== 'https:' && url.protocol !== 'http:')
			|| url.username !== ''
			|| url.password !== ''
		) return null;
		return url.origin.length <= MAX_GENERATION_HEADER_CHARS ? url.origin : null;
	} catch {
		return null;
	}
}

export function normalizeGenerationUserAgent(value: string | null): string | null {
	return boundedHeader(value);
}

export function generationRequestContext(headers: Headers): GenerationRequestContextSnapshot {
	return {
		httpReferer: normalizeGenerationHttpReferer(headers.get('HTTP-Referer')),
		userAgent: normalizeGenerationUserAgent(headers.get('User-Agent')),
	};
}

export function generationRequestLogContext(headers: Headers): {
	http_referer: string | null;
	user_agent: string | null;
} {
	const context = generationRequestContext(headers);
	return {
		http_referer: context.httpReferer ?? null,
		user_agent: context.userAgent ?? null,
	};
}
