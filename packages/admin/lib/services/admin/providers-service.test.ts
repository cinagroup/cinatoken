import { createProviderService, revealProviderApiKeyService, updateProviderService } from './providers-service';

import { AdminServiceError } from './errors';
import assert from "node:assert/strict";
import { before, after, describe, it, mock } from "node:test";
import type { GatewayRepositories } from "@octafuse/core";
import { listStaticProviderImportPresets } from "@/lib/catalog/provider-catalog-fixture";
import { localProviderRows } from "@/lib/catalog/local-provider-catalog";

// Exercise runtime catalog loading without depending on the public service.
before(() => { mock.method(globalThis, "fetch", async () => Response.json(localProviderRows)); });
after(() => { mock.restoreAll(); });
import { importProvidersFromStaticPresetsService } from "./providers-service";
import { applyProviderSyncService } from "./provider-sync-service";

type InsertedProvider = {
	id: string;
	name: string;
	apiKey: string;
	status: string;
	sharedChannelType: string | null;
	endpoints: string | null;
 customParams?: string | null;
};

it("a failed sync item can retain an endpoint update when subsequent policy invalidation throws", async () => {
	const original = JSON.stringify({
		openai: { base: "https://old.example.invalid/v1" },
	});
	let storedEndpoints = original;
	const events: string[] = [];
	const updates: Array<Record<string, unknown>> = [];
	const repos = {
		providers: {
			getProviderRowById: async () => ({
				id: "sync-partial-provider",
				name: "Existing provider",
				kind: "DeepSeek",
				description: null,
				endpoints: storedEndpoints,
			}),
			updateProviderByPatch: async (
				id: string,
				patch: Record<string, unknown>,
			) => {
				assert.equal(id, "sync-partial-provider");
				assert.equal(typeof patch.endpoints, "string");
				events.push("provider.update");
				updates.push({ ...patch });
				storedEndpoints = String(patch.endpoints);
				return 1;
			},
		},
		routeDataPolicies: {
			invalidateForProvider: async (id: string) => {
				assert.equal(id, "sync-partial-provider");
				assert.notEqual(storedEndpoints, original);
				events.push("policy.invalidate");
				throw new Error("Synthetic policy invalidation failure");
			},
		},
	} as unknown as GatewayRepositories;
	const result = await applyProviderSyncService(
		repos,
		{
			items: [
				{ provider_id: "sync-partial-provider", fields: ["endpoints.openai"] },
			],
		},
		"console:sync-test",
	);
	assert.deepEqual(events, ["provider.update", "policy.invalidate"]);
	assert.equal(updates.length, 1);
	assert.deepEqual(Object.keys(updates[0]!), ["endpoints"]);
	assert.match(storedEndpoints, /api\.deepseek\.com/u);
	assert.deepEqual(result, {
		updated: 0,
		skipped: 0,
		failed: [
			{
				provider_id: "sync-partial-provider",
				message: "Synthetic policy invalidation failure",
			},
		],
	});
	// The batch reports a failed completion, not proof that the write never happened.
	assert.notEqual(storedEndpoints, original);
});

function repositories(options: { existingIds?: readonly string[] } = {}): {
	repositories: GatewayRepositories;
	inserted: InsertedProvider[];
} {
	const existingIds = new Set(options.existingIds ?? []);
	const inserted: InsertedProvider[] = [];
	return {
		repositories: {
			providers: {
				listProviders: async () => [],
				providerIdExists: async (id: string) => existingIds.has(id),
				insertProvider: async (params: InsertedProvider) => {
					inserted.push(params);
					existingIds.add(params.id);
				},
			},
		} as unknown as GatewayRepositories,
		inserted,
	};
}

function deepSeekCatalogKey(): string {
	const preset = listStaticProviderImportPresets().find(
		(row) => row.name === "DeepSeek",
	);
	assert.ok(preset);
	return preset.catalog_key;
}

