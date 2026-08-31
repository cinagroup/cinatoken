/**
 * Node Proxy 的实时 WebSocket 适配层：`@hono/node-server` 负责普通 HTTP，
 * 这里用 `ws` 接管 upgrade，并复用 DashScope 的事件改写、failover 与 usage collector。
 */
import { createRequire } from 'node:module';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { resolveProviderUpstreamSecret } from '@octafuse/core';
import { resolveUpstreamEndpoint } from '@octafuse/core/provider-endpoints';
import type { UsageFromStream } from '../services/proxy';
import { EMPTY_USAGE } from '../services/proxy';
import {
	markUpstreamOutcomeUnknown,
	type ProxyDispatchResult,
} from '../services/failover-dispatch';
import type { RouteResult } from '../services/model-router';
import type {
	DashScopeRealtimeNodeDispatch,
	DashScopeRealtimeOperation,
} from '../services/egress/dashscope-realtime-driver';
import {
	DashScopeRealtimeSessionLimiter,
	DashScopeRealtimeOutputLimiter,
	DashScopeRealtimeUsageCollector,
	DASHSCOPE_REALTIME_MAX_PROVIDER_MESSAGE_BYTES,
	applyDashScopeRealtimeMeasuredUsage,
	enforceDashScopeRealtimeUsageCeiling,
	rewriteDashScopeRealtimeClientMessage,
	type DashScopeRealtimeSessionLimits,
} from '../services/egress/dashscope-realtime-driver';
import type {
	RequestTimingAttempt,
	RequestTimingCollector,
} from '../services/request-timing';
import { extractUpstreamRequestId } from '../services/egress/upstream-request-id';
import { DASHSCOPE_REALTIME_MAX_CLIENT_MESSAGE_BYTES } from '../services/dashscope-realtime-guardrails';

const nodeRequire = createRequire(import.meta.url);
const wsModule = nodeRequire('ws') as {
	WebSocket: NodeWebSocketConstructor;
	WebSocketServer: NodeWebSocketServerConstructor;
};

const NODE_WS_OPEN = 1;
const NODE_WS_CLOSED = 3;
const NODE_REALTIME_MAX_PENDING_BYTES = 4 * 1024 * 1024;

export interface NodeWebSocket {
	readonly readyState: number;
	readonly bufferedAmount: number;
	binaryType: string;
	on(event: 'open', listener: () => void): this;
	on(event: 'upgrade', listener: (_response: IncomingMessage) => void): this;
	on(event: 'unexpected-response', listener: (_request: IncomingMessage, response: IncomingMessage) => void): this;
	on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): this;
	on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
	on(event: 'error', listener: (error: Error) => void): this;
	off(event: 'open', listener: () => void): this;
	off(event: 'upgrade', listener: (_response: IncomingMessage) => void): this;
	off(event: 'unexpected-response', listener: (_request: IncomingMessage, response: IncomingMessage) => void): this;
	off(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): this;
	off(event: 'close', listener: (code: number, reason: Buffer) => void): this;
	off(event: 'error', listener: (error: Error) => void): this;
	send(data: string | Buffer): void;
	close(code?: number, reason?: string): void;
}

export type NodeWebSocketConstructor = new (
	url: string,
	options?: { headers?: Record<string, string>; maxPayload?: number }
) => NodeWebSocket;

export interface NodeWebSocketServer {
	handleUpgrade(
		request: IncomingMessage,
		socket: NodeJS.ReadWriteStream,
		head: Buffer,
		callback: (client: NodeWebSocket) => void
	): void;
}

export type NodeWebSocketServerConstructor = new (options: {
	noServer: true;
	maxPayload?: number;
	handleProtocols?: (protocols: Set<string>, request: IncomingMessage) => string | false;
}) => NodeWebSocketServer;

type OpenedUpstream = {
	socket: NodeWebSocket;
	requestId: string | null;
};

type RejectedUpstream = {
	response: Response;
	requestId: string | null;
};

function toHeaders(raw: IncomingHttpHeaders): Headers {
	const headers = new Headers();
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === 'string') headers.set(key, value);
		else if (Array.isArray(value)) headers.set(key, value.join(', '));
	}
	return headers;
}

function closeSocket(socket: NodeWebSocket, code = 1000, reason = ''): void {
	if (socket.readyState === NODE_WS_CLOSED) return;
	socket.close(code, reason.slice(0, 123));
}

