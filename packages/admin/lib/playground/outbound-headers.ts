import { safePlaygroundWireJson } from './private-preview';
/** 调试台上游出站请求头：脱敏、响应头编解码。 */

const SECRET_HEADER_NAMES = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-goog-api-key']);

export function redactPlaygroundOutboundHeaderValue(name: string, value: string): string {
	if (SECRET_HEADER_NAMES.has(name.toLowerCase()) || /secret|token|credential|password|api[-_]?key/i.test(name)) return '[redacted]';
	return value;
}

export function redactPlaygroundOutboundHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		out[name] = redactPlaygroundOutboundHeaderValue(name, value);
	}
	return out;
}

export function encodePlaygroundRequestHeadersHeader(headers: Record<string, string>): string {
	return encodeURIComponent(safePlaygroundWireJson(JSON.stringify(headers)));
}

export function decodePlaygroundRequestHeadersHeader(res: Response): Record<string, string> | null {
	const raw = res.headers.get('x-playground-request-headers');
	if (raw == null || raw === '') return null;
	try {
		const parsed = JSON.parse(decodeURIComponent(raw)) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const out: Record<string, string> = {};
		for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value === 'string') out[name] = value;
		}
		return Object.keys(out).length > 0 ? out : null;
	} catch {
		return null;
	}
}
