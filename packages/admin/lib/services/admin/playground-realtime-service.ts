import { resolveProviderUpstreamSecret } from '@octafuse/core';

import { isValidElevenLabsVoiceId } from '@octafuse/core/elevenlabs-native';

import { isAudioKind } from '@/lib/invoke-kind';
/**
 * 调试台的 DashScope 原生 WebSocket 直连：使用管理员会话解析路由，
 * 供应商连接和事件转发都在 Worker 侧完成，因此不会把供应商 API Key 暴露给浏览器，也不写网关用量日志。
 */
import { applyRouteExtraHeaders } from '@octafuse/core/route-custom-params';
import { resolveUpstreamEndpoint } from '@octafuse/core/provider-endpoints';
import {
	mergePlaygroundRequestBody,
	type PlaygroundResolvedRoute,
	resolvePlaygroundRoute,
} from './playground-service';
import {
	createRequestDeadline,
	RequestExecutionStoppedError,
	type GatewayRepositories,
} from '@octafuse/core';
import { AdminServiceError } from './errors';
import {
	discardPlaygroundResponse,
	playgroundStoppedError,
	PLAYGROUND_REQUEST_DEADLINE_MS,
} from './playground-request-lifecycle';
import { safePlaygroundUrl } from '@/lib/playground/private-preview';
import { copyPlaygroundUpstreamHeaders } from '@/lib/playground/proxy-response-headers';

export const PLAYGROUND_DASHSCOPE_REALTIME_OPERATIONS = [
	'audio.transcriptions.realtime.inference',
	'audio.transcriptions.realtime.session',
	'audio.speech.realtime.inference',
	'audio.speech.realtime.session',
] as const;

export type PlaygroundDashScopeRealtimeOperation = (typeof PLAYGROUND_DASHSCOPE_REALTIME_OPERATIONS)[number];

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
	return value != null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function eventName(event: JsonObject): string {
	const header = asObject(event.header);
	if (typeof header?.action === 'string') return header.action;
	if (typeof header?.event === 'string') return header.event;
	return typeof event.type === 'string' ? event.type : '';
}

/** 与 Proxy 保持同一模型注入和 custom_params 合并规则。 */
export function rewritePlaygroundRealtimeMessage(
	route: PlaygroundResolvedRoute,
	operation: PlaygroundRealtimeOperation,
	message: string,
): string {
	const elevenLabs = isPlaygroundElevenLabsRealtimeOperation(operation);
	let event: JsonObject;
	try {
		const parsed = JSON.parse(message) as unknown;
		const object = asObject(parsed);
		if (!object) {
			if (elevenLabs) throw new Error('Invalid realtime JSON object');
			return message;
		}
		event = object;
	} catch {
		if (elevenLabs) throw new Error('Invalid realtime JSON object');
		return message;
	}
	if (elevenLabs) {
		for (const key of Object.keys(event)) {
			if (ELEVENLABS_STRIPPED_QUERY_KEYS.has(key.toLowerCase())) delete event[key];
		}
		return JSON.stringify(event);
	}
	const name = eventName(event);
	const shouldMerge =
		(operation.endsWith('.inference') && name === 'run-task') ||
		(operation.endsWith('.session') && name === 'session.update');
	if (!shouldMerge) return message;

	const merged = mergePlaygroundRequestBody(route, event);
	if (name === 'run-task') {
		const payload = asObject(merged.payload) ?? {};
		merged.payload = { ...payload, model: route.providerModelName };
	}
	return JSON.stringify(merged);
}

export const rewritePlaygroundRealtimeClientMessage = rewritePlaygroundRealtimeMessage;

function outboundWebSocketFetchUrl(endpoint: string): URL {
	const url = new URL(endpoint);
	if (url.protocol === 'wss:') url.protocol = 'https:';
	if (url.protocol === 'ws:') url.protocol = 'http:';
	return url;
}

function realtimeCapability(
	operation: PlaygroundDashScopeRealtimeOperation,
): 'audio.realtime.inference' | 'audio.realtime.session' {
	return operation.endsWith('.inference') ? 'audio.realtime.inference' : 'audio.realtime.session';
}

function closeSocket(socket: WebSocket, code = 1000, reason = ''): void {
	if (socket.readyState === WebSocket.CLOSED) return;
	const valid =
		[1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].includes(code) ||
		(code >= 3000 && code <= 4999);
	try {
		socket.close(
			valid ? code : 1000,
			new TextDecoder().decode(new TextEncoder().encode(reason).slice(0, 120)),
		);
	} catch {
		/* Transport may already be closing. */
	}
}

