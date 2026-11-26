
import { createRealtimeSocket, type RealtimeSocket } from '../services/egress/dashscope-realtime-socket';

import {
	bridgeElevenLabsRealtime,
	elevenLabsRealtimeRejectedResult,
	resolveElevenLabsRealtimeTarget,
	type ElevenLabsRealtimeNodeDispatch,
} from '../services/egress/elevenlabs-realtime-driver';

import type { DeferredRealtimeRuntime } from '../services/egress/dashscope-realtime-session';
/**
 * Node Proxy 的实时 WebSocket 适配层：`@hono/node-server` 负责普通 HTTP，
 * 这里用 `ws` 接管 upgrade，并复用 DashScope 的事件改写、failover 与 usage collector。
 */
import { createRequire } from 'node:module';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { applyRouteExtraHeaders, resolveProviderUpstreamSecret } from '@octafuse/core';
import { resolveUpstreamEndpoint } from '@octafuse/core/provider-endpoints';
import { pickDashScopeRealtimeSubprotocol } from '@octafuse/core/realtime-protocol';
import type { UsageFromStream } from '../services/proxy';
import { EMPTY_USAGE } from '../services/proxy';
import { type ProxyDispatchResult } from '../services/failover-dispatch';
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
	normalizeWebSocketCloseCode,
	rewriteDashScopeRealtimeClientMessage,
} from '../services/egress/dashscope-realtime-driver';
import type { RequestTimingAttempt, RequestTimingCollector } from '../services/request-timing';
import { extractUpstreamRequestId } from '../services/egress/upstream-request-id';
import { DASHSCOPE_REALTIME_MAX_CLIENT_MESSAGE_BYTES } from '../services/dashscope-realtime-guardrails';

import {
	createRealtimeConnectionLifecycle,
	realtimeCloseParameters,
	realtimeRejectedResponse,
	realtimeUpstreamHeaders,
	type RealtimeConnectionLifecycle,
	type RealtimeConnectionOptions,
} from '../services/egress/realtime-connection-lifecycle';

const nodeRequire = createRequire(import.meta.url);
const wsModule = nodeRequire('ws') as {
	WebSocket: NodeWebSocketConstructor;
	WebSocketServer: NodeWebSocketServerConstructor;
};

const NODE_WS_OPEN = 1;
const NODE_WS_CLOSED = 3;
const NODE_REALTIME_MAX_PENDING_BYTES = 4 * 1024 * 1024;
const NODE_REALTIME_MAX_PENDING_MESSAGES = 1_024;

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
	terminate(): void;
	pause(): void;
	resume(): void;
}

export type NodeWebSocketConstructor = new (
	url: string,
	options?: { headers?: Record<string, string>; maxPayload?: number; followRedirects?: false },
) => NodeWebSocket;

export interface NodeWebSocketServer {
	handleUpgrade(
		request: IncomingMessage,
		socket: NodeJS.ReadWriteStream,
		head: Buffer,
		callback: (client: NodeWebSocket) => void,
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
	releaseErrorObserver(): void;
};

type RejectedUpstream = { result: ProxyDispatchResult };

function toHeaders(raw: IncomingHttpHeaders): Headers {
	const headers = new Headers();
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === 'string') headers.set(key, value);
		else if (Array.isArray(value)) headers.set(key, value.join(', '));
	}
	return headers;
}

/** ws emits an asynchronous error when a CONNECTING socket is terminated. */
function ownSocketErrorsUntilClose(socket: NodeWebSocket): () => void {
	const ignore = () => {};
	const release = () => {
		socket.off('error', ignore);
		socket.off('close', release);
	};
	if (socket.readyState !== NODE_WS_CLOSED) {
		socket.on('error', ignore);
		socket.on('close', release);
	}
	return release;
}
function terminateSocket(socket: NodeWebSocket): void {
	if (socket.readyState === NODE_WS_CLOSED) return;
	ownSocketErrorsUntilClose(socket);
	try {
		socket.terminate();
	} catch {
		/* Cleanup must not orphan settlement. */
	}
}
function closeSocket(socket: NodeWebSocket, code = 1000, reason = ''): void {
	if (socket.readyState === NODE_WS_CLOSED) return;
	ownSocketErrorsUntilClose(socket);
	const safe = realtimeCloseParameters(normalizeWebSocketCloseCode(code), reason);
	try {
		socket.close(safe.code, safe.reason);
	} catch {
		terminateSocket(socket);
	}
}

