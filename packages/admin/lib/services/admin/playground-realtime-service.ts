/**
 * 调试台的 DashScope 原生 WebSocket 直连：使用管理员会话解析路由，
 * 供应商连接和事件转发都在 Worker 侧完成，因此不会把供应商 API Key 暴露给浏览器，也不写网关用量日志。
 */
import { resolveUpstreamEndpoint } from "@octafuse/core/provider-endpoints";
import {
	mergePlaygroundRequestBody,
	type PlaygroundResolvedRoute,
	resolvePlaygroundRoute,
} from "./playground-service";
import {
	createRequestDeadline,
	RequestExecutionStoppedError,
	type GatewayRepositories,
} from "@octafuse/core";
import { AdminServiceError } from "./errors";
import {
	discardPlaygroundResponse,
	playgroundStoppedError,
	PLAYGROUND_REQUEST_DEADLINE_MS,
} from "./playground-request-lifecycle";
import { safePlaygroundUrl } from "@/lib/playground/private-preview";
import { copyPlaygroundUpstreamHeaders } from "@/lib/playground/proxy-response-headers";

export const PLAYGROUND_DASHSCOPE_REALTIME_OPERATIONS = [
	"audio.transcriptions.realtime.inference",
	"audio.transcriptions.realtime.session",
	"audio.speech.realtime.inference",
] as const;

export type PlaygroundDashScopeRealtimeOperation =
	(typeof PLAYGROUND_DASHSCOPE_REALTIME_OPERATIONS)[number];

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

function eventName(event: JsonObject): string {
	const header = asObject(event.header);
	if (typeof header?.action === "string") return header.action;
	if (typeof header?.event === "string") return header.event;
	return typeof event.type === "string" ? event.type : "";
}

/** 与 Proxy 保持同一模型注入和 custom_params 合并规则。 */
export function rewritePlaygroundRealtimeMessage(
	route: PlaygroundResolvedRoute,
	operation: PlaygroundDashScopeRealtimeOperation,
	message: string
): string {
	let event: JsonObject;
	try {
		const parsed = JSON.parse(message) as unknown;
		const object = asObject(parsed);
		if (!object) return message;
		event = object;
	} catch {
		return message;
	}
	const name = eventName(event);
	const shouldMerge =
		(operation.endsWith(".inference") && name === "run-task") ||
		(operation.endsWith(".session") && name === "session.update");
	if (!shouldMerge) return message;

	const merged = mergePlaygroundRequestBody(route, event);
	if (name === "run-task") {
		const payload = asObject(merged.payload) ?? {};
		merged.payload = { ...payload, model: route.providerModelName };
	}
	return JSON.stringify(merged);
}

function outboundWebSocketFetchUrl(endpoint: string): URL {
	const url = new URL(endpoint);
	if (url.protocol === "wss:") url.protocol = "https:";
	if (url.protocol === "ws:") url.protocol = "http:";
	return url;
}

function realtimeCapability(
	operation: PlaygroundDashScopeRealtimeOperation
): "audio.realtime.inference" | "audio.realtime.session" {
	return operation.endsWith(".inference")
		? "audio.realtime.inference"
		: "audio.realtime.session";
}

function closeSocket(socket: WebSocket, code = 1000, reason = ""): void {
	if (socket.readyState === WebSocket.CLOSED) return;
	const valid =
		[
			1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014,
		].includes(code) ||
		(code >= 3000 && code <= 4999);
	try {
		socket.close(
			valid ? code : 1000,
			new TextDecoder().decode(new TextEncoder().encode(reason).slice(0, 120))
		);
	} catch {
		/* Transport may already be closing. */
	}
}

function isRealtimeOperation(
	value: string
): value is PlaygroundDashScopeRealtimeOperation {
	return (
		PLAYGROUND_DASHSCOPE_REALTIME_OPERATIONS as readonly string[]
	).includes(value);
}

export function preparePlaygroundRealtimeRequest(
	route: PlaygroundResolvedRoute,
	operation: PlaygroundDashScopeRealtimeOperation
): URL {
	if (route.upstreamProtocol !== "dashscope" || !route.isAudioModel)
		throw new AdminServiceError(
			400,
			"Playground realtime routes must use an audio DashScope route"
		);
	if (route.upstreamOperation !== operation)
		throw new AdminServiceError(
			400,
			"Realtime operation must match the selected route"
		);
	const endpoint = resolveUpstreamEndpoint(
		"dashscope",
		realtimeCapability(operation),
		route.providerEndpoints,
		{ providerId: route.providerId }
	);
	const url = outboundWebSocketFetchUrl(endpoint);
	if (operation.endsWith(".session"))
		url.searchParams.set("model", route.providerModelName);
	return url;
}

export type PlaygroundRealtimeDispatchResult = {
	response: Response;
	upstreamUrl: string;
};

