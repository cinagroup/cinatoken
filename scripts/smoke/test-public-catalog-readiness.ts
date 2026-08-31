import { pathToFileURL } from 'node:url';

export type PublicCatalogReadinessOptions = {
	baseUrl: string;
	minimumModels?: number;
	minimumProviders?: number;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
};

export type PublicCatalogReadinessSummary = {
	base_url: string;
	model_count: number;
	provider_count: number;
	canonical_model_count: number;
	canonical_provider_count: number;
	sampled_model_id: string;
	sampled_endpoint_count: number;
};

type JsonObject = Record<string, unknown>;

type OpenRouterModelList = {
	data: JsonObject[];
	totalCount: number;
};

function normalizeBaseUrl(value: string): string {
	const url = new URL(value);
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new Error('CINATOKEN_PUBLIC_BASE_URL must use http or https');
	}
	url.pathname = url.pathname.replace(/\/$/u, '');
	url.search = '';
	url.hash = '';
	return url.toString().replace(/\/$/u, '');
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
	if (value == null || value.trim() === '') return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

function asObject(value: unknown, label: string): JsonObject {
	if (value == null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${label} must return a JSON object`);
	}
	return value as JsonObject;
}

function dataArray(value: unknown, label: string): JsonObject[] {
	const body = asObject(value, label);
	if (!Array.isArray(body.data)) {
		throw new Error(`${label} must return a data array`);
	}
	return body.data.map((item, index) => asObject(item, `${label}.data[${index}]`));
}

function hasOwn(object: JsonObject, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(object, key);
}

function requireOwn(object: JsonObject, key: string, label: string): unknown {
	if (!hasOwn(object, key)) throw new Error(`${label} must include ${key}`);
	return object[key];
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
		throw new Error(`${label} must be a string array`);
	}
	return value;
}

function nullableString(value: unknown, label: string): void {
	if (value !== null && typeof value !== 'string') {
		throw new Error(`${label} must be a string or null`);
	}
}

function nullablePositiveInteger(value: unknown, label: string): void {
	if (value !== null && (!Number.isSafeInteger(value) || (value as number) < 1)) {
		throw new Error(`${label} must be a positive integer or null`);
	}
}

function validateOpenRouterModel(model: JsonObject, index: number): void {
	const label = `GET /api/v1/models.data[${index}]`;
	const id = requireOwn(model, 'id', label);
	const canonicalSlug = requireOwn(model, 'canonical_slug', label);
	if (typeof id !== 'string' || id.trim() === '') throw new Error(`${label}.id must be a non-empty string`);
	if (typeof canonicalSlug !== 'string' || !/^[^/]+\/[^/]+$/u.test(canonicalSlug)) {
		throw new Error(`${label}.canonical_slug must be an author/model id`);
	}
	nullableString(requireOwn(model, 'hugging_face_id', label), `${label}.hugging_face_id`);
	if (typeof requireOwn(model, 'name', label) !== 'string') throw new Error(`${label}.name must be a string`);
	const created = requireOwn(model, 'created', label);
	if (created !== null && (!Number.isSafeInteger(created) || (created as number) < 0)) {
		throw new Error(`${label}.created must be a non-negative integer or null`);
	}
	if (typeof requireOwn(model, 'description', label) !== 'string') {
		throw new Error(`${label}.description must be a string`);
	}
	nullablePositiveInteger(requireOwn(model, 'context_length', label), `${label}.context_length`);

	const architecture = asObject(requireOwn(model, 'architecture', label), `${label}.architecture`);
	nullableString(requireOwn(architecture, 'modality', `${label}.architecture`), `${label}.architecture.modality`);
	stringArray(
		requireOwn(architecture, 'input_modalities', `${label}.architecture`),
		`${label}.architecture.input_modalities`,
	);
	stringArray(
		requireOwn(architecture, 'output_modalities', `${label}.architecture`),
		`${label}.architecture.output_modalities`,
	);
	nullableString(requireOwn(architecture, 'tokenizer', `${label}.architecture`), `${label}.architecture.tokenizer`);
	nullableString(requireOwn(architecture, 'instruct_type', `${label}.architecture`), `${label}.architecture.instruct_type`);

	const pricing = asObject(requireOwn(model, 'pricing', label), `${label}.pricing`);
	for (const [key, value] of Object.entries(pricing)) {
		if (typeof value !== 'string' && typeof value !== 'number') {
			throw new Error(`${label}.pricing.${key} must be a string or number`);
		}
	}
	const topProvider = requireOwn(model, 'top_provider', label);
	if (topProvider !== null) {
		const provider = asObject(topProvider, `${label}.top_provider`);
		nullablePositiveInteger(
			requireOwn(provider, 'context_length', `${label}.top_provider`),
			`${label}.top_provider.context_length`,
		);
		nullablePositiveInteger(
			requireOwn(provider, 'max_completion_tokens', `${label}.top_provider`),
			`${label}.top_provider.max_completion_tokens`,
		);
		const moderated = requireOwn(provider, 'is_moderated', `${label}.top_provider`);
		if (moderated !== null && typeof moderated !== 'boolean') {
			throw new Error(`${label}.top_provider.is_moderated must be a boolean or null`);
		}
	}
	const perRequestLimits = requireOwn(model, 'per_request_limits', label);
	if (perRequestLimits !== null) asObject(perRequestLimits, `${label}.per_request_limits`);
	stringArray(requireOwn(model, 'supported_parameters', label), `${label}.supported_parameters`);
	asObject(requireOwn(model, 'default_parameters', label), `${label}.default_parameters`);
	const voices = requireOwn(model, 'supported_voices', label);
	if (voices !== null) stringArray(voices, `${label}.supported_voices`);
	nullableString(requireOwn(model, 'knowledge_cutoff', label), `${label}.knowledge_cutoff`);
	nullableString(requireOwn(model, 'expiration_date', label), `${label}.expiration_date`);
	const links = asObject(requireOwn(model, 'links', label), `${label}.links`);
	if (typeof requireOwn(links, 'details', `${label}.links`) !== 'string') {
		throw new Error(`${label}.links.details must be a string`);
	}
	const reasoning = requireOwn(model, 'reasoning', label);
	if (reasoning !== null) asObject(reasoning, `${label}.reasoning`);
}

function openRouterModels(value: unknown): OpenRouterModelList {
	const label = 'GET /api/v1/models';
	const body = asObject(value, label);
	const models = dataArray(body, label);
	const totalCount = requireOwn(body, 'total_count', label);
	if (!Number.isSafeInteger(totalCount) || (totalCount as number) < models.length) {
		throw new Error(`${label}.total_count must be an integer at least as large as data.length`);
	}
	const links = asObject(requireOwn(body, 'links', label), `${label}.links`);
	const next = requireOwn(links, 'next', `${label}.links`);
	if (next !== null && typeof next !== 'string') {
		throw new Error(`${label}.links.next must be a string or null`);
	}
	models.forEach(validateOpenRouterModel);
	return { data: models, totalCount: totalCount as number };
}

function openRouterProviders(
	value: unknown,
	label = 'GET /api/v1/providers',
): JsonObject[] {
	const providers = dataArray(value, label);
	providers.forEach((provider, index) => {
		const itemLabel = `${label}.data[${index}]`;
		const name = requireOwn(provider, 'name', itemLabel);
		if (typeof name !== 'string' || name.trim() === '') {
			throw new Error(`${itemLabel}.name must be a non-empty string`);
		}
		const slug = requireOwn(provider, 'slug', itemLabel);
		if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
			throw new Error(`${itemLabel}.slug must be a lowercase provider slug`);
		}
		for (const key of ['privacy_policy_url', 'terms_of_service_url', 'status_page_url', 'headquarters']) {
			nullableString(requireOwn(provider, key, itemLabel), `${itemLabel}.${key}`);
		}
		const datacenters = requireOwn(provider, 'datacenters', itemLabel);
		if (datacenters !== null) stringArray(datacenters, `${itemLabel}.datacenters`);
	});
	return providers;
}

async function readJson(
	fetchImpl: typeof fetch,
	url: string,
	timeoutMs: number,
	label: string,
): Promise<unknown> {
	let response: Response;
	try {
		response = await fetchImpl(url, {
			headers: { Accept: 'application/json' },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		throw new Error(`${label} request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) {
		const body = await response.text();
		throw new Error(`${label} failed: HTTP ${response.status} ${body.slice(0, 300)}`);
	}
	const contentType = response.headers.get('content-type') ?? '';
	if (!contentType.toLowerCase().includes('application/json')) {
		throw new Error(`${label} must return application/json, received ${contentType || 'no content-type'}`);
	}
	try {
		return await response.json();
	} catch (error) {
		throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function modelIdForEndpointSample(models: JsonObject[]): string {
	for (const model of models) {
		const id = typeof model.canonical_slug === 'string' ? model.canonical_slug.trim() : '';
		if (/^[^/]+\/[^/]+$/u.test(id)) return id;
	}
	throw new Error('GET /api/v1/models did not return a canonical author/model slug');
}

function uniqueNonEmptyStrings(
	items: JsonObject[],
	key: string,
	label: string,
): Set<string> {
	const values = new Set<string>();
	for (const [index, item] of items.entries()) {
		const value = requireOwn(item, key, `${label}.data[${index}]`);
		if (typeof value !== 'string' || value.trim() === '') {
			throw new Error(`${label}.data[${index}].${key} must be a non-empty string`);
		}
		if (values.has(value)) throw new Error(`${label} contains duplicate ${key} ${value}`);
		values.add(value);
	}
	return values;
}

function providerIdentityMap(providers: JsonObject[], label: string): Map<string, string> {
	const identities = new Map<string, string>();
	for (const [index, provider] of providers.entries()) {
		const slug = requireOwn(provider, 'slug', `${label}.data[${index}]`);
		const name = requireOwn(provider, 'name', `${label}.data[${index}]`);
		if (
			typeof slug !== 'string' ||
			!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) ||
			typeof name !== 'string' ||
			name.trim() === ''
		) {
			throw new Error(`${label}.data[${index}] must include a valid slug and non-empty name`);
		}
		if (identities.has(slug)) throw new Error(`${label} contains duplicate provider slug ${slug}`);
		identities.set(slug, name);
	}
	return identities;
}

export async function checkPublicCatalogReadiness(
	options: PublicCatalogReadinessOptions,
): Promise<PublicCatalogReadinessSummary> {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	const minimumModels = options.minimumModels ?? 1;
	const minimumProviders = options.minimumProviders ?? 1;
	const timeoutMs = options.timeoutMs ?? 10_000;
	if (!Number.isSafeInteger(minimumModels) || minimumModels < 1) {
		throw new Error('minimumModels must be a positive integer');
	}
	if (!Number.isSafeInteger(minimumProviders) || minimumProviders < 1) {
		throw new Error('minimumProviders must be a positive integer');
	}
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
		throw new Error('timeoutMs must be a positive integer');
	}
	const fetchImpl = options.fetchImpl ?? fetch;

	const health = asObject(
		await readJson(fetchImpl, `${baseUrl}/health`, timeoutMs, 'GET /health'),
		'GET /health',
	);
	if (health.status !== 'ok') {
		throw new Error(`GET /health is not ready: status=${String(health.status)}`);
	}

	const [
		catalogModels,
		catalogProviders,
		canonicalModelList,
		canonicalProviders,
		providersAlias,
	] = await Promise.all([
		readJson(fetchImpl, `${baseUrl}/catalog/models`, timeoutMs, 'GET /catalog/models')
			.then((body) => dataArray(body, 'GET /catalog/models')),
		readJson(fetchImpl, `${baseUrl}/catalog/providers`, timeoutMs, 'GET /catalog/providers')
			.then((body) => dataArray(body, 'GET /catalog/providers')),
		readJson(fetchImpl, `${baseUrl}/api/v1/models?limit=1000&offset=0`, timeoutMs, 'GET /api/v1/models')
			.then(openRouterModels),
		readJson(fetchImpl, `${baseUrl}/api/v1/providers`, timeoutMs, 'GET /api/v1/providers')
			.then((body) => openRouterProviders(body, 'GET /api/v1/providers')),
		readJson(fetchImpl, `${baseUrl}/v1/providers`, timeoutMs, 'GET /v1/providers')
			.then((body) => openRouterProviders(body, 'GET /v1/providers')),
	]);
	const canonicalModels = canonicalModelList.data;

	if (catalogModels.length < minimumModels) {
		throw new Error(`public catalog has ${catalogModels.length} models; requires at least ${minimumModels}`);
	}
	if (catalogProviders.length < minimumProviders) {
		throw new Error(`public catalog has ${catalogProviders.length} providers; requires at least ${minimumProviders}`);
	}
	if (canonicalModels.length < minimumModels) {
		throw new Error(`OpenRouter-compatible catalog has ${canonicalModels.length} models; requires at least ${minimumModels}`);
	}
	if (canonicalProviders.length < minimumProviders) {
		throw new Error(`OpenRouter-compatible catalog has ${canonicalProviders.length} providers; requires at least ${minimumProviders}`);
	}
	if (canonicalModelList.totalCount !== canonicalModels.length) {
		throw new Error(
			`GET /api/v1/models returned ${canonicalModels.length} of ${canonicalModelList.totalCount} models; readiness requires a complete bounded catalog`,
		);
	}

	const catalogModelIds = uniqueNonEmptyStrings(catalogModels, 'id', 'GET /catalog/models');
	const canonicalModelIds = uniqueNonEmptyStrings(canonicalModels, 'id', 'GET /api/v1/models');
	for (const modelId of canonicalModelIds) {
		if (!catalogModelIds.has(modelId)) {
			throw new Error(`OpenRouter model ${modelId} is missing from GET /catalog/models`);
		}
	}
	const canonicalProviderIdentities = providerIdentityMap(
		canonicalProviders,
		'GET /api/v1/providers',
	);
	const aliasProviderIdentities = providerIdentityMap(providersAlias, 'GET /v1/providers');
	if (
		canonicalProviderIdentities.size !== aliasProviderIdentities.size ||
		[...canonicalProviderIdentities].some(
			([slug, name]) => aliasProviderIdentities.get(slug) !== name,
		)
	) {
		throw new Error('GET /v1/providers must publish the same provider identities as GET /api/v1/providers');
	}

	const sampledModelId = modelIdForEndpointSample(canonicalModels);
	const sampledModel = canonicalModels.find(
		(model) => model.canonical_slug === sampledModelId,
	)!;
	const expectedDetailsPath = `/api/v1/models/${sampledModelId}/endpoints`;
	const sampledLinks = asObject(
		requireOwn(sampledModel, 'links', 'sampled OpenRouter model'),
		'sampled OpenRouter model.links',
	);
	if (requireOwn(sampledLinks, 'details', 'sampled OpenRouter model.links') !== expectedDetailsPath) {
		throw new Error(`model ${sampledModelId} links.details must equal ${expectedDetailsPath}`);
	}
	const sampledModelPath = sampledModelId
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/');
	const endpointBody = asObject(
		await readJson(
			fetchImpl,
			`${baseUrl}/api/v1/models/${sampledModelPath}/endpoints`,
			timeoutMs,
			'GET /api/v1/models/:author/:model/endpoints',
		),
		'GET /api/v1/models/:author/:model/endpoints',
	);
	const endpointDocument = asObject(
		endpointBody.data,
		'GET /api/v1/models/:author/:model/endpoints.data',
	);
	if (endpointDocument.id !== sampledModel.id) {
		throw new Error(`model ${sampledModelId} endpoint document id must equal ${String(sampledModel.id)}`);
	}
	if (!Array.isArray(endpointDocument.endpoints) || endpointDocument.endpoints.length === 0) {
		throw new Error(`model ${sampledModelId} has no published verified endpoints`);
	}
	endpointDocument.endpoints.forEach((endpoint, index) => {
		const item = asObject(
			endpoint,
			`GET /api/v1/models/:author/:model/endpoints.data.endpoints[${index}]`,
		);
		if (requireOwn(item, 'status', `endpoint[${index}]`) !== 0) {
			throw new Error(`model ${sampledModelId} endpoint[${index}].status must be 0`);
		}
		if (requireOwn(item, 'model_id', `endpoint[${index}]`) !== sampledModel.id) {
			throw new Error(`model ${sampledModelId} endpoint[${index}].model_id is inconsistent`);
		}
		const providerName = requireOwn(item, 'provider_name', `endpoint[${index}]`);
		if (
			typeof providerName !== 'string' || providerName.trim() === '' ||
			![...canonicalProviderIdentities.values()].includes(providerName)
		) {
			throw new Error(`model ${sampledModelId} endpoint[${index}].provider_name is not published`);
		}
	});

	return {
		base_url: baseUrl,
		model_count: catalogModels.length,
		provider_count: catalogProviders.length,
		canonical_model_count: canonicalModelList.totalCount,
		canonical_provider_count: canonicalProviders.length,
		sampled_model_id: sampledModelId,
		sampled_endpoint_count: endpointDocument.endpoints.length,
	};
}

export async function runPublicCatalogReadinessFromEnvironment(): Promise<void> {
	const summary = await checkPublicCatalogReadiness({
		baseUrl: process.env.CINATOKEN_PUBLIC_BASE_URL ?? 'https://api.cinatoken.com',
		minimumModels: positiveInteger(process.env.CINATOKEN_MIN_PUBLIC_MODELS, 1, 'CINATOKEN_MIN_PUBLIC_MODELS'),
		minimumProviders: positiveInteger(process.env.CINATOKEN_MIN_PUBLIC_PROVIDERS, 1, 'CINATOKEN_MIN_PUBLIC_PROVIDERS'),
		timeoutMs: positiveInteger(process.env.CINATOKEN_READINESS_TIMEOUT_MS, 10_000, 'CINATOKEN_READINESS_TIMEOUT_MS'),
	});
	console.log(JSON.stringify({ message: 'public catalog readiness passed', ...summary }));
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entrypoint === import.meta.url) {
	runPublicCatalogReadinessFromEnvironment().catch((error) => {
		console.error(JSON.stringify({
			message: 'public catalog readiness failed',
			error: error instanceof Error ? error.message : String(error),
		}));
		process.exitCode = 1;
	});
}
