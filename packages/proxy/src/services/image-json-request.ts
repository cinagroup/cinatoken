import { MAX_REQUEST_BODY_BYTES, RequestBodyTooLargeError } from './bounded-request-body';
import { IMAGE_JSON_ADMISSION_LIMITS } from './json-structure-budget';
import { UpstreamResponseBodyTooLargeError } from './egress/bounded-response-body';
import { segmentedJsonResponseWithinLimit } from './egress/segmented-json-response';
import { JsonStringPages } from './egress/json-string-pages';
import { prepareImageNativeControls } from './image-control-limits';

/**
 * Consume the authenticated Images request directly, without Hono's retained
 * text/json body cache. Controls become native only after their published limits
 * pass. Prompt/pass-through strings and wrong-type controls stay paged until
 * their explicit semantic boundaries; overwritten values never need a full join.
 * Byte/structure admission precedes allocation; EOF precedes any dispatch.
 * Preserve Request.json UTF-8 replacement/BOM and JSON.parse value semantics.
 */
export async function readImageJsonRequest(request: Request, signal = request.signal): Promise<Record<string, unknown>> {
	try {
		const parsed = await segmentedJsonResponseWithinLimit(
			new Response(request.body), MAX_REQUEST_BODY_BYTES, IMAGE_JSON_ADMISSION_LIMITS, signal,
			{ retainStringPages: true },
		);
		if (!parsed.jsonValid || parsed.body === null || typeof parsed.body !== 'object' || Array.isArray(parsed.body) || parsed.body instanceof JsonStringPages) {
			throw new SyntaxError('Invalid JSON body');
		}
		const body = parsed.body as Record<string, unknown>;
		prepareImageNativeControls(body, signal);
		return body;
	} catch (error) {
		if (error instanceof UpstreamResponseBodyTooLargeError) throw new RequestBodyTooLargeError();
		throw error;
	}
}