/** 解析路由并建立调试台专用的非计费原生 WebSocket。 */
export async function dispatchPlaygroundDashScopeRealtime(
	repos: GatewayRepositories,
	input: { routeId: string; operation: string },
	requestSignal?: AbortSignal
): Promise<PlaygroundRealtimeDispatchResult> {
	const owner = createRequestDeadline(
		Date.now() + PLAYGROUND_REQUEST_DEADLINE_MS,
		requestSignal
	);
	let streaming = false;
	let handedOff = false;
	const openingSockets: WebSocket[] = [];
	let socketAbortCleanup = () => {};
	try {
		owner.throwIfStopped();
		if (!isRealtimeOperation(input.operation)) {
			throw new AdminServiceError(
				400,
				`Unsupported realtime operation: ${input.operation || "(empty)"}`
			);
		}
		const operation = input.operation;
		if (typeof WebSocketPair === "undefined") {
			throw new AdminServiceError(
				501,
				"DashScope realtime requires the Cloudflare Workers runtime"
			);
		}

		const route = await resolvePlaygroundRoute(repos, input.routeId, owner);
		const url = preparePlaygroundRealtimeRequest(route, operation);
		const upstreamResponse = await owner.wait(
			() =>
				fetch(url.toString(), {
					headers: {
						Authorization: `Bearer ${route.providerApiKey}`,
						Upgrade: "websocket",
					},
					signal: owner.signal,
					// A 307/308 must not send a second authenticated upgrade outside this dispatch.
					redirect: "manual",
				}),
			(response) => {
				discardPlaygroundResponse(response);
				if (response.webSocket)
					closeSocket(response.webSocket, 1000, "Playground upgrade cancelled");
			}
		);
		if (upstreamResponse.webSocket)
			openingSockets.push(upstreamResponse.webSocket);
		owner.throwIfStopped();
		const upstreamUrl = safePlaygroundUrl(url.toString(), [
			route.providerApiKey,
		]);
		if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
			void upstreamResponse.body
				?.cancel("playground_realtime_redirect_rejected")
				.catch(() => undefined);
			return {
				response: new Response(
					JSON.stringify({
						error: { message: "Realtime upstream redirected the upgrade" },
					}),
					{
						status: 502,
						headers: {
							"Content-Type": "application/json",
							"Cache-Control": "no-store",
						},
					}
				),
				upstreamUrl,
			};
		}
		const upstream = upstreamResponse.webSocket;
		if (upstreamResponse.status === 101 && !upstream) {
			discardPlaygroundResponse(upstreamResponse);
			throw new AdminServiceError(
				502,
				"Realtime upstream did not provide a WebSocket"
			);
		}
		if (upstreamResponse.status !== 101 || !upstream) {
			streaming = true;
			return {
				response: owner.wrapResponse(
					new Response(upstreamResponse.body, {
						status: upstreamResponse.status,
						statusText: upstreamResponse.statusText,
						headers: copyPlaygroundUpstreamHeaders(upstreamResponse.headers, [
							route.providerApiKey,
						]),
					})
				),
				upstreamUrl,
			};
		}

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		openingSockets.push(client, server);
		server.accept({ allowHalfOpen: true });
		upstream.binaryType = "arraybuffer";
		upstream.accept({ allowHalfOpen: true });
		const cleanup = () => requestSignal?.removeEventListener("abort", onAbort);
		socketAbortCleanup = cleanup;
		const onAbort = () => {
			cleanup();
			closeSocket(server, 1000, "Playground client cancelled");
			closeSocket(upstream, 1000, "Playground client cancelled");
		};
		requestSignal?.addEventListener("abort", onAbort, { once: true });
		if (requestSignal?.aborted) onAbort();

		server.addEventListener("message", (event) => {
			try {
				const data =
					typeof event.data === "string"
						? rewritePlaygroundRealtimeMessage(route, operation, event.data)
						: event.data;
				upstream.send(data);
			} catch {
				closeSocket(server, 1011, "Gateway upstream send failed");
				closeSocket(upstream, 1011, "Gateway upstream send failed");
			}
		});
		upstream.addEventListener("message", (event) => {
			try {
				server.send(event.data);
			} catch {
				closeSocket(server, 1011, "Gateway client send failed");
				closeSocket(upstream, 1011, "Gateway client send failed");
			}
		});
		server.addEventListener("close", (event) => {
			cleanup();
			closeSocket(upstream, event.code, event.reason);
			// allowHalfOpen 下必须显式完成本端 Close 握手，避免调试台连接悬挂。
			closeSocket(server, event.code, event.reason);
		});
		upstream.addEventListener("close", (event) => {
			cleanup();
			closeSocket(server, event.code, event.reason);
		});
		server.addEventListener("error", () => {
			cleanup();
			closeSocket(server, 1011, "Client WebSocket error");
			closeSocket(upstream, 1011, "Client WebSocket error");
		});
		upstream.addEventListener("error", () => {
			cleanup();
			closeSocket(upstream, 1011, "Upstream WebSocket error");
			closeSocket(server, 1011, "Upstream WebSocket error");
		});

		owner.throwIfStopped();
		const response = new Response(null, {
			status: 101,
			webSocket: client,
			headers: {
				"X-Octafuse-Realtime-Protocol": "dashscope-playground",
				"Cache-Control": "private, no-store",
			},
		});
		handedOff = true;
		return {
			response,
			upstreamUrl,
		};
	} catch (error) {
		if (error instanceof RequestExecutionStoppedError)
			throw playgroundStoppedError(error);
		if (error instanceof AdminServiceError) throw error;
		throw new AdminServiceError(
			502,
			"Playground realtime upstream request failed"
		);
	} finally {
		if (!handedOff) {
			socketAbortCleanup();
			for (const socket of openingSockets)
				closeSocket(socket, 1000, "Playground setup stopped");
		}
		await owner.drainOwnedMutations();
		if (!streaming) owner.dispose();
	}
}
