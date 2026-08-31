import assert from "node:assert/strict";
import test from "node:test";
import type { ProvidersRepository } from "../storage/gateway-repository-interfaces";
import type { ProviderRow } from "../types";
import {
	createEnvironmentProviderKeysRepository,
	formatProviderApiKeyEnvironmentReference,
	parseProviderApiKeyEnvironmentReference,
} from "./provider-key-environment";

const DEEPSEEK_ENDPOINTS = JSON.stringify({
	openai: {
		endpoints: {
			chat: "https://api.deepseek.com/chat/completions",
			responses: "https://api.deepseek.com/responses",
		},
	},
	anthropic: { base: "https://api.deepseek.com/anthropic" },
});

function provider(overrides: Partial<ProviderRow> = {}): ProviderRow {
	return {
		id: "deepseek-official",
		name: "DeepSeek Official",
		endpoints: DEEPSEEK_ENDPOINTS,
		api_key: "env:DEEPSEEK_API_KEY",
		status: "active",
		description: null,
		shared_channel_type: null,
		created_at: "2026-08-31T00:00:00.000Z",
		...overrides,
	};
}

function repositoryFor(row: ProviderRow): ProvidersRepository {
	return {
		async listProviders() { return [row as never]; },
		async getProvidersByIds(ids) { return ids.includes(row.id) ? [row] : []; },
		async providerIdExists(id) { return id === row.id; },
		async insertProvider() {},
		async updateProviderByPatch() { return 0; },
		async deleteProviderById() { return 0; },
		async getProviderById(id) { return id === row.id ? row : null; },
		async getProviderRowById(id) { return id === row.id ? row as never : null; },
		async getProviderProtocolBases() { return null; },
		async getProviderApiKeyPlaintext(id) {
			return id === row.id ? { api_key: row.api_key ?? "" } : null;
		},
	};
}

const POLICY = [{
	providerId: "deepseek-official",
	envName: "DEEPSEEK_API_KEY",
	allowedEndpointHosts: ["api.deepseek.com"],
}] as const;

test("provider environment references validate and round-trip", () => {
	assert.equal(
		formatProviderApiKeyEnvironmentReference(" DEEPSEEK_API_KEY "),
		"env:DEEPSEEK_API_KEY"
	);
	assert.equal(
		parseProviderApiKeyEnvironmentReference("env:DEEPSEEK_API_KEY"),
		"DEEPSEEK_API_KEY"
	);
	assert.throws(
		() => formatProviderApiKeyEnvironmentReference("deepseek-api-key"),
		/environment name is invalid/
	);
});

test("runtime Provider reads resolve the approved DeepSeek binding", async () => {
	const wrapped = createEnvironmentProviderKeysRepository(repositoryFor(provider()), {
		policies: POLICY,
		secrets: { DEEPSEEK_API_KEY: "  sk-runtime-deepseek  " },
	});

	assert.equal((await wrapped.getProviderById("deepseek-official"))?.api_key, "sk-runtime-deepseek");
	assert.equal((await wrapped.getProvidersByIds(["deepseek-official"]))[0]?.api_key, "sk-runtime-deepseek");
	assert.equal(
		(await wrapped.getProviderApiKeyPlaintext("deepseek-official"))?.api_key,
		"env:DEEPSEEK_API_KEY",
		"Admin reveal preserves the non-secret reference"
	);
});

test("missing, redirected, or misbound environment references fail closed", async () => {
	for (const row of [
		provider(),
		provider({ id: "attacker-controlled-provider" }),
		provider({ endpoints: JSON.stringify({ openai: { base: "https://example.com/v1" } }) }),
	]) {
		const secrets = row.id === "deepseek-official" && row.endpoints === DEEPSEEK_ENDPOINTS
			? {}
			: { DEEPSEEK_API_KEY: "sk-must-not-leak" };
		const wrapped = createEnvironmentProviderKeysRepository(repositoryFor(row), {
			policies: POLICY,
			secrets,
		});
		assert.equal((await wrapped.getProviderById(row.id))?.api_key, "");
	}
});
