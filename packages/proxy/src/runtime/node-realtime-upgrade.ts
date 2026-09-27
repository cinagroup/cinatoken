import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Hono } from 'hono';
import type { Env } from '../app';
import type { DashScopeRealtimeNodeDispatch } from '../services/egress/dashscope-realtime-driver';
import { responseTextWithinLimit } from '../services/egress/bounded-response-body';
import { DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS } from '../services/dashscope-realtime-guardrails';
import { isDashScopeRealtimePath } from '../services/dashscope-realtime-path';
import { RequestExecutionStoppedError } from '../services/request-deadline';
import {
	createNodeDashScopeRealtimeDispatch,
	type NodeWebSocket,
	type NodeWebSocketServer,
} from './node-realtime';

const MAX_REJECTION_BYTES = 8 * 1024;
// Normal WebSocket clients wait for 101. Bound any speculative pre-101 frames
// while still reading the socket so a peer FIN cancels slow authentication.
const MAX_PRE_UPGRADE_BYTES = 64 * 1024;
const REJECTION_HEADERS = [
	'Content-Type', 'Retry-After', 'X-OctaFuse-Error-Code', 'X-Generation-Id',
	'Access-Control-Allow-Origin', 'Access-Control-Expose-Headers',
] as const;

/**
 * Own the raw connection before handing it to ws. Run Hono exactly once and
 * accept only when its authenticated, policy-checked route asks to dispatch.
 * This is not an upstream-success guarantee: OAuth/admission/connection may
 * still fail after the client Upgrade, in which case terminate the WebSocket.
 */
