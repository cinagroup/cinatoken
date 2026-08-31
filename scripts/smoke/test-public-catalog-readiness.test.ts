import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkPublicCatalogReadiness } from './test-public-catalog-readiness';

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

const OPENROUTER_MODEL = {
	id: 'vendor/model',
	canonical_slug: 'vendor/model',
	hugging_face_id: null,
	name: 'Model',
	created: null,
	description: '',
	context_length: 128_000,
	architecture: {
		modality: 'text->text',
		input_modalities: ['text'],
		output_modalities: ['text'],
		tokenizer: null,
		instruct_type: null,
	},
	pricing: {},
	top_provider: null,
	per_request_limits: null,
	supported_parameters: [],
	default_parameters: {},
	supported_voices: null,
	knowledge_cutoff: null,
	expiration_date: null,
	links: { details: '/api/v1/models/vendor/model/endpoints' },
	reasoning: null,
};

const OPENROUTER_PROVIDER = {
	slug: 'provider',
	name: 'Provider',
	privacy_policy_url: null,
	terms_of_service_url: null,
	status_page_url: null,
	headquarters: null,
	datacenters: null,
};

function readyFetch(overrides: Record<string, Response> = {}): typeof fetch {
	const responses: Record<string, Response> = {
		'/health': json({ status: 'ok' }),
		'/catalog/models': json({ data: [{ id: 'vendor/model' }] }),
		'/catalog/providers': json({ data: [{ id: 'provider' }] }),
		'/api/v1/models': json({
			data: [OPENROUTER_MODEL],
			total_count: 1,
			links: { next: null },
		}),
		'/api/v1/providers': json({ data: [OPENROUTER_PROVIDER] }),
		'/v1/providers': json({ data: [OPENROUTER_PROVIDER] }),
		'/api/v1/models/vendor/model/endpoints': json({
			data: {
				id: 'vendor/model',
				endpoints: [{
					name: 'Provider: Model',
					provider_name: 'Provider',
					model_id: 'vendor/model',
					status: 0,
				}],
			},
		}),
		...overrides,
	};
	return (async (input) => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
		const response = responses[url.pathname];
		if (!response) return json({ error: 'not found' }, 404);
		return response.clone();
	}) as typeof fetch;
}

