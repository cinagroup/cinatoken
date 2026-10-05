import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { afterEach, test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { GatewayRepositories } from "@octafuse/core";
import { createAdminApp } from "@/lib/admin-app";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPrincipal } from "@/lib/admin-principal";
import { dispatchPlaygroundDashScopeRealtime } from "./playground-realtime-service";
import { AdminServiceError } from "./errors";

const nativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
const originalPair = Object.getOwnPropertyDescriptor(
	globalThis,
	"WebSocketPair"
);
afterEach(() => {
	globalThis.Response = nativeResponse;
	globalThis.fetch = nativeFetch;
	if (originalPair)
		Object.defineProperty(globalThis, "WebSocketPair", originalPair);
	else Reflect.deleteProperty(globalThis, "WebSocketPair");
});
const operation = "audio.transcriptions.realtime.inference";
function fixture(operationOverride = operation) {
	let reads = 0;
	const repos = {
		routes: {
			async getModelRouteRowById() {
				reads++;
				return {
					id: "realtime-route",
					model_id: "audio",
					provider_id: "provider",
					provider_model_name: "upstream-audio",
					upstream_protocol: "dashscope",
					upstream_operation: operationOverride,
					adapter: "passthrough",
					custom_params: '{"payload":{"parameters":{"sample_rate":16000}}}',
					status: "disabled",
					price_override: null,
					priority: 0,
				};
			},
		},
		providers: {
			async getProvidersByIds() {
				return [
					{
						id: "provider",
						api_key: "local-opaque-secret",
						status: "active",
						endpoints:
							'{"dashscope":{"base":"https://dashscope.example.invalid/api/v1"}}',
					},
				];
			},
		},
		models: {
			async getModelDetailWithRouteCounts() {
				return {
					input_modalities: '["audio"]',
					output_modalities: '["transcription"]',
				};
			},
		},
	} as unknown as GatewayRepositories;
	return { repos, reads: () => reads };
}
class Socket extends EventTarget {
	readyState = 1;
	binaryType = "";
	sent: unknown[] = [];
	accept() {
		/* Native Worker accept is represented by this local harness. */
	}
	send(data: unknown) {
		if (this.readyState !== 1) throw new Error("closed");
		this.sent.push(data);
	}
	close(code = 1000, reason = "") {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
	}
	message(data: unknown) {
		this.dispatchEvent(Object.assign(new Event("message"), { data }));
	}
}
/** A protocol harness, not a claim that Node implements native 101/WebSocketPair. */
function workerHarness() {
	const upstream = new Socket(),
		client = new Socket(),
		server = new Socket();
	Object.defineProperty(globalThis, "WebSocketPair", {
		configurable: true,
		value: class {
			0 = client;
			1 = server;
		},
	});
	globalThis.Response = class extends nativeResponse {
		constructor(body?: BodyInit | null, init?: ResponseInit) {
			super(body, init?.status === 101 ? { ...init, status: 200 } : init);
			if (init?.status === 101) {
				Object.defineProperty(this, "status", { value: 101 });
				Object.defineProperty(this, "webSocket", { value: init.webSocket });
			}
		}
	} as typeof Response;
	const upgraded = () =>
		new Response(null, {
			status: 101,
			webSocket: upstream as unknown as WebSocket,
		});
	return { upstream, client, server, upgraded };
}
async function until(check: () => boolean) {
	const deadline = performance.now() + 3000;
	while (!check()) {
		if (performance.now() > deadline)
			throw new Error("Local observation timeout");
		await nextTurn();
	}
}
const status = (expected: number) => (error: unknown) =>
	error instanceof AdminServiceError && error.status === expected;

test("Node realtime remains 501 and a pre-cancelled request never reads the route", async () => {
	Reflect.deleteProperty(globalThis, "WebSocketPair");
	const f = fixture();
	await assert.rejects(
		dispatchPlaygroundDashScopeRealtime(f.repos, {
			routeId: "realtime-route",
			operation,
		}),
		status(501)
	);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		dispatchPlaygroundDashScopeRealtime(
			f.repos,
			{ routeId: "realtime-route", operation },
			controller.signal
		),
		status(499)
	);
	assert.equal(f.reads(), 0);
});

test("realtime operation mismatch cannot send an authenticated upgrade", async () => {
	workerHarness();
	const f = fixture("audio.speech.realtime.inference");
	let requests = 0;
	globalThis.fetch = async () => {
		requests++;
		throw new Error("must not send");
	};
	await assert.rejects(
		dispatchPlaygroundDashScopeRealtime(f.repos, {
			routeId: "realtime-route",
			operation,
		}),
		status(400)
	);
	assert.equal(requests, 0);
});