describe("managed Provider preset import", () => {
	it("installs the official DeepSeek provider with an environment reference, never the secret", async () => {
		const store = repositories();
		const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			requests.push({ url: String(input), init });
			return Response.json({ object: "list", data: [] });
		};
		const result = await importProvidersFromStaticPresetsService(
			store.repositories,
			{
				ids: [deepSeekCatalogKey()],
				environmentApiKeys: { DEEPSEEK_API_KEY: " sk-runtime-secret " },
				fetchImpl,
			},
		);

		assert.deepEqual(result, {
			created: 1,
			updated: 0,
			skipped_existing: [],
			failed: [],
		});
		assert.equal(store.inserted.length, 1);
		assert.equal(store.inserted[0]?.id, "deepseek-official");
		assert.equal(store.inserted[0]?.apiKey, "env:DEEPSEEK_API_KEY");
		assert.equal(store.inserted[0]?.status, "active");
		assert.equal(store.inserted[0]?.sharedChannelType, null);
		assert.match(store.inserted[0]?.endpoints ?? "", /api\.deepseek\.com/u);
		assert.doesNotMatch(JSON.stringify(store.inserted), /sk-runtime-secret/u);
		assert.equal(requests.length, 1);
		assert.equal(requests[0]?.url, "https://api.deepseek.com/models");
		assert.equal(requests[0]?.init?.method, "GET");
		assert.equal(requests[0]?.init?.redirect, "error");
		assert.ok(requests[0]?.init?.signal instanceof AbortSignal);
		assert.equal(
			new Headers(requests[0]?.init?.headers).get("Authorization"),
			"Bearer sk-runtime-secret",
		);
	});

	it("fails closed as disabled when the Admin runtime secret is absent", async () => {
		const store = repositories();
		let requests = 0;
		await importProvidersFromStaticPresetsService(store.repositories, {
			ids: [deepSeekCatalogKey()],
			fetchImpl: async () => {
				requests += 1;
				return Response.json({ object: "list", data: [] });
			},
		});

		assert.equal(store.inserted[0]?.apiKey, "env:DEEPSEEK_API_KEY");
		assert.equal(store.inserted[0]?.status, "disabled");
		assert.equal(requests, 0);
	});

	it("fails closed as disabled when DeepSeek rejects the Secret", async () => {
		const store = repositories();
		await importProvidersFromStaticPresetsService(store.repositories, {
			ids: [deepSeekCatalogKey()],
			environmentApiKeys: { DEEPSEEK_API_KEY: "sk-invalid" },
			fetchImpl: async () =>
				Response.json(
					{ error: { message: "Authentication failed" } },
					{ status: 401 },
				),
		});

		assert.equal(store.inserted[0]?.status, "disabled");
		assert.doesNotMatch(JSON.stringify(store.inserted), /sk-invalid/u);
	});

	it("fails closed as disabled when the validation request fails", async () => {
		const store = repositories();
		await importProvidersFromStaticPresetsService(store.repositories, {
			ids: [deepSeekCatalogKey()],
			environmentApiKeys: { DEEPSEEK_API_KEY: "sk-runtime-secret" },
			fetchImpl: async () => {
				throw new TypeError("network unavailable");
			},
		});

		assert.equal(store.inserted[0]?.status, "disabled");
	});

	it("is idempotent for the deterministic official Provider id", async () => {
		const store = repositories({ existingIds: ["deepseek-official"] });
		const catalogKey = deepSeekCatalogKey();
		let requests = 0;
		const result = await importProvidersFromStaticPresetsService(
			store.repositories,
			{
				ids: [catalogKey],
				environmentApiKeys: { DEEPSEEK_API_KEY: "sk-runtime-secret" },
				fetchImpl: async () => {
					requests += 1;
					return Response.json({ object: "list", data: [] });
				},
			},
		);

		assert.equal(result.created, 0);
		assert.deepEqual(result.skipped_existing, [catalogKey]);
		assert.deepEqual(result.failed, []);
		assert.deepEqual(store.inserted, []);
		assert.equal(requests, 0);
	});
});