async function connectUpstream(
	route: RouteResult,
	operation: DashScopeRealtimeOperation,
	connection: RealtimeConnectionLifecycle,
	timing: RequestTimingCollector | null | undefined,
	attempt: RequestTimingAttempt | undefined,
	WebSocketCtor: NodeWebSocketConstructor,
	options: RealtimeConnectionOptions,
	beforeUpstreamDispatch?: () => Promise<void>,
): Promise<OpenedUpstream | RejectedUpstream> {
	connection.throwIfStopped();
	const endpoint = resolveUpstreamEndpoint(
		'dashscope',
		operation.endsWith('.inference') ? 'audio.realtime.inference' : 'audio.realtime.session',
		route.providerEndpoints,
		{ providerId: route.providerId },
	);
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new Error('Invalid realtime upstream URL');
	}
	if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash)
		throw new Error('Invalid realtime upstream URL');
	if (operation.endsWith('.session')) url.searchParams.set('model', route.providerModelName);
	const { secret } = await connection.wait(() =>
		resolveProviderUpstreamSecret(route.providerApiKey, {
			signal: connection.signal,
			auxiliaryAuth: options.auxiliaryAuth,
		}),
	);
	// Validate before durable admission and before the ws constructor can send.
	const headers = realtimeUpstreamHeaders(secret);
	await connection.admit(beforeUpstreamDispatch);
	connection.markDispatched();
	const upstream = new WebSocketCtor(url.toString(), {
		headers: applyRouteExtraHeaders(Object.fromEntries(headers.entries()), route.customParams),
		maxPayload: DASHSCOPE_REALTIME_MAX_PROVIDER_MESSAGE_BYTES,
		followRedirects: false,
	});
	const releaseErrorObserver = ownSocketErrorsUntilClose(upstream);
	let requestId: string | null = null;
	let settled = false;
	return new Promise<OpenedUpstream | RejectedUpstream>((resolve, reject) => {
		const cleanup = () => {
			connection.signal.removeEventListener('abort', onAbort);
			upstream.off('open', onOpen);
			upstream.off('upgrade', onUpgrade);
			upstream.off('unexpected-response', onUnexpectedResponse);
			upstream.off('error', onError);
			upstream.off('close', onClose);
		};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			// Keep the independent error observer until ws emits its close event.
			terminateSocket(upstream);
			reject(error);
		};
		const onAbort = () => fail(connection.signal.reason);
		const onError = () => fail(new Error('Realtime upstream connection failed'));
		const onClose = () => fail(new Error('Realtime upstream closed before opening'));
		const onUpgrade = (response: IncomingMessage) => {
			try {
				requestId = extractUpstreamRequestId(toHeaders(response.headers));
			} catch {
				onError();
			}
		};
		const onOpen = () => {
			if (settled) return;
			try {
				connection.throwIfStopped();
			} catch (error) {
				fail(error);
				return;
			}
			settled = true;
			cleanup();
			timing?.markAttemptHeaders(attempt, 101);
			resolve({ socket: upstream, requestId, releaseErrorObserver });
		};
		const onUnexpectedResponse = (_request: IncomingMessage, response: IncomingMessage) => {
			if (settled) {
				response.destroy();
				return;
			}
			try {
				const headers = toHeaders(response.headers);
				requestId = extractUpstreamRequestId(headers);
				const result = realtimeRejectedResponse(response.statusCode ?? 0, headers, requestId);
				settled = true;
				cleanup();
				// Explicit non-101 rejection: abandon the body, do not resume/drain it.
				response.destroy();
				terminateSocket(upstream);
				timing?.markAttemptHeaders(attempt, result.response.status);
				resolve({ result });
			} catch (error) {
				response.destroy();
				fail(error);
			}
		};
		upstream.on('upgrade', onUpgrade);
		upstream.on('open', onOpen);
		upstream.on('unexpected-response', onUnexpectedResponse);
		upstream.on('error', onError);
		upstream.on('close', onClose);
		connection.signal.addEventListener('abort', onAbort, { once: true });
		if (connection.signal.aborted) onAbort();
	});
}