function realtimeCapability(operation: DashScopeRealtimeOperation):
	| 'audio.realtime.inference'
	| 'audio.realtime.session' {
	return operation.endsWith('.inference')
		? 'audio.realtime.inference'
		: 'audio.realtime.session';
}

async function connectUpstream(
	route: RouteResult,
	operation: DashScopeRealtimeOperation,
	signal: AbortSignal | undefined,
	timing: RequestTimingCollector | null | undefined,
	attempt: RequestTimingAttempt | undefined,
	WebSocketCtor: NodeWebSocketConstructor,
	sessionLimits?: DashScopeRealtimeSessionLimits,
	beforeUpstreamDispatch?: () => Promise<void>,
): Promise<OpenedUpstream | RejectedUpstream> {
	if (signal?.aborted) {
		throw new Error('Gateway request aborted');
	}
	if (sessionLimits && sessionLimits.connectDeadlineAtMs <= Date.now()) {
		throw new Error('Realtime upstream connection deadline exceeded');
	}
	const endpoint = resolveUpstreamEndpoint(
		'dashscope',
		realtimeCapability(operation),
		route.providerEndpoints,
		{ providerId: route.providerId }
	);
	const url = new URL(endpoint);
	if (operation.endsWith('.session')) url.searchParams.set('model', route.providerModelName);

	const { secret } = await resolveProviderUpstreamSecret(route.providerApiKey);
	await beforeUpstreamDispatch?.();
	const upstream = new WebSocketCtor(url.toString(), {
		headers: { Authorization: `Bearer ${secret}` },
		maxPayload: DASHSCOPE_REALTIME_MAX_PROVIDER_MESSAGE_BYTES,
	});
	let requestId: string | null = null;
	let settled = false;

	return new Promise<OpenedUpstream | RejectedUpstream>((resolve, reject) => {
		let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
		const cleanup = () => {
			if (deadlineTimer != null) clearTimeout(deadlineTimer);
			signal?.removeEventListener('abort', onAbort);
			upstream.off('open', onOpen);
			upstream.off('upgrade', onUpgrade);
			upstream.off('unexpected-response', onUnexpectedResponse);
			upstream.off('error', onError);
		};
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			closeSocket(upstream, 1000, 'Gateway request aborted');
			reject(markUpstreamOutcomeUnknown(new Error('Gateway request aborted')));
		};
		const onError = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(markUpstreamOutcomeUnknown(error));
		};
		const onDeadline = () => {
			if (settled) return;
			settled = true;
			cleanup();
			closeSocket(upstream, 1000, 'Gateway connection deadline exceeded');
			reject(markUpstreamOutcomeUnknown(
				new Error('Realtime upstream connection deadline exceeded'),
			));
		};
		const onUpgrade = (response: IncomingMessage) => {
			requestId = extractUpstreamRequestId(toHeaders(response.headers));
		};
		const onOpen = () => {
			if (settled) return;
			settled = true;
			cleanup();
			timing?.markAttemptHeaders(attempt, 101);
			resolve({ socket: upstream, requestId });
		};
		const onUnexpectedResponse = (_request: IncomingMessage, response: IncomingMessage) => {
			if (settled) return;
			settled = true;
			requestId = extractUpstreamRequestId(toHeaders(response.headers));
			response.resume();
			cleanup();
			const status = response.statusCode && response.statusCode >= 200 && response.statusCode <= 599
				? response.statusCode
				: 502;
			timing?.markAttemptHeaders(attempt, status);
			resolve({ response: new Response(null, { status }), requestId });
		};

		upstream.on('upgrade', onUpgrade);
		upstream.on('open', onOpen);
		upstream.on('unexpected-response', onUnexpectedResponse);
		upstream.on('error', onError);
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener('abort', onAbort, { once: true });
		if (sessionLimits) {
			deadlineTimer = setTimeout(
				onDeadline,
				Math.max(0, sessionLimits.connectDeadlineAtMs - Date.now()),
			);
		}
	});
}

function nodeRealtimeResponse(socket: NodeWebSocket): Response {
	const response = new Response(null, {
		status: 200,
		headers: {
			'X-Octafuse-Realtime-Protocol': 'dashscope',
			'X-Octafuse-Realtime-Upgrade': '1',
		},
	});
	// Node's standard Response forbids status 101; the upgrade is already owned by
	// the http.Server, so keep the socket as an explicit response marker instead.
	Object.defineProperty(response, 'webSocket', { value: socket });
	return response;
}