function isRealtimeOperation(value: string): value is PlaygroundDashScopeRealtimeOperation {
	return (PLAYGROUND_DASHSCOPE_REALTIME_OPERATIONS as readonly string[]).includes(value);
}

export function preparePlaygroundRealtimeRequest(
	route: PlaygroundResolvedRoute,
	operation: PlaygroundDashScopeRealtimeOperation,
): URL {
	if (
		route.upstreamProtocol !== 'dashscope' ||
		!isAudioKind(route.modelKind ?? (route.isAudioModel ? 'asr' : 'llm'))
	)
		throw new AdminServiceError(400, 'Playground realtime routes must use an audio DashScope route');
	if (route.upstreamOperation !== operation)
		throw new AdminServiceError(400, 'Realtime operation must match the selected route');
	const endpoint = resolveUpstreamEndpoint(
		'dashscope',
		realtimeCapability(operation),
		route.providerEndpoints,
		{
			providerId: route.providerId,
		},
	);
	const url = outboundWebSocketFetchUrl(endpoint);
	if (operation.endsWith('.session')) url.searchParams.set('model', route.providerModelName);
	return url;
}

export type PlaygroundRealtimeDispatchResult = {
	response: Response;
	upstreamUrl: string;
};

export type PlaygroundRealtimeNodeDispatch = (
	route: PlaygroundResolvedRoute,
	operation: PlaygroundRealtimeOperation,
	requestSignal: AbortSignal | undefined,
	upstreamUrl: string,
) => Promise<Response>;

export type PlaygroundRealtimeDispatchOptions = {
	nodeDispatch?: PlaygroundRealtimeNodeDispatch;
	/** Shared absolute ceiling while resolving and connecting a saved route. */
	deadlineAtMs?: number;
};

function withSessionModel(
	endpoint: string,
	operation: PlaygroundDashScopeRealtimeOperation,
	model: string,
): string {
	const url = new URL(endpoint);
	if (operation.endsWith('.session')) url.searchParams.set('model', model);
	return url.toString();
}

/** 在已解析路由上建立调试台专用的非计费原生 WebSocket（Workers 或 Node dispatch）。 */
export async function connectPlaygroundDashScopeRealtime(
	route: PlaygroundResolvedRoute,
	operation: PlaygroundDashScopeRealtimeOperation,
	requestSignal?: AbortSignal,
	options?: PlaygroundRealtimeDispatchOptions,
): Promise<PlaygroundRealtimeDispatchResult> {
	const url = preparePlaygroundRealtimeRequest(route, operation);
	const endpoint = resolveUpstreamEndpoint(
		'dashscope',
		realtimeCapability(operation),
		route.providerEndpoints,
		{
			providerId: route.providerId,
		},
	);
	return connectOwnedPlaygroundRealtime(
		route,
		operation,
		{
			fetchUrl: url.toString(),
			nodeUrl: withSessionModel(endpoint, operation, route.providerModelName),
			reportedUrl: endpoint,
		},
		requestSignal,
		options,
	);
}