export async function handleNodeRealtimeUpgrade(
	app: Pick<Hono<Env>, 'fetch'>,
	request: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	websocketServer: NodeWebSocketServer,
): Promise<void> {
	const connectDeadlineAtMs = Date.now() + DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS;
	const controller = new AbortController();
	let client: NodeWebSocket | undefined;
	let dispatchPromise: Promise<DashScopeRealtimeNodeDispatch> | undefined;
	let httpEnded = false;
	let bufferedBytes = head.byteLength;
	const buffered: Buffer[] = head.byteLength ? [head] : [];
	function expireConnection(): void {
		controller.abort(new RequestExecutionStoppedError('deadline_exceeded'));
		if (client) closeClient(1011, 'Realtime connection deadline exceeded');
		else rejectHttp(504, 'Realtime connection deadline exceeded');
	}
	const timer = setTimeout(expireConnection, DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS);
	timer.unref();

	function discardBuffered(): void {
		buffered.length = 0;
		bufferedBytes = 0;
		socket.off('data', onData);
	}
	function closeClient(code: number, message: string): void {
		if (!client || client.readyState === 3) return;
		// Only fixed ASCII messages enter the close frame; never an exception or
		// upstream body (which can contain secrets or exceed the UTF-8 limit).
		try { client.close(code, message); }
		catch { try { client.terminate(); } catch { socket.destroy(); } }
	}
	function rejectHttp(status: number, message: string, headers = new Headers()): void {
		if (httpEnded || client || socket.destroyed || !socket.writable) return;
		httpEnded = true;
		clearTimeout(timer);
		discardBuffered();
		const body = Buffer.from(message);
		const lines = [
			`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}`,
			'Connection: close', 'Cache-Control: no-store',
			`Content-Length: ${body.byteLength}`,
		];
		for (const name of REJECTION_HEADERS) {
			const value = headers.get(name);
			if (value && Buffer.byteLength(value) <= 512 && !/[\r\n]/.test(value)) lines.push(`${name}: ${value}`);
		}
		if (!headers.has('Content-Type')) lines.push('Content-Type: text/plain; charset=utf-8');
		socket.once('finish', () => socket.destroy());
		socket.end(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`), body]));
	}
	function onClose(): void {
		clearTimeout(timer);
		discardBuffered();
		controller.abort(new RequestExecutionStoppedError('client_cancelled'));
		socket.off('close', onClose);
		socket.off('end', onEnd);
		socket.off('error', onError);
	}
	function onEnd(): void {
		controller.abort(new RequestExecutionStoppedError('client_cancelled'));
		// Before ws owns the stream, nobody else closes the half-open socket.
		if (!client) socket.destroy();
	}
	function onError(): void {
		controller.abort(new RequestExecutionStoppedError('client_cancelled'));
		socket.destroy();
	}
	function onData(chunk: Buffer): void {
		if (httpEnded || controller.signal.aborted) return;
		bufferedBytes += chunk.byteLength;
		if (bufferedBytes > MAX_PRE_UPGRADE_BYTES) {
			controller.abort(new RequestExecutionStoppedError('client_cancelled'));
			rejectHttp(413, 'Realtime pre-upgrade data limit exceeded');
			return;
		}
		buffered.push(chunk);
	}
	socket.on('error', onError);
	socket.on('close', onClose);
	socket.on('end', onEnd);
	socket.on('data', onData);

	try {
		if (socket.destroyed || socket.readableEnded || !socket.writable) { onClose(); return; }
		if (bufferedBytes > MAX_PRE_UPGRADE_BYTES) { rejectHttp(413, 'Realtime pre-upgrade data limit exceeded'); return; }
		const path = (request.url ?? '/').split('?', 1)[0]!;
		if (!isDashScopeRealtimePath(path)) { rejectHttp(404, 'Resource not found'); return; }
		if (request.method !== 'GET') { rejectHttp(405, 'Expected a GET WebSocket upgrade'); return; }
		const headers = new Headers();
		for (const [key, value] of Object.entries(request.headers)) {
			if (typeof value === 'string') headers.set(key, value);
			else if (Array.isArray(value)) headers.set(key, value.join(', '));
		}
		const protocol = (request.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
		let fetchRequest: Request;
		try {
			fetchRequest = new Request(`${protocol}://${request.headers.host ?? '127.0.0.1'}${request.url}`, {
				method: 'GET', headers, signal: controller.signal,
			});
		} catch { rejectHttp(400, 'Invalid realtime upgrade request'); return; }
		const nodeDispatch: DashScopeRealtimeNodeDispatch = async (
			route, operation, signal, timing, attempt, sessionLimits, beforeDispatch, options,
		) => {
			// A busy event loop must not make an already-expired deadline eligible
			// for a 101 merely because its timer callback has not run yet.
			if (Date.now() >= connectDeadlineAtMs) expireConnection();
			controller.signal.throwIfAborted();
			signal?.throwIfAborted();
			if (httpEnded) throw new Error('Realtime upgrade is no longer available');
			dispatchPromise ??= new Promise<DashScopeRealtimeNodeDispatch>((resolve, reject) => {
				const onAbort = () => reject(controller.signal.reason);
				controller.signal.addEventListener('abort', onAbort, { once: true });
				// ws installs its frame reader synchronously. Move the bounded raw
				// prefix exactly once, without a reader gap or a second handleUpgrade.
				const prefix = Buffer.concat(buffered, bufferedBytes);
				discardBuffered();
				try {
					websocketServer.handleUpgrade(request, socket, prefix, (accepted) => {
						controller.signal.removeEventListener('abort', onAbort);
						client = accepted;
						resolve(createNodeDashScopeRealtimeDispatch(accepted));
					});
				} catch {
					controller.signal.removeEventListener('abort', onAbort);
					// A throwing handshake may already have written bytes. Do not
					// append a second HTTP response to an uncertain protocol state.
					socket.destroy();
					reject(new Error('Realtime client upgrade failed'));
				}
			});
			const dispatch = await dispatchPromise;
			controller.signal.throwIfAborted();
			const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
			return dispatch(route, operation, requestSignal, timing, attempt, sessionLimits, beforeDispatch, {
				...options, connectDeadlineAtMs: Math.min(options?.connectDeadlineAtMs ?? Infinity, connectDeadlineAtMs),
			});
		};
		// Authentication can contain owned writes (legacy-key migration / lazy
		// reset). Do not race and abandon app.fetch; signal late work to stop,
		// close the transport promptly and observe the handler to completion.
		const response = await app.fetch(fetchRequest, { NODE_REALTIME_DISPATCH: nodeDispatch });
		if (client && response.headers.get('x-octafuse-realtime-upgrade') === '1' && !controller.signal.aborted) {
			clearTimeout(timer);
			return; // The bridge and raw-socket close observer now own cancellation.
		}
		if (client) {
			void response.body?.cancel().catch(() => undefined);
			closeClient(response.status < 500 ? 1008 : 1011, `Realtime request rejected (HTTP ${response.status})`);
			controller.abort(new RequestExecutionStoppedError('client_cancelled'));
			clearTimeout(timer);
			return;
		}
		const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
		let message = `Realtime request rejected (HTTP ${status})`;
		try { message = await responseTextWithinLimit(response, MAX_REJECTION_BYTES, controller.signal) || message; }
		catch { /* Oversized, stalled or invalid bodies never enter close frames. */ }
		if (!controller.signal.aborted) rejectHttp(status, message, response.headers);
	} catch {
		if (client) closeClient(1011, 'Realtime request failed');
		else rejectHttp(500, 'Realtime request failed');
		controller.abort(new RequestExecutionStoppedError('client_cancelled'));
		clearTimeout(timer);
	}
}