export function createNodeDashScopeRealtimeDispatch(
	client: NodeWebSocket,
	WebSocketCtor: NodeWebSocketConstructor = wsModule.WebSocket
): DashScopeRealtimeNodeDispatch {
	return (
		route: RouteResult,
		operation: DashScopeRealtimeOperation,
		requestSignal?: AbortSignal,
		timing?: RequestTimingCollector | null,
		attempt?: RequestTimingAttempt,
		sessionLimits?: DashScopeRealtimeSessionLimits,
		beforeUpstreamDispatch?: () => Promise<void>,
	): Promise<ProxyDispatchResult> =>
		new Promise<ProxyDispatchResult>((resolve, reject) => {
			const pendingMessages: Array<string | Buffer> = [];
			const limiter = sessionLimits
				? new DashScopeRealtimeSessionLimiter(
						operation,
						sessionLimits,
						Date.now(),
						route.providerModelName,
					)
				: null;
			let pendingMessageBytes = 0;
			let upstream: NodeWebSocket | null = null;
			let streamError: string | null = null;
			let clientClosedFirst = false;
			let clientClosedBeforeOpen = false;
			let usageSettled = false;
			let resolveUsage!: (usage: UsageFromStream) => void;
			const collector = new DashScopeRealtimeUsageCollector();
			const outputLimiter = new DashScopeRealtimeOutputLimiter();
			const usagePromise = new Promise<UsageFromStream>((usageResolve) => {
				resolveUsage = usageResolve;
			});
			let sessionTimer: ReturnType<typeof setTimeout> | null = null;
			function finishUsage(transportError?: string | null): void {
				if (usageSettled) return;
				usageSettled = true;
				if (sessionTimer != null) clearTimeout(sessionTimer);
				cleanupActiveListeners();
				timing?.markStreamComplete();
				resolveUsage(enforceDashScopeRealtimeUsageCeiling(
					operation,
					sessionLimits,
					applyDashScopeRealtimeMeasuredUsage(
						operation,
						limiter,
						collector.toUsage({
							clientClosedFirst,
							transportError: streamError ?? transportError,
						}),
					),
				));
			}
			function discardUsage(): void {
				if (usageSettled) return;
				usageSettled = true;
				if (sessionTimer != null) clearTimeout(sessionTimer);
				cleanupActiveListeners();
				resolveUsage(EMPTY_USAGE);
			}
			const sendToUpstream = (payload: string | Buffer) => {
				if (!upstream || upstream.readyState !== NODE_WS_OPEN) {
					const byteLength = typeof payload === 'string'
						? Buffer.byteLength(payload)
						: payload.byteLength;
					pendingMessageBytes += byteLength;
					if (pendingMessageBytes > NODE_REALTIME_MAX_PENDING_BYTES) {
						throw new Error('Realtime pending client data limit exceeded');
					}
					pendingMessages.push(payload);
					return;
				}
				upstream.send(payload);
			};
			const onClientMessage = (data: Buffer, isBinary: boolean) => {
				try {
					const payload = isBinary
						? data
						: rewriteDashScopeRealtimeClientMessage(route, operation, data.toString());
					const decision = limiter?.inspect(payload);
					if (decision && !decision.ok) {
						streamError = decision.reason;
						closeSocket(client, 1008, decision.reason);
						if (upstream) closeSocket(upstream, 1008, decision.reason);
						finishUsage(streamError);
						return;
					}
					collector.observeClientActivity();
					sendToUpstream(payload);
				} catch (error) {
					streamError = error instanceof Error ? error.message : String(error);
					closeSocket(client, 1011, 'Gateway upstream send failed');
					if (upstream) closeSocket(upstream, 1011, 'Gateway upstream send failed');
					finishUsage(streamError);
				}
			};
			const onClientClose = (code: number, reason: Buffer) => {
				clientClosedFirst = true;
				clientClosedBeforeOpen = upstream == null;
				if (upstream) closeSocket(upstream, code, reason.toString());
				finishUsage();
			};
			const onClientError = () => {
				clientClosedFirst = true;
				clientClosedBeforeOpen = upstream == null;
				streamError = 'Client WebSocket transport error';
				if (upstream) closeSocket(upstream, 1011, 'Client WebSocket error');
				finishUsage(streamError);
			};
			const onUpstreamMessage = (data: Buffer, isBinary: boolean) => {
				try {
					const payload = isBinary ? data : data.toString();
					const decision = outputLimiter.inspect(payload);
					if (!decision.ok) {
						streamError = decision.reason;
						closeSocket(client, 1009, decision.reason);
						if (upstream) closeSocket(upstream, 1009, decision.reason);
						finishUsage(streamError);
						return;
					}
					if (client.bufferedAmount + decision.messageBytes > NODE_REALTIME_MAX_PENDING_BYTES) {
						streamError = 'Realtime client output backpressure limit exceeded';
						closeSocket(client, 1009, streamError);
						if (upstream) closeSocket(upstream, 1009, streamError);
						finishUsage(streamError);
						return;
					}
					if (!isBinary) collector.observeServerMessage(data.toString());
					client.send(payload);
				} catch (error) {
					streamError = error instanceof Error ? error.message : String(error);
					closeSocket(client, 1011, 'Gateway client send failed');
					if (upstream) closeSocket(upstream, 1011, 'Gateway client send failed');
					finishUsage(streamError);
				}
			};
			const onUpstreamClose = (code: number, reason: Buffer) => {
				closeSocket(client, code, reason.toString());
				finishUsage(code === 1000 ? null : `Upstream WebSocket closed with code ${code}`);
			};
			const onUpstreamError = () => {
				streamError = 'Upstream WebSocket transport error';
				closeSocket(client, 1011, 'Upstream WebSocket error');
				finishUsage(streamError);
			};
			const onAbort = () => {
				streamError = 'Gateway request aborted';
				closeSocket(client, 1000, 'Gateway request aborted');
				if (upstream) closeSocket(upstream, 1000, 'Gateway request aborted');
				finishUsage(streamError);
			};
			function cleanupActiveListeners(): void {
				client.off('message', onClientMessage);
				client.off('close', onClientClose);
				client.off('error', onClientError);
				upstream?.off('message', onUpstreamMessage);
				upstream?.off('close', onUpstreamClose);
				upstream?.off('error', onUpstreamError);
				requestSignal?.removeEventListener('abort', onAbort);
			}

			client.on('message', onClientMessage);
			client.on('close', onClientClose);
			client.on('error', onClientError);
			requestSignal?.addEventListener('abort', onAbort, { once: true });
			if (limiter) {
				sessionTimer = setTimeout(() => {
					streamError = 'Realtime session duration limit exceeded';
					closeSocket(client, 1008, 'Realtime session limit exceeded');
					if (upstream) closeSocket(upstream, 1008, 'Realtime session limit exceeded');
					finishUsage(streamError);
				}, limiter.remainingSessionMs());
			}

			void connectUpstream(
				route,
				operation,
				requestSignal,
				timing,
				attempt,
				WebSocketCtor,
				sessionLimits,
				beforeUpstreamDispatch,
			)
				.then((opened) => {
					if ('response' in opened) {
						discardUsage();
						resolve({
							response: opened.response,
							usagePromise: Promise.resolve(EMPTY_USAGE),
							upstreamRequestId: opened.requestId,
						});
						return;
					}
					if (clientClosedBeforeOpen) {
						closeSocket(opened.socket, 1000, 'Client WebSocket closed');
						discardUsage();
						reject(new Error('Client WebSocket closed before upstream connection'));
						return;
					}
					upstream = opened.socket;
					upstream.binaryType = 'nodebuffer';
					upstream.on('message', onUpstreamMessage);
					upstream.on('close', onUpstreamClose);
					upstream.on('error', onUpstreamError);
					for (const pending of pendingMessages.splice(0)) {
						upstream.send(pending);
					}
					pendingMessageBytes = 0;
					resolve({
						response: nodeRealtimeResponse(client),
						usagePromise,
						upstreamRequestId: opened.requestId,
					});
				})
				.catch((error) => {
					discardUsage();
					reject(upstream ? markUpstreamOutcomeUnknown(error) : error);
				});
		});
}

export function createNodeWebSocketServer(): NodeWebSocketServer {
	return new wsModule.WebSocketServer({
		noServer: true,
		maxPayload: DASHSCOPE_REALTIME_MAX_CLIENT_MESSAGE_BYTES,
		handleProtocols: (protocols) => protocols.values().next().value ?? false,
	});
}
