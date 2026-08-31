import { sanitizeUpstreamUrlForLog, upstreamErrorNameForLog } from './egress/upstream-observability';
import { finalizeRequestLogJson } from './request-log-shared';

export function webFetchRequestBodyForLog(url: string, provider: string): string | null {
	return finalizeRequestLogJson({ url: sanitizeUpstreamUrlForLog(url), provider });
}

export function webFetchResponseBodyForLog(value: {
	url: string;
	title?: string;
	content: string;
}): string | null {
	return finalizeRequestLogJson({
		url: sanitizeUpstreamUrlForLog(value.url),
		title: value.title ?? null,
		content_preview: value.content.slice(0, 240),
		content_length: value.content.length,
	});
}

export function webFetchErrorForLog(error: unknown): string {
	return upstreamErrorNameForLog(error);
}