describe('provider API key update semantics', () => {
	it('preserves the credential when the PATCH omits api_key', async () => {
		const { repos, row, patches } = mutationRepositories();
		await updateProviderService(repos, 'p1', { name: 'Renamed' }, 'console:provider-test');
		assert.equal(row.api_key, 'original-key');
		assert.equal(row.name, 'Renamed');
		assert.equal(Object.hasOwn(patches[0], 'api_key'), false);
	});

	for (const value of ['', '  \n\t ', null]) {
		it(`clears an explicitly provided ${JSON.stringify(
			value
		)} credential`, async () => {
			const { repos, row, patches } = mutationRepositories();
			await updateProviderService(repos, 'p1', { api_key: value }, 'console:provider-test');
			assert.deepEqual(patches, [{ api_key: '' }]);
			assert.equal(row.api_key, '');
			assert.equal(row.status, 'active');
		});
	}

	it('trims and replaces a non-empty credential', async () => {
		const { repos, row } = mutationRepositories();
		await updateProviderService(repos, 'p1', {
			api_key: '  replacement-key  ',
		}, 'console:provider-test');
		assert.equal(row.api_key, 'replacement-key');
	});

	it('can read back an explicitly cleared credential as an empty string', async () => {
		const { repos } = mutationRepositories();
		await updateProviderService(repos, 'p1', { api_key: '' }, 'console:provider-test');
		assert.deepEqual(await revealProviderApiKeyService(repos, 'p1'), {
			api_key: '',
		});
	});

	it('keeps an empty PATCH as a no-op', async () => {
		const { repos, patches } = mutationRepositories();
		await updateProviderService(repos, 'p1', {}, 'console:provider-test');
		assert.deepEqual(patches, []);
	});

	it('returns 404 for an unknown provider without writing anything', async () => {
		const { repos, patches } = mutationRepositories();
		await assert.rejects(
			updateProviderService(repos, 'missing', { api_key: '' }, 'console:provider-test'),
			(error: unknown) =>
				error instanceof AdminServiceError && error.status === 404
		);
		assert.deepEqual(patches, []);
	});

	it('still requires a non-empty credential when creating a provider', async () => {
		const { repos, patches } = mutationRepositories();
		await assert.rejects(
			createProviderService(repos, {
				name: 'New',
				kind: '__custom__',
				api_key: '',
			}),
			/api_key is required/
		);
		assert.deepEqual(patches, []);
	});
});


describe('provider custom_params write/read semantics', () => {
	it('normalizes and persists a valid per-protocol custom_params on create', async () => {
		const { repos, inserted } = mutationRepositories();
		await createProviderService(repos, {
			name: 'New',
			kind: '__custom__',
			api_key: 'sk-test',
			custom_params: {
				openai: { headers: { 'X-Title': 'App' }, body: { max_tokens: 4096 } },
			},
		});
		assert.equal(inserted.length, 1);
		assert.deepEqual(
			JSON.parse(inserted[0].customParams as string),
			{ openai: { headers: { 'X-Title': 'App' }, body: { max_tokens: 4096 } } }
		);
	});

	it('omits custom_params on create when not provided', async () => {
		const { repos, inserted } = mutationRepositories();
		await createProviderService(repos, { name: 'New', kind: '__custom__', api_key: 'sk-test' });
		assert.equal(inserted[0].customParams, null);
	});

	it('leaves custom_params untouched when the PATCH omits it', async () => {
		const { repos, patches } = mutationRepositories();
		await updateProviderService(repos, 'p1', { name: 'Renamed' }, 'console:provider-test');
		assert.equal(Object.hasOwn(patches[0], 'custom_params'), false);
	});

	it('clears custom_params when the PATCH sets it to null', async () => {
		const { repos, patches } = mutationRepositories();
		await updateProviderService(repos, 'p1', { custom_params: null }, 'console:provider-test');
		assert.deepEqual(patches, [{ custom_params: null }]);
	});

	it('rejects a protected header in custom_params with a 400', async () => {
		const { repos } = mutationRepositories();
		await assert.rejects(
			updateProviderService(repos, 'p1', {
				custom_params: { openai: { headers: { Authorization: 'Bearer x' } } },
			}, 'console:provider-test'),
			(error: unknown) => error instanceof AdminServiceError && error.status === 400
		);
	});

	it('rejects an unknown protocol key in custom_params with a 400', async () => {
		const { repos } = mutationRepositories();
		await assert.rejects(
			updateProviderService(repos, 'p1', {
				custom_params: { not_a_protocol: { body: { a: 1 } } },
			}, 'console:provider-test'),
			(error: unknown) => error instanceof AdminServiceError && error.status === 400
		);
	});
});

function mutationRepositories() {
	const row: Record<string, unknown> = {
		id: 'p1',
		name: 'Provider',
		api_key: 'original-key',
		status: 'active',
	};
	const patches: Record<string, unknown>[] = [];
	const inserted: Record<string, unknown>[] = [];
	const repos = {
  routeDataPolicies:{invalidateForProvider:async(id:string)=>{assert.equal(id,'p1');return 1;}},
		providers: {
			getProviderRowById: async (id: string) =>
				id === 'p1' ? { ...row } : null,
			getProviderApiKeyPlaintext: async () => ({ api_key: row.api_key }),
			updateProviderByPatch: async (
				id: string,
				patch: Record<string, unknown>
			) => {
				assert.equal(id, 'p1');
				patches.push(patch);
				Object.assign(row, patch);
				return 1;
			},
			insertProvider: async (params: Record<string, unknown>) => {
				inserted.push(params);
			},
			providerIdExists: async () => false,
		},
	} as unknown as GatewayRepositories;
	return { repos, row, patches, inserted };
}