/** One owner covers secret resolution, handshake, rejection body and socket lifetime. */
async function connectOwnedPlaygroundRealtime(
	route: PlaygroundResolvedRoute,
	operation: PlaygroundRealtimeOperation,
	target: { fetchUrl: string; nodeUrl: string; reportedUrl: string },
	requestSignal?: AbortSignal,
	options?: PlaygroundRealtimeDispatchOptions,
): Promise<PlaygroundRealtimeDispatchResult> {
	const owner = createRequestDeadline(
		Math.min(options?.deadlineAtMs ?? Infinity, Date.now() + PLAYGROUND_REQUEST_DEADLINE_MS),
		requestSignal,
	);
	let streaming = false;
	let handedOff = false;
	const openingSockets: WebSocket[] = [];
	let socketAbortCleanup = () => {};
	try {
		owner.throwIfStopped();
		const url = outboundWebSocketFetchUrl(target.fetchUrl);
		if (options?.nodeDispatch) {
			const response = await owner.wait(
				() => options.nodeDispatch!(route, operation, owner.signal, target.nodeUrl),
				discardPlaygroundResponse,
			);
			return { response, upstreamUrl: safePlaygroundUrl(target.reportedUrl, [route.providerApiKey]) };
		}
		if (typeof WebSocketPair === 'undefined') {
			throw new AdminServiceError(501, 'Playground realtime requires the Cloudflare Workers runtime');
		}

		const { secret } = await owner.wait(() =>
			resolveProviderUpstreamSecret(route.providerApiKey, { signal: owner.signal }),
		);
		const upstreamResponse = await owner.wait(
			() =>
				fetch(url.toString(), {
					headers: applyRouteExtraHeaders(
						{
							...(route.upstreamProtocol === 'elevenlabs'
								? { 'xi-api-key': secret }
								: { Authorization: `Bearer ${secret}` }),
							Upgrade: 'websocket',
						},
						route.customParams,
					),
					signal: owner.signal,
					// A 307/308 must not send a second authenticated upgrade outside this dispatch.
					redirect: 'manual',
				}),
			(response) => {
				discardPlaygroundResponse(response);
				if (response.webSocket) closeSocket(response.webSocket, 1000, 'Playground upgrade cancelled');
			},
		);
		if (upstreamResponse.webSocket) openingSockets.push(upstreamResponse.webSocket);
		owner.throwIfStopped();
		const upstreamUrl = safePlaygroundUrl(target.reportedUrl, [route.providerApiKey, secret]);
		if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
			void upstreamResponse.body?.cancel('playground_realtime_redirect_rejected').catch(() => undefined);
			return {
				response: new Response(
					JSON.stringify({
						error: { message: 'Realtime upstream redirected the upgrade' },
					}),
					{
						status: 502,
						headers: {
							'Content-Type': 'application/json',
							'Cache-Control': 'no-store',
						},
					},
				),
				upstreamUrl,
			};
		}
		const upstream = upstreamResponse.webSocket;
		if (upstreamResponse.status === 101 && !upstream) {
			discardPlaygroundResponse(upstreamResponse);
			throw new AdminServiceError(502, 'Realtime upstream did not provide a WebSocket');
		}
		if (upstreamResponse.status !== 101 || !upstream) {
			streaming = true;
			return {
				response: owner.wrapResponse(
					new Response(upstreamResponse.body, {
						status: upstreamResponse.status,
						statusText: upstreamResponse.statusText,
						headers: copyPlaygroundUpstreamHeaders(upstreamResponse.headers, [route.providerApiKey, secret]),
					}),
				),
				upstreamUrl,
			};
		}

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		openingSockets.push(client, server);
		server.accept({ allowHalfOpen: true });
		upstream.binaryType = 'arraybuffer';
		upstream.accept({ allowHalfOpen: true });
		const clientSignal = owner.signal;
		const cleanup = () => {
			clientSignal?.removeEventListener('abort', onAbort);
			owner.dispose();
		};
		socketAbortCleanup = cleanup;
		const onAbort = () => {
			cleanup();
			closeSocket(server, 1000, 'Playground client cancelled');
			closeSocket(upstream, 1000, 'Playground client cancelled');
		};
		clientSignal.addEventListener('abort', onAbort, { once: true });
		if (clientSignal.aborted) onAbort();

		let clientBytes = 0;
		let upstreamBytes = 0;
		const frameBytes = (data: string | ArrayBuffer | ArrayBufferView): number =>
			typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
		server.addEventListener('message', (event) => {
			try {
				const bytes = frameBytes(event.data);
				clientBytes += bytes;
				if (
					bytes > 1024 * 1024 ||
					clientBytes > 32 * 1024 * 1024 ||
					(route.upstreamProtocol === 'elevenlabs' && typeof event.data !== 'string')
				)
					throw new Error('Realtime client frame limit exceeded');
				const data =
					typeof event.data === 'string'
						? rewritePlaygroundRealtimeMessage(route, operation, event.data)
						: event.data;
				upstream.send(data);
			} catch {
				cleanup();
				closeSocket(server, 1011, 'Gateway upstream send failed');
				closeSocket(upstream, 1011, 'Gateway upstream send failed');
			}
		});
		upstream.addEventListener('message', (event) => {
			try {
				const bytes = frameBytes(event.data);
				upstreamBytes += bytes;
				if (bytes > 4 * 1024 * 1024 || upstreamBytes > 32 * 1024 * 1024)
					throw new Error('Realtime upstream frame limit exceeded');
				server.send(event.data);
			} catch {
				cleanup();
				closeSocket(server, 1011, 'Gateway client send failed');
				closeSocket(upstream, 1011, 'Gateway client send failed');
			}
		});
		server.addEventListener('close', (event) => {
			cleanup();
			closeSocket(upstream, event.code, event.reason);
			// allowHalfOpen 下必须显式完成本端 Close 握手，避免调试台连接悬挂。
			closeSocket(server, event.code, event.reason);
		});
		upstream.addEventListener('close', (event) => {
			cleanup();
			closeSocket(server, event.code, event.reason);
		});
		server.addEventListener('error', () => {
			cleanup();
			closeSocket(server, 1011, 'Client WebSocket error');
			closeSocket(upstream, 1011, 'Client WebSocket error');
		});
		upstream.addEventListener('error', () => {
			cleanup();
			closeSocket(upstream, 1011, 'Upstream WebSocket error');
			closeSocket(server, 1011, 'Upstream WebSocket error');
		});

		owner.throwIfStopped();
		const response = new Response(null, {
			status: 101,
			webSocket: client,
			headers: {
				'X-Octafuse-Realtime-Protocol': `${route.upstreamProtocol}-playground`,
				'Cache-Control': 'private, no-store',
			},
		});
		handedOff = true;
		return {
			response,
			upstreamUrl,
		};
	} catch (error) {
		if (error instanceof RequestExecutionStoppedError) throw playgroundStoppedError(error);
		if (error instanceof AdminServiceError) throw error;
		throw new AdminServiceError(
			502,
			error instanceof Error && /^Upstream WebSocket handshake timed out after \d+ms$/.test(error.message)
				? error.message
				: 'Playground realtime upstream request failed',
		);
	} finally {
		if (!handedOff) {
			socketAbortCleanup();
			for (const socket of openingSockets) closeSocket(socket, 1000, 'Playground setup stopped');
		}
		await owner.drainOwnedMutations();
		if (!streaming && !handedOff) owner.dispose();
	}
}

