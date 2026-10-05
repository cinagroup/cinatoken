import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type {
	GatewayRepositories,
	ModelWithRouteCountsRow,
	ProviderRow,
} from "@octafuse/core";
import { dispatchPlaygroundDashScopeRealtime } from "./playground-realtime-service";

const originalFetch = globalThis.fetch;
const originalWebSocketPair = Object.getOwnPropertyDescriptor(
	globalThis,
	"WebSocketPair"
);

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalWebSocketPair)
		Object.defineProperty(globalThis, "WebSocketPair", originalWebSocketPair);
	else Reflect.deleteProperty(globalThis, "WebSocketPair");
});

function fixture(): GatewayRepositories {
	const provider: ProviderRow = {
		id: "dashscope-test",
		name: "Synthetic DashScope",
		api_key: "sk-local-only",
		status: "active",
		description: null,
		created_at: "2026-09-25",
		endpoints: JSON.stringify({
			dashscope: { base: "https://dashscope.example.test/api/v1" },
		}),
	};
	const model: ModelWithRouteCountsRow = {
		id: "audio-test",
		display_name: "Synthetic audio",
		vendor: "test",
		context_window: null,
		max_tokens: 128,
		pricing_profile: JSON.stringify({
			audio_billing_mode: "per_second",
			audio: { price_per_second: 0.001 },
		}),
		tags: "[]",
		description: null,
		metadata: null,
		input_modalities: null,
		output_modalities: null,
		released_at: null,
		route_policy: null,
		created_at: "2026-09-25",
		routes_count: 1,
		active_routes_count: 1,
	};
	return {
		routes: {
			async getModelRouteRowById(id: string) {
				return {
					id,
					model_id: model.id,
					provider_id: provider.id,
					provider_model_name: "synthetic-realtime",
					priority: 0,
					status: "active",
					price_override: null,
					custom_params: null,
					upstream_protocol: "dashscope",
					upstream_operation: "audio.transcriptions.realtime.inference",
					adapter: "passthrough",
				};
			},
		},
		providers: {
			async getProvidersByIds(ids: string[]) {
				assert.deepEqual(ids, [provider.id]);
				return [provider];
			},
		},
		models: {
			async getModelDetailWithRouteCounts() {
				return model;
			},
		},
	} as unknown as GatewayRepositories;
}

for (const status of [307, 308])
	test(`Playground realtime HTTP ${status} cannot make a second authenticated upgrade`, async () => {
		// The 307 branch exercises the dispatch path without constructing sockets.
		Object.defineProperty(globalThis, "WebSocketPair", {
			configurable: true,
			value: class {},
		});
		const sent: Array<{ url: string; authorization: string | null }> = [];
		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			sent.push({
				url,
				authorization: new Headers(init?.headers).get("Authorization"),
			});
			if (url === "https://dashscope.example.test/api/v1/realtime-followed") {
				return new Response("second upgrade", { status: 400 });
			}
			const redirect = new Response(null, {
				status,
				headers: {
					Location: "https://dashscope.example.test/api/v1/realtime-followed",
				},
			});
			// Simulate the HTTP client's default 307 following behavior. The
			// production call must explicitly opt out before a credentialed upgrade.
			return init?.redirect === "manual"
				? redirect
				: globalThis.fetch(
						"https://dashscope.example.test/api/v1/realtime-followed",
						init
				  );
		}) as typeof fetch;

		const result = await dispatchPlaygroundDashScopeRealtime(fixture(), {
			routeId: "route-test",
			operation: "audio.transcriptions.realtime.inference",
		});
		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.authorization, "Bearer sk-local-only");
		assert.equal(result.response.status, 502);
		assert.equal(result.response.headers.get("Location"), null);
		assert.match(
			await result.response.text(),
			/Realtime upstream redirected the upgrade/
		);
	});
