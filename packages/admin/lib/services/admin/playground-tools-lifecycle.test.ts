import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { afterEach, test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { GatewayRepositories } from "@octafuse/core";
import { invokePlaygroundTool } from "./playground-tools-service";
import { AdminServiceError } from "./errors";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});
const SECRET = "arbitrary-tool-credential";
function repos(onRead?: () => void): GatewayRepositories {
	const configs = {
		WEB_SEARCH_CATALOG: Object.fromEntries(
			["bocha", "tavily", "cleversee", "tencent_wsa"].map((provider) => [
				provider,
				{ apiKey: SECRET },
			])
		),
		WEB_FETCH_CATALOG: Object.fromEntries(
			["firecrawl", "tavily", "jina"].map((provider) => [
				provider,
				{ apiKey: SECRET },
			])
		),
		WEB_DEEP_SEARCH_CATALOG: Object.fromEntries(
			["firecrawl", "jina"].map((provider) => [provider, { apiKey: SECRET }])
		),
		AI_DETECTION_CATALOG: {
			tencent_tms: { secretId: "local-tms-id", secretKey: SECRET },
		},
	};
	return {
		systemConfig: {
			async getConfig(key: string) {
				onRead?.();
				return JSON.stringify(configs[key as keyof typeof configs]);
			},
		},
	} as unknown as GatewayRepositories;
}
async function until(check: () => boolean) {
	const end = performance.now() + 3000;
	while (!check()) {
		if (performance.now() > end) throw new Error("Local observation timed out");
		await nextTurn();
	}
}
const cancelled = (error: unknown) =>
	error instanceof AdminServiceError && error.status === 499;
const search = {
	toolId: "web-search",
	provider: "bocha",
	body: { query: "synthetic query" },
};

const engines = [
	{
		toolId: "web-search",
		provider: "bocha",
		result: { code: 200, data: { webPages: { value: [] } } },
	},
	{ toolId: "web-search", provider: "tavily", result: { results: [] } },
	{
		toolId: "web-search",
		provider: "cleversee",
		result: { code: 200, data: { result: [] } },
	},
	{
		toolId: "web-search",
		provider: "tencent_wsa",
		result: { Response: { Pages: [] } },
	},
	{
		toolId: "web-fetch",
		provider: "firecrawl",
		result: { success: true, data: { markdown: "synthetic page" } },
	},
	{
		toolId: "web-fetch",
		provider: "tavily",
		result: {
			results: [{ url: "https://example.com", raw_content: "synthetic page" }],
		},
	},
	{
		toolId: "web-fetch",
		provider: "jina",
		result: { data: { content: "synthetic page" } },
	},
	{
		toolId: "web-deep-search",
		provider: "firecrawl",
		result: { success: true, data: [] },
	},
	{ toolId: "web-deep-search", provider: "jina", result: { data: [] } },
	{
		toolId: "ai-detection",
		provider: "tencent_tms",
		result: { Response: { Score: 25, RequestId: "synthetic" } },
	},
];
for (const engine of engines)
	test(`Admin dispatch preserves ${engine.toolId}/${engine.provider} through the existing engine with an owned fetch signal`, async () => {
		let requests = 0;
		globalThis.fetch = async (_url, init) => {
			requests++;
			assert.equal(init?.method, "POST");
			assert.equal(init.redirect, "manual");
			assert.ok(init.signal instanceof AbortSignal);
			assert.equal(init.signal.aborted, false);
			return Response.json(engine.result);
		};
		const result = await invokePlaygroundTool(repos(), {
			toolId: engine.toolId,
			provider: engine.provider,
			body:
				engine.toolId === "web-fetch"
					? { url: "https://example.com" }
					: engine.toolId === "ai-detection"
					? { text: "synthetic content" }
					: { query: "synthetic query" },
		});
		assert.equal(result.response.status, 200);
		assert.equal(requests, 1);
		assert.equal(
			((await result.response.json()) as { playground: boolean }).playground,
			true
		);
		assert.equal(
			JSON.parse(result.upstreamWireBodyJson).mode,
			"playground-direct-engine",
			"metadata labels the engine envelope, not provider wire"
		);
	});

