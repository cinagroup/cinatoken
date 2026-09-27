import { GatewayErrorCode } from './gateway-error-codes';
import { gatewayErrorResponse } from './gateway-error-response';
import { sanitizePublicErrorMessage } from './openrouter-error-protocol';
import { MAX_MATERIALIZED_ERROR_BODY_BYTES } from './request-log-record-status';

export function unknownImageOutcomeMetadata(requestId: string) {
	return { request_id: sanitizePublicErrorMessage(requestId, ''), outcome_unknown: true, retry_safe: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Images only: decorate an already bounded, sanitized materializeNonOkResponse
 * result. Never pass raw provider JSON here. Do not read/clone a response stream
 * or infer retry safety from HTTP status or from budget/charge disposition.
 */
export async function unknownImageOutcomeResponse(
	response: Response,
	publicErrorBodyText: string | null,
	requestId: string,
): Promise<Response> {
	const metadata = unknownImageOutcomeMetadata(requestId);
	let body: unknown;
	if (publicErrorBodyText !== null && publicErrorBodyText.length <= MAX_MATERIALIZED_ERROR_BODY_BYTES) {
		try { body = JSON.parse(publicErrorBodyText); } catch { /* Safe fallback below. */ }
	}
	await response.body?.cancel('image_unknown_outcome_metadata').catch(() => undefined);
	if (!isRecord(body) || !isRecord(body.error)) {
		return gatewayErrorResponse({ status: 502, code: GatewayErrorCode.upstreamRequestFailed,
			message: 'Upstream provider is unavailable', metadata });
	}
	const headers = new Headers(response.headers);
	headers.set('Content-Type', 'application/json; charset=UTF-8');
	headers.set('Cache-Control', 'no-store');
	for (const name of ['Content-Length', 'Content-Encoding', 'Transfer-Encoding', 'ETag', 'Content-MD5', 'Digest', 'Retry-After']) headers.delete(name);
	return new Response(JSON.stringify({ ...body, error: { ...body.error,
		metadata: { ...(isRecord(body.error.metadata) ? body.error.metadata : {}), ...metadata },
	} }), { status: response.status, headers });
}
