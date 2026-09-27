import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../app';
import {
	createRequestDeadline, RequestExecutionStoppedError, TEXT_REQUEST_DEADLINE_MS,
	type RequestDeadline,
} from '../services/request-deadline';
import { createRequestDispatchBudget, type RequestDispatchBudget } from '../services/request-dispatch-budget';
import { boundRequestBody, MAX_REQUEST_BODY_BYTES, RequestBodyTooLargeError } from '../services/bounded-request-body';
import { MultipartBodyError } from '../services/multipart-body-inspector';
import { JsonStructureLimitError } from '../services/json-structure-budget';
import { ImageControlLimitError } from '../services/image-control-limits';
import { buildOpenRouterErrorBody, type OpenRouterErrorSkin } from '../services/openrouter-error-protocol';
import { GATEWAY_ERROR_CODE_HEADER, GatewayErrorCode } from '../services/gateway-error-codes';
import { createResourceCompletionGroup, observeResourceCleanup } from '../services/resource-completion';
import { scheduleResourceCompletion } from '../runtime/schedule-resource-completion';

export type TextRequestLifecycle = {
	readonly deadline: RequestDeadline;
	readonly dispatchBudget: RequestDispatchBudget;
};

type TextRequestContext = Pick<Context<Env>, 'get' | 'req'>;

/** Exact synchronous text POST surfaces only; no Batch/state lookup or other modalities. */
export function isTextInferenceRequest(method: string, path: string): boolean {
	return method === 'POST'
		&& /^\/(?:api\/)?v1\/(?:chat\/completions|completions|messages|responses)\/?$/.test(path);
}

/** Same single-segment POST surface as the Gemini router, including invalid actions.
 * Keep invalid/encoded action parameters bounded until that router validates them.
 */
export function isGeminiInferenceRequest(method: string, path: string): boolean {
	return method === 'POST' && /^\/v1beta\/models\/[^/]+\/?$/.test(path);
}

/** Exact vector POST surfaces; catalog reads and similarly named paths are excluded. */
export function isVectorInferenceRequest(method: string, path: string): boolean {
	return method === 'POST' && /^\/(?:api\/)?v1\/(?:embeddings|rerank)\/?$/.test(path);
}

/** Canonical Images root and legacy generation/edit writes, never catalog or subpaths. */
export function isImageInferenceRequest(method: string, path: string): boolean {
	return method === 'POST' && /^\/(?:api\/)?v1\/images(?:\/(?:generations|edits))?\/?$/.test(path);
}

export function assertTextRequestActive(c: TextRequestContext): void {
	c.get('textRequestLifecycle')?.deadline.throwIfStopped();
}

/**
 * Only wrap reads or preparation whose every write is registered on this
 * lifecycle's deadline. Never race unregistered auth/budget/audit writes.
 */
export async function waitForTextRequestRead<Args extends unknown[], Result>(
	c: TextRequestContext, operation: (...args: Args) => Promise<Result>, ...args: Args
): Promise<Result> {
	const deadline = c.get('textRequestLifecycle')?.deadline;
	const result = await (deadline ? deadline.wait(() => operation(...args)) : operation(...args));
	deadline?.throwIfStopped();
	return result;
}

export function textRequestFailureResponse(error: unknown, c: TextRequestContext): Response | null {
	if (!(error instanceof RequestExecutionStoppedError) && !(error instanceof RequestBodyTooLargeError)
		&& !(error instanceof MultipartBodyError) && !(error instanceof JsonStructureLimitError)
		&& !(error instanceof ImageControlLimitError)) return null;
	const invalidInput = (error instanceof MultipartBodyError && error.status === 400) || error instanceof ImageControlLimitError;
	const tooLarge = error instanceof RequestBodyTooLargeError || error instanceof JsonStructureLimitError
		|| (error instanceof MultipartBodyError && error.status === 413);
	const cancelled = error instanceof RequestExecutionStoppedError && error.reason === 'client_cancelled';
	const status = invalidInput ? 400 : tooLarge ? 413 : cancelled ? 499 : 504;
	const code = tooLarge ? GatewayErrorCode.payloadTooLarge
		: invalidInput ? GatewayErrorCode.invalidRequest
		: cancelled ? GatewayErrorCode.requestCancelled : GatewayErrorCode.requestDeadlineExceeded;
	const skin: OpenRouterErrorSkin = /\/messages\/?$/.test(c.req.path) ? 'anthropic'
		: /\/responses\/?$/.test(c.req.path) ? 'responses' : 'chat';
	return new Response(JSON.stringify(buildOpenRouterErrorBody({
		skin, status, legacyCode: code, message: error.message,
		errorType: invalidInput ? 'invalid_request' : tooLarge ? 'payload_too_large' : cancelled ? 'provider_unavailable' : 'timeout',
		requestId: c.get('generationId'),
	})), { status, headers: {
		'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store',
		[GATEWAY_ERROR_CODE_HEADER]: code,
	} });
}

export const textRequestLifecycle: MiddlewareHandler<Env> = async (c, next) => {
	// Keep existing context/helper names. All allowlisted inference families,
	// including multipart Images, share one ingress owner and dispatch budget.
	if (!isTextInferenceRequest(c.req.method, c.req.path)
		&& !isGeminiInferenceRequest(c.req.method, c.req.path)
		&& !isVectorInferenceRequest(c.req.method, c.req.path)
		&& !isImageInferenceRequest(c.req.method, c.req.path)) return next();
	const dispatchBudget = createRequestDispatchBudget();
	const resources = createResourceCompletionGroup();
	// One host hold for all preparation reads, not one waitUntil per upload page.
	scheduleResourceCompletion(c, resources.completion);
	const deadline = createRequestDeadline(dispatchBudget.createdAtMs + TEXT_REQUEST_DEADLINE_MS, c.req.raw.signal,
		undefined, completion => resources.track(observeResourceCleanup(() => completion)));
	c.set('textRequestLifecycle', { deadline, dispatchBudget });
	let upload: ReturnType<typeof boundRequestBody> | undefined;
	try {
		if (c.req.raw.body) {
			// Images JSON and multipart structure scans live in their authenticated
			// parsers, consuming pages directly without framework whole-body caches.
			upload = boundRequestBody(c.req.raw.body, deadline, MAX_REQUEST_BODY_BYTES);
			// Node needs duplex for streamed uploads; Workers accepts the extra field.
			// Preserve the ORIGINAL client signal: dispatch owns its own timer/body
			// after this preparation middleware disposes at response handoff.
			const init = { body: upload.body, duplex: 'half' };
			c.req.raw = new Request(c.req.raw, init);
			deadline.throwIfStopped();
			const declaredLength = c.req.header('content-length');
			if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_REQUEST_BODY_BYTES) {
				throw new RequestBodyTooLargeError();
			}
		}
		deadline.throwIfStopped();
		// Do not race the middleware chain: it contains durable writes. Explicit
		// read boundaries use waitForTextRequestRead; writes keep their owner.
		await next();
	} finally {
		upload?.dispose();
		// A cancelled planner may contain an already-started legacy-key upgrade.
		// Keep request ownership until it settles; DB-side timeouts are separate.
		try { await deadline.drainOwnedMutations(); }
		finally { deadline.dispose(); resources.seal(); }
	}
};
