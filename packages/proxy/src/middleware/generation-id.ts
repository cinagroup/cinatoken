/**
 * Assign one durable generation identifier to a public inference request.
 *
 * The identifier is reused as the request-log primary key by route handlers and
 * surfaced in `X-Generation-Id`. Rebuilding the response keeps an upstream or
 * generated body streaming; this middleware never buffers it.
 */
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../app';

export const GENERATION_ID_HEADER = 'X-Generation-Id';

export function createGenerationId(): string {
	return `gen-${crypto.randomUUID()}`;
}

export const assignGenerationId: MiddlewareHandler<Env> = async (c, next) => {
	const generationId = createGenerationId();
	c.set('generationId', generationId);
	await next();

	const response = c.res;
	const headers = new Headers(response.headers);
	headers.set(GENERATION_ID_HEADER, generationId);
	c.res = new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
};