test("pre-cancelled tool does not read config or fetch; invalid domains reject before config read", async () => {
	let reads = 0,
		requests = 0;
	globalThis.fetch = async () => {
		requests++;
		throw new Error("must not send");
	};
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		invokePlaygroundTool(
			repos(() => reads++),
			search,
			controller.signal
		),
		cancelled
	);
	await assert.rejects(
		invokePlaygroundTool(
			repos(() => reads++),
			{ ...search, body: { ...search.body, allowed_domains: [1] } }
		),
		/non-empty strings/u
	);
	assert.equal(reads, 0);
	assert.equal(requests, 0);
});

test("cancel during config read prevents a late read from starting an engine", async () => {
	let finish!: (value: string) => void;
	const pending = new Promise<string>((resolve) => {
		finish = resolve;
	});
	let started = false,
		requests = 0;
	const store = {
		systemConfig: {
			getConfig: () => {
				started = true;
				return pending;
			},
		},
	} as unknown as GatewayRepositories;
	globalThis.fetch = async () => {
		requests++;
		throw new Error("must not send");
	};
	const controller = new AbortController();
	const result = invokePlaygroundTool(store, search, controller.signal);
	await until(() => started);
	controller.abort();
	await assert.rejects(result, cancelled);
	finish('{"bocha":{"apiKey":"late-secret"}}');
	await nextTurn();
	assert.equal(requests, 0);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("tool cancellation cancels an unread, stalled response without waiting for acknowledgement", async () => {
	let headers = false,
		cancelledBody = false;
	const controller = new AbortController();
	globalThis.fetch = async (_url, init) => {
		assert.ok(init?.signal);
		headers = true;
		return new Response(
			new ReadableStream<Uint8Array>({
				pull() {
					return new Promise(() => {});
				},
				cancel() {
					cancelledBody = true;
					return new Promise(() => {});
				},
			}),
			{ headers: { "Content-Type": "application/json" } }
		);
	};
	const result = invokePlaygroundTool(repos(), search, controller.signal);
	await until(() => headers);
	await nextTurn();
	controller.abort();
	await assert.rejects(result, cancelled);
	await until(() => cancelledBody);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("late fetch body is disposed after cancellation; no automatic second provider call", async () => {
	let finish!: (value: Response) => void;
	const pending = new Promise<Response>((resolve) => {
		finish = resolve;
	});
	let started = false,
		discarded = false,
		requests = 0;
	globalThis.fetch = async () => {
		requests++;
		started = true;
		return pending;
	};
	const controller = new AbortController();
	const result = invokePlaygroundTool(repos(), search, controller.signal);
	await until(() => started);
	controller.abort();
	await assert.rejects(result, cancelled);
	finish(
		new Response(
			new ReadableStream({
				cancel() {
					discarded = true;
				},
			})
		)
	);
	await until(() => discarded);
	assert.equal(requests, 1);
});

test("provider credential echoes are redacted and failure keeps unknown upstream outcome", async () => {
	globalThis.fetch = async () =>
		Response.json({ msg: "failed with " + SECRET }, { status: 429 });
	const result = await invokePlaygroundTool(repos(), search);
	assert.equal(result.response.status, 429);
	const body = (await result.response.json()) as {
		error: string;
		upstream_outcome: string;
	};
	assert.doesNotMatch(body.error, new RegExp(SECRET));
	assert.equal(body.upstream_outcome, "unknown");
	assert.equal(
		result.response.headers.get("x-playground-upstream-outcome"),
		"unknown"
	);
});

test("tool absolute deadline bounds a stalled engine transport without retrying", async () => {
	const timer = globalThis.setTimeout;
	const now = Date.now;
	let elapsed = 0;
	let requests = 0;
	Date.now = () => now() + elapsed;
	globalThis.setTimeout = ((
		callback: (...args: unknown[]) => void,
		delay?: number,
		...args: unknown[]
	) =>
		delay && delay > 299_000 && delay <= 300_000
			? timer(() => {
					elapsed = 300_001;
					callback(...args);
			  }, 5)
			: timer(callback, delay, ...args)) as typeof setTimeout;
	globalThis.fetch = async () => {
		requests++;
		return new Promise(() => {});
	};
	try {
		await assert.rejects(
			invokePlaygroundTool(repos(), search),
			(error) => error instanceof AdminServiceError && error.status === 504
		);
		assert.equal(requests, 1);
	} finally {
		globalThis.setTimeout = timer;
		Date.now = now;
	}
});