/** 解析路由并建立调试台专用的非计费原生 WebSocket。 */
export async function dispatchPlaygroundDashScopeRealtime(
	repos: GatewayRepositories,
	input: { routeId: string; operation: string },
	requestSignal?: AbortSignal,
	options?: PlaygroundRealtimeDispatchOptions,
): Promise<PlaygroundRealtimeDispatchResult> {
	if (!isRealtimeOperation(input.operation)) {
		throw new AdminServiceError(400, `Unsupported realtime operation: ${input.operation || '(empty)'}`);
	}
	if (requestSignal?.aborted) throw new AdminServiceError(499, 'Playground request was cancelled');
	if (!options?.nodeDispatch && typeof WebSocketPair === 'undefined')
		throw new AdminServiceError(501, 'DashScope realtime requires the Cloudflare Workers runtime');
	const owner = createRequestDeadline(
		Math.min(options?.deadlineAtMs ?? Infinity, Date.now() + PLAYGROUND_REQUEST_DEADLINE_MS),
		requestSignal,
	);
	try {
		const route = await resolvePlaygroundRoute(repos, input.routeId, owner);
		const result = await connectPlaygroundDashScopeRealtime(route, input.operation, requestSignal, {
			...options,
			deadlineAtMs: owner.deadlineAtMs,
		});
		return result;
	} finally {
		await owner.drainOwnedMutations();
		owner.dispose();
	}
}

export const PLAYGROUND_ELEVENLABS_REALTIME_OPERATIONS = [
	'audio.transcriptions.realtime',
	'audio.speech.realtime',
] as const;

export type PlaygroundElevenLabsRealtimeOperation =
	(typeof PLAYGROUND_ELEVENLABS_REALTIME_OPERATIONS)[number];

/** 调试台 `GET /playground/realtime` 接受的全部 operation。 */
export const PLAYGROUND_REALTIME_OPERATIONS = [
	...PLAYGROUND_DASHSCOPE_REALTIME_OPERATIONS,
	...PLAYGROUND_ELEVENLABS_REALTIME_OPERATIONS,
] as const;

export type PlaygroundRealtimeOperation = (typeof PLAYGROUND_REALTIME_OPERATIONS)[number];

export function isPlaygroundElevenLabsRealtimeOperation(
	value: string,
): value is PlaygroundElevenLabsRealtimeOperation {
	return (PLAYGROUND_ELEVENLABS_REALTIME_OPERATIONS as readonly string[]).includes(value);
}

export type PlaygroundElevenLabsRealtimeParams = {
	/** TTS 路径参数；转写不需要。 */
	voiceId?: string;
	/** 浏览器传来的 query（output_format、audio_format、commit_strategy 等）。 */
	query?: Record<string, string>;
};

