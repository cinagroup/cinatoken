// Local-only workerd fixture; never imported by the application entrypoint.
import {
	resolveProviderUpstreamSecret, clearGcpServiceAccountTokenCache, GcpTokenExchangeError,
	GCP_OAUTH_MAX_RESPONSE_BYTES, GCP_OAUTH_TOKEN_URL,
} from '../../../../../core/src/gcp-service-account-token';

export default {
	async fetch(request: Request): Promise<Response> {
		clearGcpServiceAccountTokenCache();
		const raw = request.headers.get('X-Synthetic-Account');
		if (!raw) return new Response('Missing synthetic fixture', { status: 400 });
		const mode = new URL(request.url).pathname.slice(1);
		const controller = new AbortController();
		let calls = 0;
		let cancelled = 0;
		let observedSignal: AbortSignal | null | undefined;
		let stream: ReadableStream<Uint8Array> | undefined;
		try {
			const result = await resolveProviderUpstreamSecret(raw, {
				signal: controller.signal,
				timeoutMs: mode === 'timeout' ? 1000 : 2000,
				fetchImpl: async (url, init) => {
					if (String(url) !== GCP_OAUTH_TOKEN_URL) throw new Error('Unexpected fixture URL');
					calls++;
					observedSignal = init?.signal;
					if (mode === 'cancel') {
						controller.abort('synthetic private abort reason');
						return new Promise<Response>(() => {});
					}
					if (mode === 'timeout' || mode === 'overflow') {
						stream = new ReadableStream<Uint8Array>({
							pull(c) {
								if (mode === 'overflow') c.enqueue(new Uint8Array(GCP_OAUTH_MAX_RESPONSE_BYTES + 1));
							},
							cancel() { cancelled++; },
						}, { highWaterMark: 0 });
						return new Response(stream);
					}
					// Keep a second real Worker invocation alive while its peer cancels.
					await new Promise<void>(resolve => setTimeout(resolve, 5));
					return Response.json({ access_token: 'synthetic-worker-token', expires_in: 3600 });
				},
			});
			return Response.json({ outcome: 'success', tokenMatches: result.secret === 'synthetic-worker-token', calls, aborted: observedSignal?.aborted });
		} catch (error) {
			return Response.json({ outcome: error instanceof GcpTokenExchangeError ? error.code : 'unexpected',
				calls, cancelled, locked: stream?.locked, aborted: observedSignal?.aborted });
		}
	},
};
