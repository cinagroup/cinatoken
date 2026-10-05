/// <reference path="./chat-holder-private-v364-env.d.ts" />
import {
	SYNTHETIC_CREDENTIAL_V364,
	SYNTHETIC_PROVIDER_URL_V364,
	SYNTHETIC_QUOTE_V364,
	SYNTHETIC_ROUTE_V364,
} from './chat-holder-synthetic-v364';

const URL_ORIGIN = 'https://holder.service.invalid';
const URL_PATH = '/complete-text-attempt';
const MAX_FINAL_BODY_BYTES = 1_048_576;
// JSON may escape each one-byte control character as six ASCII bytes.
const MAX_ENVELOPE_BYTES = 6 * MAX_FINAL_BODY_BYTES + 8_192;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const FIELDS = ['requestId', 'quoteId', 'attemptNonce', 'candidateIndex', 'routeTargetId', 'finalBodyUtf8'];
const encoder = new TextEncoder();

function reject(status = 400): Response {
	return Response.json({ error: 'holder_request_rejected' }, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function readEnvelope(request: Request): Promise<Uint8Array | null> {
	const declared = request.headers.get('Content-Length');
	if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_ENVELOPE_BYTES)) return null;
	if (!request.body) return null;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_ENVELOPE_BYTES) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
	return result;
}

async function validEnvelope(input: unknown): Promise<boolean> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
	const value = input as Record<string, unknown>;
	if (Object.keys(value).length !== FIELDS.length || FIELDS.some(field => !Object.hasOwn(value, field))) return false;
	if (value.requestId !== SYNTHETIC_QUOTE_V364.requestId
		|| value.quoteId !== SYNTHETIC_QUOTE_V364.quoteId
		|| typeof value.attemptNonce !== 'string' || !UUID.test(value.attemptNonce)
		|| value.candidateIndex !== SYNTHETIC_ROUTE_V364.candidateIndex
		|| value.routeTargetId !== SYNTHETIC_ROUTE_V364.targetId
		|| SYNTHETIC_ROUTE_V364.modelId !== SYNTHETIC_QUOTE_V364.modelIds[SYNTHETIC_ROUTE_V364.candidateIndex]
		|| SYNTHETIC_QUOTE_V364.credentialClass !== 'platform'
		|| Date.parse(SYNTHETIC_QUOTE_V364.expiresAt) <= Date.now()
		|| typeof value.finalBodyUtf8 !== 'string') return false;
	const body = encoder.encode(value.finalBodyUtf8);
	if (body.byteLength < 2 || body.byteLength > MAX_FINAL_BODY_BYTES) return false;
	const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)))
		.map(byte => byte.toString(16).padStart(2, '0')).join('');
	return digest === SYNTHETIC_QUOTE_V364.finalBodySha256;
}

function syntheticStream(env: ChatHolderPrivateV364Env, attemptNonce: string, ctx?: Pick<ExecutionContext, 'waitUntil'>): Response {
	let phase = 0;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(': holder-ready\n\n'));
		},
		async pull(controller) {
			if (phase !== 0) return;
			phase = 1;
			for (let n = 0; n < 300; n++) {
				if (await env.OBSERVATIONS.get(`release:${attemptNonce}`) === 'yes') {
					controller.enqueue(encoder.encode('data: {"text":"synthetic streamed answer"}\n\ndata: [DONE]\n\n'));
					controller.close();
					return;
				}
				await new Promise<void>(resolve => setTimeout(resolve, 10));
			}
			controller.error(new Error('synthetic stream release timed out'));
		},
		async cancel() {
			const observation = env.OBSERVATIONS.put(`cancel:${attemptNonce}`, 'observed');
			// The client has disconnected; retain this asynchronous test observation
			// in the holder request lifetime instead of losing it with the response.
			ctx?.waitUntil(observation);
			await observation;
		},
	}, { highWaterMark: 0 });
	return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
}

export default {
	async fetch(request: Request, env: ChatHolderPrivateV364Env, ctx?: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.origin !== URL_ORIGIN || url.pathname !== URL_PATH || url.search || request.method !== 'POST') return reject(404);
		if (request.headers.get('Content-Type') !== 'application/json') return reject(415);
		const bytes = await readEnvelope(request);
		if (bytes === null) return reject(413);
		let value: unknown;
		try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown; }
		catch { return reject(); }
		if (!await validEnvelope(value)) return reject();
		const envelope = value as Record<string, unknown>;
		// The test credential and URL exist only in this holder bundle. No provider
		// request is made; the two values are intentionally never serialized.
		if (!SYNTHETIC_CREDENTIAL_V364.startsWith('synthetic-private-')
			|| new URL(SYNTHETIC_PROVIDER_URL_V364).hostname !== 'synthetic-private-provider.invalid') return reject(503);
		await env.OBSERVATIONS.put(`accepted:${envelope.attemptNonce as string}`, 'one');
		return syntheticStream(env, envelope.attemptNonce as string, ctx);
	},
} satisfies ExportedHandler<ChatHolderPrivateV364Env>;