function nodeRealtimeResponse(socket: NodeWebSocket, protocol = 'dashscope'): Response {
	const response = new Response(null, {
		status: 200,
		headers: {
			'X-Octafuse-Realtime-Protocol': protocol,
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
	WebSocketCtor: NodeWebSocketConstructor = wsModule.WebSocket,
): DashScopeRealtimeNodeDispatch {
	// The accepted client also needs an error owner during route preparation
	// and between rejected handshake attempts, before a bridge listener exists.
	ownSocketErrorsUntilClose(client);
	// Frames not sent to any upstream belong to the accepted client, not a
	// candidate. Keep their original bytes across explicit handshake rejection;
	// each new candidate must validate and rewrite them against its own model.
	const pendingMessages: Array<{ data: Buffer; isBinary: boolean }> = [];
	let pendingMessageBytes = 0;
	let activeMessageHandler: ((data: Buffer, isBinary: boolean) => void) | null = null;
	const clearPending = () => {
		pendingMessages.length = 0;
		pendingMessageBytes = 0;
	};
	const queuePending = (data: Buffer, isBinary: boolean): boolean => {
		if (
			pendingMessages.length >= NODE_REALTIME_MAX_PENDING_MESSAGES ||
			pendingMessageBytes + data.byteLength > NODE_REALTIME_MAX_PENDING_BYTES
		)
			return false;
		pendingMessageBytes += data.byteLength;
		pendingMessages.push({ data, isBinary });
		return true;
	};
	const onMessage = (data: Buffer, isBinary: boolean) => {
		if (activeMessageHandler) activeMessageHandler(data, isBinary);
		else if (!queuePending(data, isBinary)) {
			clearPending();
			closeSocket(client, 1009, 'Realtime pending data limit exceeded');
		}
	};
	const releasePendingOwner = () => {
		clearPending();
		client.off('message', onMessage);
		client.off('close', releasePendingOwner);
	};
	if (client.readyState !== NODE_WS_CLOSED) {
		client.on('message', onMessage);
		client.on('close', releasePendingOwner);
	}
	return async (
		route,
		operation,
		requestSignal,
		timing,
		attempt,
		sessionLimits,
		beforeUpstreamDispatch,
		options = {},
	) => {
		const controller = new AbortController();
		const connection = createRealtimeConnectionLifecycle(controller.signal, {
			...options,
			connectDeadlineAtMs: Math.min(
				options.connectDeadlineAtMs ?? Infinity,
				sessionLimits?.connectDeadlineAtMs ?? Infinity,
			),
		});
		const limiter = sessionLimits
			? new DashScopeRealtimeSessionLimiter(operation, sessionLimits, Date.now(), route.providerModelName)
			: null;
		const collector = new DashScopeRealtimeUsageCollector();
		const outputLimiter = new DashScopeRealtimeOutputLimiter();
		let pendingRewrittenBytes = 0;
		let upstream: NodeWebSocket | null = null;
		let usageSettled = false;
		let clientClosedFirst = false;
		let resolveUsage!: (usage: UsageFromStream) => void;
		const usagePromise = new Promise<UsageFromStream>((resolve) => {
			resolveUsage = resolve;
		});
		let sessionTimer: ReturnType<typeof setTimeout> | null = null;
		function cleanup(): void {
			if (sessionTimer != null) clearTimeout(sessionTimer);
			activeMessageHandler = null;
			client.off('close', onClientClose);
			client.off('error', onClientError);
			upstream?.off('message', onUpstreamMessage);
			upstream?.off('close', onUpstreamClose);
			upstream?.off('error', onUpstreamError);
			requestSignal?.removeEventListener('abort', onAbort);
		}
		function finish(error?: string | null, code = 1000, reason = '', discard = false, retainPending = false): void {
			if (usageSettled) return;
			usageSettled = true;
			cleanup();
			if (!retainPending) clearPending();
			if (!discard) {
				// Stop receiving immediately; close acknowledgement may never arrive.
				releasePendingOwner();
				// In particular stop OAuth/admission/open when the client disappears.
				controller.abort(requestSignal?.reason);
				closeSocket(client, code, reason);
				if (upstream) closeSocket(upstream, code, reason);
				timing?.markStreamComplete();
			}
			resolveUsage(
				discard
					? EMPTY_USAGE
					: enforceDashScopeRealtimeUsageCeiling(
							operation,
							sessionLimits,
							applyDashScopeRealtimeMeasuredUsage(
								operation,
								limiter,
								collector.toUsage({ clientClosedFirst, transportError: error }),
							),
						),
			);
		}
		const onClientMessage = (data: Buffer, isBinary: boolean) => {
			if (usageSettled) return;
			try {
				const payload = isBinary ? data : rewriteDashScopeRealtimeClientMessage(route, operation, data.toString());
				const decision = limiter?.inspect(payload);
				if (decision && !decision.ok) {
					finish(decision.reason, 1008, decision.reason);
					return;
				}
				collector.observeClientActivity();
				if (!upstream) {
					pendingRewrittenBytes += typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
					if (pendingRewrittenBytes > NODE_REALTIME_MAX_PENDING_BYTES || !queuePending(data, isBinary)) {
						finish('Realtime pending client data limit exceeded', 1009, 'Realtime pending data limit exceeded');
						return;
					}
				} else if (upstream.readyState === NODE_WS_OPEN) upstream.send(payload);
				else finish('Realtime upstream is not open', 1011, 'Realtime upstream is not open');
			} catch {
				finish('Gateway upstream send failed', 1011, 'Gateway upstream send failed');
			}
		};
		const onClientClose = (code: number, reason: Buffer) => {
			if (usageSettled) return;
			clientClosedFirst = true;
			finish(null, code, reason.toString());
		};
		const onClientError = () => {
			clientClosedFirst = true;
			finish('Client WebSocket transport error', 1011, 'Client WebSocket error');
		};
		const onUpstreamMessage = (data: Buffer, isBinary: boolean) => {
			if (usageSettled) return;
			try {
				const payload = isBinary ? data : data.toString();
				const decision = outputLimiter.inspect(payload);
				if (!decision.ok) {
					finish(decision.reason, 1009, decision.reason);
					return;
				}
				if (client.bufferedAmount + decision.messageBytes > NODE_REALTIME_MAX_PENDING_BYTES) {
					finish(
						'Realtime client output backpressure limit exceeded',
						1009,
						'Realtime client backpressure limit exceeded',
					);
					return;
				}
				if (!isBinary) collector.observeServerMessage(data.toString());
				client.send(payload);
			} catch {
				finish('Gateway client send failed', 1011, 'Gateway client send failed');
			}
		};
		const onUpstreamClose = (code: number, reason: Buffer) =>
			finish(code === 1000 ? null : `Upstream WebSocket closed with code ${code}`, code, reason.toString());
		const onUpstreamError = () => finish('Upstream WebSocket transport error', 1011, 'Upstream WebSocket error');
		const onAbort = () => {
			clientClosedFirst = true;
			finish('Gateway request aborted', 1000, 'Gateway request aborted');
		};
		activeMessageHandler = onClientMessage;
		client.on('close', onClientClose);
		client.on('error', onClientError);
		requestSignal?.addEventListener('abort', onAbort, { once: true });
		if (requestSignal?.aborted || client.readyState !== NODE_WS_OPEN) onAbort();
		// Revalidate unsent frames exactly once for this candidate. Requeue only
		// raw frames; never retain bytes that have crossed an accepted upstream.
		const retained = pendingMessages.splice(0);
		pendingMessageBytes = 0;
		for (const frame of retained) onClientMessage(frame.data, frame.isBinary);
		if (limiter && !usageSettled)
			sessionTimer = setTimeout(
				() => finish('Realtime session duration limit exceeded', 1008, 'Realtime session limit exceeded'),
				limiter.remainingSessionMs(),
			);
		try {
			const opened = await connectUpstream(
				route,
				operation,
				connection,
				timing,
				attempt,
				WebSocketCtor,
				options,
				beforeUpstreamDispatch,
			);
			if ('result' in opened) {
				finish(null, 1000, '', true, true);
				return opened.result;
			}
			upstream = opened.socket;
			try {
				connection.throwIfStopped();
				if (usageSettled || client.readyState !== NODE_WS_OPEN || upstream.readyState !== NODE_WS_OPEN)
					throw new Error('Realtime connection closed before bridging');
				upstream.binaryType = 'nodebuffer';
				upstream.on('message', onUpstreamMessage);
				upstream.on('close', onUpstreamClose);
				upstream.on('error', onUpstreamError);
				opened.releaseErrorObserver();
				for (const pending of pendingMessages.splice(0)) {
					if (usageSettled) throw new Error('Realtime connection stopped during pending flush');
					upstream.send(
						pending.isBinary
							? pending.data
							: rewriteDashScopeRealtimeClientMessage(route, operation, pending.data.toString()),
					);
				}
				pendingMessageBytes = 0;
				return { response: nodeRealtimeResponse(client), usagePromise, upstreamRequestId: opened.requestId };
			} catch (error) {
				terminateSocket(upstream);
				throw error;
			}
		} catch (error) {
			// failure() may itself throw admission/unknown errors. Always finish
			// the attempt so its timer/listeners cannot survive the outer catch.
			let retainPending = false;
			try {
				const failure = connection.failure(error);
				retainPending = failure.meta?.upstreamOutcomeUnknown !== true;
				return failure;
			} finally {
				finish(null, 1000, '', true, retainPending);
			}
		} finally {
			connection.dispose();
		}
	};
}

export function createNodeWebSocketServer(): NodeWebSocketServer {
	return new wsModule.WebSocketServer({
		noServer: true,
		maxPayload: DASHSCOPE_REALTIME_MAX_CLIENT_MESSAGE_BYTES,
		handleProtocols: (protocols) => pickDashScopeRealtimeSubprotocol(protocols),
	});
}


/**
 * 握手响应与上游首帧（如 ElevenLabs 的 `session_started`）常在同一个 TCP 包里，
 * `ws` 会在 nextTick 里先把它们发出来，早于 promise 回调里挂的监听器。
 * 因此在 `open` 的同一同步段里先挂缓冲监听，由调用方在自己订阅后回放。
 */
type EarlyUpstreamMessages = {
	/** 停止缓冲并返回已缓冲的帧。 */
	drain(): Array<{ data: Buffer; isBinary: boolean }>;
};


function createEarlyUpstreamMessages(upstream: NodeWebSocket): EarlyUpstreamMessages {
	const buffered: Array<{ data: Buffer; isBinary: boolean }> = [];
	const listener = (data: Buffer, isBinary: boolean) => {
		if(buffered.length>=NODE_REALTIME_MAX_PENDING_MESSAGES||buffered.reduce((n,frame)=>n+frame.data.byteLength,0)+data.byteLength>NODE_REALTIME_MAX_PENDING_BYTES){terminateSocket(upstream);return;}
 buffered.push({ data, isBinary });
	};
	upstream.on('message', listener);
	return {
		drain() {
			upstream.off('message', listener);
			return buffered.splice(0);
		},
	};
}


function realtimeCapability(operation: DashScopeRealtimeOperation):
	| 'audio.realtime.inference'
	| 'audio.realtime.session' {
	return operation.endsWith('.inference')
		? 'audio.realtime.inference'
		: 'audio.realtime.session';
}


/** 读上游握手被拒时的响应体（有上限与超时，用于识别 ElevenLabs 的 `detail.status`）。 */
function readRejectedBody(response: IncomingMessage, limitBytes = 8192, timeoutMs = 2000): Promise<string> {
	return new Promise<string>((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			response.destroy();
			resolve(Buffer.concat(chunks).toString('utf8'));
		};
		const timer = setTimeout(finish, timeoutMs);
		response.on('data', (chunk: Buffer) => {
			if (size >= limitBytes) return;
			chunks.push(chunk.subarray(0,Math.max(0,limitBytes-size)));
			size += chunk.length;
			if (size >= limitBytes) finish();
		});
		response.on('end', finish);
		response.on('error', finish);
		response.on('close', finish);
	});
}


/** 建立上游 WebSocket：成功返回已 open 的 socket；握手被拒返回上游状态码（可选带响应体）。 */
async function connectNodeUpstream(
 url:string, headers:Record<string,string>, signal:AbortSignal|undefined,
 timing:RequestTimingCollector|null|undefined,attempt:RequestTimingAttempt|undefined,
 WebSocketCtor:NodeWebSocketConstructor, options:{captureRejectedBody?:boolean}={},
):Promise<{socket:NodeWebSocket;requestId:string|null;early:EarlyUpstreamMessages}|{response:Response;requestId:string|null}> {
 const connection=createRealtimeConnectionLifecycle(signal,{});
 try {
  connection.throwIfStopped();
  const target=new URL(url);
  if(!['ws:','wss:'].includes(target.protocol)||target.username||target.password||target.hash)throw new Error('Invalid realtime upstream URL');
  connection.markDispatched();
  const upstream=new WebSocketCtor(target.toString(),{headers,maxPayload:DASHSCOPE_REALTIME_MAX_PROVIDER_MESSAGE_BYTES,followRedirects:false});
  ownSocketErrorsUntilClose(upstream);
  let requestId:string|null=null;
  return await new Promise((resolve,reject)=>{
   let settled=false;
   const cleanup=()=>{connection.signal.removeEventListener('abort',onAbort);upstream.off('open',onOpen);upstream.off('upgrade',onUpgrade);upstream.off('unexpected-response',onUnexpectedResponse);upstream.off('error',onError);upstream.off('close',onClose);};
   const fail=(error:unknown)=>{if(settled)return;settled=true;cleanup();terminateSocket(upstream);reject(error);};
   const onAbort=()=>fail(connection.signal.reason);
   const onError=()=>fail(new Error('Realtime upstream connection failed'));
   const onClose=()=>fail(new Error('Realtime upstream closed before opening'));
   const onUpgrade=(response:IncomingMessage)=>{requestId=extractUpstreamRequestId(toHeaders(response.headers));};
   const onOpen=()=>{if(settled)return;try{connection.throwIfStopped();}catch(error){fail(error);return;}settled=true;cleanup();timing?.markAttemptHeaders(attempt,101);resolve({socket:upstream,requestId,early:createEarlyUpstreamMessages(upstream)});};
   const onUnexpectedResponse=(_request:IncomingMessage,response:IncomingMessage)=>{
    if(settled){response.destroy();return;}
    requestId=extractUpstreamRequestId(toHeaders(response.headers));
    const status=response.statusCode&&response.statusCode>=200&&response.statusCode<=599?response.statusCode:502;
    timing?.markAttemptHeaders(attempt,status);
    const text=options.captureRejectedBody?connection.wait(()=>readRejectedBody(response)):Promise.resolve('');
    void text.then(body=>{if(settled){response.destroy();return;}settled=true;cleanup();response.destroy();terminateSocket(upstream);resolve({response:new Response(body||null,{status,headers:{'Content-Type':'application/json'}}),requestId});},fail);
   };
   upstream.on('open',onOpen);upstream.on('upgrade',onUpgrade);upstream.on('unexpected-response',onUnexpectedResponse);upstream.on('error',onError);upstream.on('close',onClose);
   connection.signal.addEventListener('abort',onAbort,{once:true});if(connection.signal.aborted)onAbort();
  });
 } finally {connection.dispose();}
}

/** 把 `ws` socket 包成运行时无关的 `RealtimeSocket`。 */
function wrapNodeSocket(socket: NodeWebSocket, early?: EarlyUpstreamMessages): RealtimeSocket {
	return createRealtimeSocket({
		send: (data) => {
			if (typeof data === 'string') socket.send(data);
			else socket.send(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
		},
		close: (code, reason) => closeSocket(socket, code ?? 1000, reason ?? ''),
		subscribe: (handlers) => {
			socket.on('message', (data, isBinary) => handlers.message(isBinary ? data : data.toString()));
			socket.on('close', (code, reason) => handlers.close(code, reason.toString()));
			socket.on('error', () => handlers.error());
			for (const frame of early?.drain() ?? []) {
				handlers.message(frame.isBinary ? frame.data : frame.data.toString());
			}
		},
	});
}


/**
 * ElevenLabs 实时入口的 Node 调度：下游已完成 upgrade 且暂停读；连上上游后桥接两端，
 * 返回与 Worker 一致的 `ProxyDispatchResult`（用 `webSocket` 标记 + `X-Octafuse-Realtime-Upgrade`）。
 */
export function createNodeElevenLabsRealtimeDispatch(
	client: NodeWebSocket,
	WebSocketCtor: NodeWebSocketConstructor = wsModule.WebSocket
): ElevenLabsRealtimeNodeDispatch {
	// 第一次调度时才订阅下游（同一连接 failover 多次复用同一个包装）；订阅后到达的帧 / close 会排队到桥接开始。
	let clientSocket: RealtimeSocket | null = null;
	return async (route, params, requestSignal, timing, attempt, beforeDispatch): Promise<ProxyDispatchResult> => {
		clientSocket ??= wrapNodeSocket(client);
  const connection=createRealtimeConnectionLifecycle(requestSignal,{});
  try {
		const target = await connection.wait(()=>resolveElevenLabsRealtimeTarget(route,params,{signal:connection.signal}));
  await connection.admit(beforeDispatch);
  connection.markDispatched();
		const opened = await connectNodeUpstream(
			target.url,
			target.headers,
			connection.signal,
			timing,
			attempt,
			WebSocketCtor,
			{ captureRejectedBody: true }
		);
		if ('response' in opened) {
			return elevenLabsRealtimeRejectedResult(opened.response, opened.requestId);
		}
		opened.socket.binaryType = 'nodebuffer';
		const usagePromise = bridgeElevenLabsRealtime({
			client: clientSocket,
			upstream: wrapNodeSocket(opened.socket, opened.early),
			operation: params.operation,
			audioFormat: params.query.audio_format ?? null,
 sessionLimits:params.sessionLimits,
 requestSignal,
			timing,
		});
		return {
			response: nodeRealtimeResponse(client, 'elevenlabs'),
			usagePromise,
			upstreamRequestId: opened.requestId,
		};
  } catch(error){return connection.failure(error);} finally {connection.dispose();}
	};
}


/**
 * inference 新入口（延迟连接上游）的 Node 运行时：下游 `client` 已经完成 upgrade，
 * 订阅在这里立刻开始排队，等第一帧 run-task 后再由会话选路由、连上游。
 */
export function createNodeDashScopeDeferredRuntime(
	client: NodeWebSocket,
	WebSocketCtor: NodeWebSocketConstructor = wsModule.WebSocket
): DeferredRealtimeRuntime {
	return {
		client: wrapNodeSocket(client),

  connectUpstream: async (route, operation, signal, timing, attempt) => {
   const connection = createRealtimeConnectionLifecycle(signal,{});
   try {
    const opened = await connectUpstream(route,operation,connection,timing,attempt,WebSocketCtor,{});
    if ('result' in opened) return {response:opened.result.response,requestId:opened.result.upstreamRequestId ?? null};
    opened.socket.binaryType = 'nodebuffer';
    return {socket:wrapNodeSocket(opened.socket),requestId:opened.requestId};
   } catch (error) {
    if (signal?.aborted) throw error;
    const failed = connection.failure(error);
    return {response:failed.response,requestId:failed.upstreamRequestId ?? null};
   } finally { connection.dispose(); }

		},
	};
}