/** 携带客户端凭据或由路由决定的 query，不转给上游。 */
const ELEVENLABS_STRIPPED_QUERY_KEYS = new Set([
	'model_id',
	'routeid',
	'operation',
	'voiceid',
	'xi-api-key',
	'xi_api_key',
	'api_key',
	'apikey',
	'access_token',
	'authorization',
	'token',
]);

/** 在已解析的 ElevenLabs 路由上建立调试台专用的非计费 WebSocket（Workers 或 Node dispatch）。 */
export async function connectPlaygroundElevenLabsRealtime(
	route: PlaygroundResolvedRoute,
	operation: PlaygroundElevenLabsRealtimeOperation,
	params: PlaygroundElevenLabsRealtimeParams = {},
	requestSignal?: AbortSignal,
	options?: PlaygroundRealtimeDispatchOptions,
): Promise<PlaygroundRealtimeDispatchResult> {
	if (
		route.upstreamProtocol !== 'elevenlabs' ||
		!isAudioKind(route.modelKind ?? (route.isAudioModel ? 'asr' : 'llm'))
	) {
		throw new AdminServiceError(400, 'Playground realtime routes must use an audio ElevenLabs route');
	}
	if (route.upstreamOperation !== operation) {
		throw new AdminServiceError(
			400,
			`Route upstream operation ${JSON.stringify(route.upstreamOperation)} does not match ${operation}`,
		);
	}
	const isSpeech = operation === 'audio.speech.realtime';
	const voiceId = params.voiceId?.trim() ?? '';
	if (isSpeech && !isValidElevenLabsVoiceId(voiceId)) {
		throw new AdminServiceError(400, 'voice_id is required for ElevenLabs realtime speech');
	}
	const endpoint = resolveUpstreamEndpoint('elevenlabs', operation, route.providerEndpoints, {
		providerId: route.providerId,
		...(isSpeech ? { voiceId } : {}),
	});
	const url = new URL(endpoint);
	for (const [key, value] of Object.entries(params.query ?? {})) {
		if (ELEVENLABS_STRIPPED_QUERY_KEYS.has(key.toLowerCase())) continue;
		url.searchParams.set(key, value);
	}
	url.searchParams.set('model_id', route.providerModelName);
	return connectOwnedPlaygroundRealtime(
		route,
		operation,
		{
			fetchUrl: url.toString(),
			nodeUrl: url.toString(),
			reportedUrl: endpoint,
		},
		requestSignal,
		options,
	);
}

/** 解析路由并建立调试台专用的非计费原生 WebSocket（DashScope / ElevenLabs）。 */
export async function dispatchPlaygroundRealtime(
	repos: GatewayRepositories,
	input: {
		routeId: string;
		operation: string;
		/** 仅 ElevenLabs：TTS 路径参数与 query。 */
		elevenLabs?: PlaygroundElevenLabsRealtimeParams;
	},
	requestSignal?: AbortSignal,
	options?: PlaygroundRealtimeDispatchOptions,
): Promise<PlaygroundRealtimeDispatchResult> {
	if (!(PLAYGROUND_REALTIME_OPERATIONS as readonly string[]).includes(input.operation)) {
		throw new AdminServiceError(400, `Unsupported realtime operation: ${input.operation || '(empty)'}`);
	}
	if (requestSignal?.aborted) throw new AdminServiceError(499, 'Playground request was cancelled');
	if (!options?.nodeDispatch && typeof WebSocketPair === 'undefined')
		throw new AdminServiceError(501, 'Playground realtime requires a WebSocket runtime');
	const owner = createRequestDeadline(
		Math.min(options?.deadlineAtMs ?? Infinity, Date.now() + PLAYGROUND_REQUEST_DEADLINE_MS),
		requestSignal,
	);
	try {
		const route = await resolvePlaygroundRoute(repos, input.routeId, owner);
		if (isPlaygroundElevenLabsRealtimeOperation(input.operation)) {
			return await connectPlaygroundElevenLabsRealtime(
				route,
				input.operation,
				input.elevenLabs,
				requestSignal,
				{ ...options, deadlineAtMs: owner.deadlineAtMs },
			);
		}
		return await connectPlaygroundDashScopeRealtime(
			route,
			input.operation as PlaygroundDashScopeRealtimeOperation,
			requestSignal,
			{ ...options, deadlineAtMs: owner.deadlineAtMs },
		);
	} finally {
		await owner.drainOwnedMutations();
		owner.dispose();
	}
}