describe('public catalog production readiness', () => {
	it('proves anonymous catalog, compatibility aliases, and a verified endpoint are published', async () => {
		const result = await checkPublicCatalogReadiness({
			baseUrl: 'https://api.cinatoken.test/',
			fetchImpl: readyFetch(),
		});
		assert.deepEqual(result, {
			base_url: 'https://api.cinatoken.test',
			model_count: 1,
			provider_count: 1,
			canonical_model_count: 1,
			canonical_provider_count: 1,
			sampled_model_id: 'vendor/model',
			sampled_endpoint_count: 1,
		});
	});

	it('fails closed when the production catalog is empty', async () => {
		await assert.rejects(
			checkPublicCatalogReadiness({
				baseUrl: 'https://api.cinatoken.test',
				fetchImpl: readyFetch({ '/catalog/models': json({ data: [] }) }),
			}),
			/public catalog has 0 models/u,
		);
	});

	it('fails when the canonical compatibility surface still requires a key', async () => {
		await assert.rejects(
			checkPublicCatalogReadiness({
				baseUrl: 'https://api.cinatoken.test',
				fetchImpl: readyFetch({ '/api/v1/models': json({ error: 'unauthorized' }, 401) }),
			}),
			/GET \/api\/v1\/models failed: HTTP 401/u,
		);
	});

	it('fails when a published model has no verified endpoint', async () => {
		await assert.rejects(
			checkPublicCatalogReadiness({
				baseUrl: 'https://api.cinatoken.test',
				fetchImpl: readyFetch({
					'/api/v1/models/vendor/model/endpoints': json({ data: { id: 'vendor/model', endpoints: [] } }),
				}),
			}),
			/has no published verified endpoints/u,
		);
	});

	it('fails when legacy and canonical catalogs refer to different models', async () => {
		await assert.rejects(
			checkPublicCatalogReadiness({
				baseUrl: 'https://api.cinatoken.test',
				fetchImpl: readyFetch({
					'/catalog/models': json({ data: [{ id: 'internal-model' }] }),
				}),
			}),
			/OpenRouter model vendor\/model is missing from GET \/catalog\/models/u,
		);
	});

	it('fails when the /v1/providers alias diverges from the canonical provider list', async () => {
		await assert.rejects(
			checkPublicCatalogReadiness({
				baseUrl: 'https://api.cinatoken.test',
				fetchImpl: readyFetch({
					'/v1/providers': json({
						data: [{ ...OPENROUTER_PROVIDER, name: 'Different Provider' }],
					}),
				}),
			}),
			/must publish the same provider identities/u,
		);
	});

	it('fails when model detail links or endpoint identity references are inconsistent', async () => {
		await assert.rejects(
			checkPublicCatalogReadiness({
				baseUrl: 'https://api.cinatoken.test',
				fetchImpl: readyFetch({
					'/api/v1/models': json({
						data: [{ ...OPENROUTER_MODEL, links: { details: '/wrong' } }],
						total_count: 1,
						links: { next: null },
					}),
				}),
			}),
			/links\.details must equal/u,
		);

		for (const endpoint of [
			{
				name: 'Provider: Model',
				provider_name: 'Provider',
				model_id: 'other/model',
				status: 0,
			},
			{
				name: 'Provider: Model',
				provider_name: 'Unpublished Provider',
				model_id: 'vendor/model',
				status: 0,
			},
		]) {
			await assert.rejects(
				checkPublicCatalogReadiness({
					baseUrl: 'https://api.cinatoken.test',
					fetchImpl: readyFetch({
						'/api/v1/models/vendor/model/endpoints': json({
							data: { id: 'vendor/model', endpoints: [endpoint] },
						}),
					}),
				}),
				/(model_id is inconsistent|provider_name is not published)/u,
			);
		}
	});

	it('rejects an incomplete OpenRouter model and top-level pagination contract', async () => {
		for (const field of ['architecture', 'pricing', 'top_provider', 'supported_parameters']) {
			const model = { ...OPENROUTER_MODEL } as Record<string, unknown>;
			delete model[field];
			await assert.rejects(
				checkPublicCatalogReadiness({
					baseUrl: 'https://api.cinatoken.test',
					fetchImpl: readyFetch({
						'/api/v1/models': json({
							data: [model],
							total_count: 1,
							links: { next: null },
						}),
					}),
				}),
				new RegExp(`must include ${field}`, 'u'),
			);
		}

		for (const body of [
			{ data: [OPENROUTER_MODEL], links: { next: null } },
			{ data: [OPENROUTER_MODEL], total_count: 1 },
		]) {
			await assert.rejects(
				checkPublicCatalogReadiness({
					baseUrl: 'https://api.cinatoken.test',
					fetchImpl: readyFetch({ '/api/v1/models': json(body) }),
				}),
				/GET \/api\/v1\/models must include (total_count|links)/u,
			);
		}
	});

	it('rejects incomplete Provider DTOs and endpoints without status', async () => {
		const provider = { ...OPENROUTER_PROVIDER } as Record<string, unknown>;
		delete provider.datacenters;
		await assert.rejects(
			checkPublicCatalogReadiness({
				baseUrl: 'https://api.cinatoken.test',
				fetchImpl: readyFetch({
					'/api/v1/providers': json({ data: [provider] }),
				}),
			}),
			/must include datacenters/u,
		);

		await assert.rejects(
			checkPublicCatalogReadiness({
				baseUrl: 'https://api.cinatoken.test',
				fetchImpl: readyFetch({
					'/api/v1/models/vendor/model/endpoints': json({
						data: {
							id: 'vendor/model',
							endpoints: [{
								name: 'Provider',
								provider_name: 'Provider',
								model_id: 'vendor/model',
							}],
						},
					}),
				}),
			}),
			/endpoint\[0\] must include status/u,
		);
	});

	it('rejects blank Provider identities and invalid provider slugs', async () => {
		for (const provider of [
			{ ...OPENROUTER_PROVIDER, name: '   ' },
			{ ...OPENROUTER_PROVIDER, slug: 'Invalid Slug' },
		]) {
			await assert.rejects(
				checkPublicCatalogReadiness({
					baseUrl: 'https://api.cinatoken.test',
					fetchImpl: readyFetch({
						'/api/v1/providers': json({ data: [provider] }),
						'/v1/providers': json({ data: [provider] }),
					}),
				}),
				/(non-empty string|lowercase provider slug)/u,
			);
		}
	});

	it('rejects malformed list documents instead of treating them as empty', async () => {
		await assert.rejects(
			checkPublicCatalogReadiness({
				baseUrl: 'https://api.cinatoken.test',
				fetchImpl: readyFetch({ '/api/v1/providers': json({ providers: [] }) }),
			}),
			/must return a data array/u,
		);
	});
});