test("local realtime protocol harness preserves bidirectional binary, model injection and request-abort cleanup", async () => {
	const h = workerHarness(),
		f = fixture(),
		controller = new AbortController();
	globalThis.fetch = async (_url, init) => {
		assert.equal(init?.redirect, "manual");
		assert.equal(init.signal?.aborted, false);
		assert.equal(
			new Headers(init.headers).get("sec-websocket-protocol"),
			null,
			"Console preconditions never reach provider"
		);
		return h.upgraded();
	};
	const result = await dispatchPlaygroundDashScopeRealtime(
		f.repos,
		{ routeId: "realtime-route", operation },
		controller.signal
	);
	assert.equal(result.response.status, 101);
	assert.equal(result.response.webSocket, h.client);
	h.server.message(
		'{"header":{"action":"run-task"},"payload":{"model":"wrong","parameters":{"format":"pcm"}}}'
	);
	const wire = JSON.parse(h.upstream.sent[0] as string) as {
		payload: { model: string; parameters: object };
	};
	assert.equal(wire.payload.model, "upstream-audio");
	assert.deepEqual(wire.payload.parameters, {
		sample_rate: 16000,
		format: "pcm",
	});
	const binary = new Uint8Array([3, 4]).buffer;
	h.server.message(binary);
	assert.equal(h.upstream.sent[1], binary);
	h.upstream.message(binary);
	assert.equal(h.server.sent[0], binary);
	controller.abort();
	assert.equal(h.server.readyState, 3);
	assert.equal(h.upstream.readyState, 3);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("late upgraded socket is closed after cancellation and transport failures cannot reflect credentials", async () => {
	const h = workerHarness(),
		f = fixture(),
		controller = new AbortController();
	let finish!: (value: Response) => void;
	const pending = new Promise<Response>((resolve) => {
		finish = resolve;
	});
	let sent = false;
	globalThis.fetch = async () => {
		sent = true;
		return pending;
	};
	const response = dispatchPlaygroundDashScopeRealtime(
		f.repos,
		{ routeId: "realtime-route", operation },
		controller.signal
	);
	await until(() => sent);
	controller.abort();
	await assert.rejects(response, status(499));
	finish(h.upgraded());
	await until(() => h.upstream.readyState === 3);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	globalThis.fetch = async () => {
		throw new Error("provider local-opaque-secret in signed URL");
	};
	await assert.rejects(
		dispatchPlaygroundDashScopeRealtime(f.repos, {
			routeId: "realtime-route",
			operation,
		}),
		(error) =>
			status(502)(error) && !String(error).includes("local-opaque-secret")
	);
});

test("failed realtime pair setup closes the already upgraded provider socket and cannot return fake 101", async () => {
	const h = workerHarness(),
		f = fixture();
	Object.defineProperty(globalThis, "WebSocketPair", {
		configurable: true,
		value: class {
			constructor() {
				throw new Error("synthetic pair unavailable");
			}
		},
	});
	globalThis.fetch = async () => h.upgraded();
	await assert.rejects(
		dispatchPlaygroundDashScopeRealtime(f.repos, {
			routeId: "realtime-route",
			operation,
		}),
		status(502)
	);
	assert.equal(h.upstream.readyState, 3);
	globalThis.fetch = async () => new Response(null, { status: 101 });
	await assert.rejects(
		dispatchPlaygroundDashScopeRealtime(f.repos, {
			routeId: "realtime-route",
			operation,
		}),
		status(502)
	);
});

test("Console realtime rejects cross-site Origin and changed subject before preparation; same-origin Node honestly returns 501", async () => {
	Reflect.deleteProperty(globalThis, "WebSocketPair");
	const f = fixture(),
		app = createAdminApp();
	const principal: AdminPrincipal = {
		type: "console",
		id: "console:cinaauth:local-subject",
		username: "cinaauth:local-subject",
	};
	const bindings = {
		STORAGE_CONTEXT: { repositories: f.repos },
		ADMIN_PRINCIPAL: principal,
	} as unknown as AdminBindings;
	const url =
		"https://admin.example.invalid/admin/playground/realtime?routeId=realtime-route&operation=" +
		operation;
	for (const origin of ["https://other.example.invalid", undefined]) {
		const response = await app.request(
			url,
			{
				headers: {
					Upgrade: "websocket",
					...(origin ? { Origin: origin } : {}),
				},
			},
			bindings
		);
		assert.equal(response.status, 403);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
	}
	const token = btoa("different-subject").replace(/=+$/u, "");
	const mismatch = await app.request(
		url,
		{
			headers: {
				Upgrade: "websocket",
				Origin: "https://admin.example.invalid",
				"Sec-WebSocket-Protocol":
					"cinatoken-playground, cinatoken-playground-subject." + token,
			},
		},
		bindings
	);
	assert.equal(mismatch.status, 403);
	const response = await app.request(
		url,
		{
			headers: {
				Upgrade: "websocket",
				Origin: "https://admin.example.invalid",
			},
		},
		bindings
	);
	assert.equal(response.status, 501);
	assert.equal(f.reads(), 0);
});
