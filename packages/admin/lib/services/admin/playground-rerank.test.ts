import assert from "node:assert/strict";
import test from "node:test";
import { invokePlaygroundUpstream } from "./playground-service";

function rerankRepositories(
	protocol = "openai"
): Parameters<typeof invokePlaygroundUpstream>[0] {
	return {
		routes: {
			async getModelRouteRowById(id: string) {
				return {
					id,
					model_id: "deepseek-reranker",
					provider_id: "deepseek-official",
					provider_model_name: "deepseek-reranker",
					priority: 0,
					status: "active",
					route_group: "default",
					weight: 1,
					price_override: null,
					custom_params: null,
					upstream_protocol: protocol,
					upstream_operation: "rerank",
					adapter: "passthrough",
				};
			},
		},
		providers: {
			async getProvidersByIds(ids: string[]) {
				assert.deepEqual(ids, ["deepseek-official"]);
				return [
					{
						id: "deepseek-official",
						name: "DeepSeek Official",
						api_key: "sk-test-rerank",
						status: "active",
						description: null,
						created_at: "2026-09-05",
						endpoints: JSON.stringify({
							openai: { base: "https://api.example.com/v1" },
						}),
					},
				];
			},
		},
		models: {
			async getModelDetailWithRouteCounts() {
				return {
					id: "deepseek-reranker",
					display_name: "Synthetic reranker",
					vendor: "test",
					context_window: null,
					max_tokens: 0,
					pricing_profile: null,
					tags: "[]",
					description: null,
					metadata: null,
					input_modalities: null,
					released_at: null,
					route_policy: null,
					created_at: "2026-09-05",
					routes_count: 1,
					active_routes_count: 1,
					output_modalities: JSON.stringify(["rerank"]),
				};
			},
		},
	};
}

test("playground sends rerank JSON to the configured OpenAI rerank endpoint", async () => {
	const originalFetch = globalThis.fetch;
	let calledUrl = "";
	let calledBody = "";
	globalThis.fetch = async (input, init) => {
		calledUrl = String(input);
		calledBody = String(init?.body ?? "");
		return new Response(JSON.stringify({ results: [] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};

	try {
		const result = await invokePlaygroundUpstream(rerankRepositories(), {
			routeId: "route-rerank",
			body: {
				query: "capital of France",
				documents: ["Paris", "Berlin"],
				top_n: 1,
			},
		});
		assert.equal(calledUrl, "https://api.example.com/v1/rerank");
		assert.deepEqual(JSON.parse(calledBody), {
			query: "capital of France",
			documents: ["Paris", "Berlin"],
			top_n: 1,
			model: "deepseek-reranker",
		});
		assert.deepEqual(
			JSON.parse(result.upstreamWireBodyJson),
			JSON.parse(calledBody)
		);
		await result.response.body?.cancel();
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("playground rejects rerank routes on non-OpenAI protocols", async () => {
	await assert.rejects(
		invokePlaygroundUpstream(rerankRepositories("anthropic"), {
			routeId: "route-rerank",
			body: { query: "q", documents: ["a"] },
		}),
		/Rerank models require upstream_protocol=openai/
	);
});
