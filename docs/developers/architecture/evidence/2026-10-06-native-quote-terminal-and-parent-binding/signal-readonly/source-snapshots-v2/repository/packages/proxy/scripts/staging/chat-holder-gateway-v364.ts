/// <reference path="./chat-holder-gateway-v364-env.d.ts" />

/** Fixture gateway: only the six-field JSON envelope crosses this binding. */
export default {
	async fetch(request: Request, env: ChatHolderGatewayV364Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== '/fixture/complete-text' || request.method !== 'POST') return new Response(null, { status: 404 });
		if (request.headers.get('Content-Type') !== 'application/json') return new Response(null, { status: 415 });
		const holderInit = {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: request.body,
			signal: request.signal,
			duplex: 'half',
		} as RequestInit;
		const holderRequest = new Request('https://holder.service.invalid/complete-text-attempt', holderInit);
		const response = await env.TEXT_HOLDER.fetch(holderRequest);
		if (response.status === 400 || response.status === 413 || response.status === 415 || response.status === 404) {
			await response.body?.cancel();
			return Response.json({ error: 'holder_request_rejected' }, { status: response.status });
		}
		if (response.status !== 200 || response.headers.get('Content-Type') !== 'text/event-stream' || !response.body) {
			await response.body?.cancel();
			return Response.json({ error: 'holder_unavailable' }, { status: 502 });
		}
		return new Response(response.body, {
			status: 200,
			headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
		});
	},
} satisfies ExportedHandler<ChatHolderGatewayV364Env>;
