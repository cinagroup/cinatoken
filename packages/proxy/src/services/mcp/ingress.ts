import { createRequestDeadline } from '../request-deadline';
import type { ResourceCompletion } from '../resource-completion';
import { ownUpstreamResponse } from '../egress/owned-upstream-response';
import { responseTextWithinLimit, UpstreamResponseBodyTooLargeError } from '../egress/bounded-response-body';

export const MAX_MCP_BODY_BYTES = 1024 * 1024;
export const MCP_BODY_TIMEOUT_MS = 30_000;
export class McpIngressError extends Error {
	constructor(
		public readonly status: 400 | 408 | 413 | 499,
		message: string,
	) {
		super(message);
	}
}
const bodies = new WeakMap<Request, Promise<unknown>>();
/** Auth and SDK share one bounded parse; never tee an untrusted ingress stream. */
export function readMcpIngress(request: Request, register?: (task: ResourceCompletion) => void): Promise<unknown> {
	const cached = bodies.get(request);
	if (cached) return cached;
	const read = (async () => {
		const deadline = createRequestDeadline(Date.now() + MCP_BODY_TIMEOUT_MS, request.signal);
		const owned = ownUpstreamResponse(new Response(request.body), deadline.signal);
		register?.(owned.resourceCompletion);
		try {
			const text = await responseTextWithinLimit(owned.response, MAX_MCP_BODY_BYTES, deadline.signal);
			try {
				return JSON.parse(text) as unknown;
			} catch {
				throw new McpIngressError(400, 'Invalid MCP JSON body');
			}
		} catch (error) {
			if (request.signal.aborted) throw new McpIngressError(499, 'MCP request cancelled');
			if (deadline.signal.aborted) throw new McpIngressError(408, 'MCP request body timed out');
			if (error instanceof UpstreamResponseBodyTooLargeError)
				throw new McpIngressError(413, 'MCP request body exceeds 1 MiB');
			throw error;
		} finally {
			deadline.dispose();
		}
	})();
	bodies.set(request, read);
	return read;
}

export function mcpIngressErrorResponse(error: unknown): Response {
	const status = error instanceof McpIngressError ? error.status : 400;
	const message = error instanceof McpIngressError ? error.message : 'Invalid MCP JSON body';
	return Response.json(
		{ jsonrpc: '2.0', id: null, error: { code: -32700, message } },
		{ status, headers: { 'Cache-Control': 'no-store' } },
	);
}
