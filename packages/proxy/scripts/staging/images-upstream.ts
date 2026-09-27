/// <reference path="./images-upstream-env.d.ts" />
/** Private synthetic upstream: no outbound fetch/model/KMS; exact armed probe rows only. */
import { createHash } from 'node:crypto';
import { parseImageProbe } from './images-probe-contract';
import { imageProbeResponse } from './images-probe';
const encoder = new TextEncoder();
export const UPSTREAM_ORIGIN = 'https://c02-images-upstream.invalid';
export const UPSTREAM_PATH = /^\/cases\/(small|limit|over|replacement)\/v1\/images\/(generations|edits)$/;
export const SYNTHETIC_PROVIDER_MARKER = 'c02-staging-synthetic-provider';
export const outputSizes = { small: 1024, limit: 32 * 1024 ** 2, over: 32 * 1024 ** 2 + 1, replacement: 32 * 1024 ** 2 } as const;
export type ImageCase = keyof typeof outputSizes;

export function responseParts() {
	return { prefix: encoder.encode('{"data":[{"b64_json":"AQID"}],"metadata":"'),
		suffix: encoder.encode('","usage":{"input_tokens":3,"output_tokens":7}}') };
}

export function syntheticResponse(mode: ImageCase, requestBytes: number, receipt?: { sha256: string; boundary?: string }): Response {
	const { prefix, suffix } = responseParts();
	let remaining = outputSizes[mode] - prefix.length - suffix.length, phase = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (phase === 0) { phase = 1; controller.enqueue(prefix); return; }
			if (remaining > 0) {
				const count = Math.min(64 * 1024, remaining); remaining -= count;
				controller.enqueue(new Uint8Array(count).fill(mode === 'replacement' ? 255 : 65)); return;
			}
			controller.enqueue(suffix); controller.close();
		},
	}, { highWaterMark: 0 });
	return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
		// Bounded synthetic receipt survives the real driver's existing request-id audit path.
		'X-Request-ID': `c02-${mode}-${requestBytes}${receipt ? `-${receipt.sha256}${receipt.boundary ? `.${receipt.boundary}` : ''}` : ''}` } });
}

export default {
	async fetch(request: Request, env?: ImagesUpstreamEnv, context?: ExecutionContext): Promise<Response> {
		const url = new URL(request.url), match = UPSTREAM_PATH.exec(url.pathname);
		if (url.origin !== UPSTREAM_ORIGIN || url.search || request.method !== 'POST' || !match) return new Response(null, { status: 404 });
		// This is a non-secret fixture marker assertion, not authentication.
		// Access is exclusively the private service capability; no public route exists.
		if (request.headers.get('Authorization') !== `Bearer ${SYNTHETIC_PROVIDER_MARKER}`) return new Response(null, { status: 422 });
		const mode = match[1] as ImageCase;
		const hash = createHash('sha256');
		// Only a <=1 KiB complete JSON body can select an armed lifecycle probe.
		const probeBytes = new Uint8Array(1024);
		let bytes = 0;
		if (request.body) for await (const chunk of request.body) {
			if (bytes + chunk.byteLength <= probeBytes.length) probeBytes.set(chunk, bytes);
			bytes += chunk.byteLength;
			if (bytes > 51 * 1024 ** 2) return new Response(null, { status: 413 });
			hash.update(chunk);
		}
		const declared = request.headers.get('Content-Length');
		if (declared === null || !/^\d+$/.test(declared) || Number(declared) !== bytes) return new Response(null, { status: 422 });
		const sha256 = hash.digest('hex');
		if (bytes <= probeBytes.length && request.headers.get('Content-Type')?.startsWith('application/json')) {
			let body: unknown;
			try { body = JSON.parse(new TextDecoder().decode(probeBytes.subarray(0, bytes))); } catch { body = null; }
			const probe = body && typeof body === 'object' && 'prompt' in body ? parseImageProbe(body.prompt) : null;
			if (probe) {
				if (!env?.PROBE_DB || !context) return new Response(null, { status: 503 });
				const response = imageProbeResponse({ probe, request, db: env.PROBE_DB, context, receipt: `c02-probe-${probe.probeId}-${sha256}` });
				// Also retain the initial D1 acknowledgement; a caller may disconnect after its commit.
				context.waitUntil(response.then(() => undefined));
				return response;
			}
		}
		// Echo only the known serializer's bounded non-secret delimiter, never arbitrary headers.
		const boundary = /^multipart\/form-data; boundary=(----cinatoken-[a-f0-9-]{36})$/.exec(request.headers.get('Content-Type') ?? '')?.[1];
		console.log(JSON.stringify({ event: 'c02.images.mock', mode, operation: match[2], requestBytes: bytes, requestSha256: sha256, responseBytes: outputSizes[mode] }));
		return syntheticResponse(mode, bytes, { sha256, boundary });
	},
} satisfies ExportedHandler<ImagesUpstreamEnv>;
