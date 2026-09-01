import { createPostgresStorageContext } from '../../../packages/core/src/storage/context';
import {
	listVerifiedPublicEndpointBindings,
	resolvePublishedPublicProviders,
	serializePublishedPublicModelEndpointsDocument,
} from '../../../packages/proxy/src/services/public-model-endpoints';
import { isDiagnosticRequestAuthorized } from './diagnostic-auth';

interface CatalogReadinessProbeEnv {
	HYPERDRIVE: { readonly connectionString: string };
	PREFLIGHT_TOKEN?: string;
}

type CatalogFactsRow = {
	database_user: string;
	models_total: string;
	active_route_models: string;
	providers_total: string;
	active_providers: string;
	providers_with_env_key_reference: string;
	providers_with_endpoint_config: string;
	shared_channel_providers: string;
	active_operator_providers: string;
	routes_total: string;
	active_routes: string;
	callable_routes: string;
	endpoints_total: string;
	verified_endpoints: string;
	current_verified_endpoints: string;
	endpoint_route_links: string;
	links_with_valid_subject: string;
};

/**
 * Temporary, fixed-query production probe for the public catalog release gate.
 * It deliberately exposes only aggregate counts and already-public identities.
 */
export default {
	async fetch(request: Request, env: CatalogReadinessProbeEnv): Promise<Response> {
		if (request.method !== 'GET' || new URL(request.url).pathname !== '/probe') {
			return new Response('Not found', { status: 404 });
		}
		if (!env.PREFLIGHT_TOKEN) {
			return Response.json({ ok: false, error: 'missing_preflight_token' }, { status: 503 });
		}
		if (!await isDiagnosticRequestAuthorized(request, env.PREFLIGHT_TOKEN)) {
			return new Response('Not found', { status: 404 });
		}
		if (!env.HYPERDRIVE?.connectionString) {
			return Response.json({ ok: false, error: 'missing_hyperdrive_binding' }, { status: 503 });
		}

		let storage: Awaited<ReturnType<typeof createPostgresStorageContext>> | null = null;
		try {
			storage = await createPostgresStorageContext(env.HYPERDRIVE.connectionString, {
				max: 1,
				fetch_types: false,
				prepare: true,
				connect_timeout: 10,
				idle_timeout: 5,
			});
			const repositories = storage.repositories;
			const models = await repositories.modelRouting.listModelsWithActiveRoutes();
			const bindings = await listVerifiedPublicEndpointBindings(
				repositories,
				models,
				new Date(),
			);
			const providers = resolvePublishedPublicProviders(bindings);
			const documents = models.flatMap((model) => {
				const document = serializePublishedPublicModelEndpointsDocument(
					model,
					bindings,
					providers.bySlug,
				);
				return document ? [document] : [];
			});

			const rows = await storage.client.raw<CatalogFactsRow[]>`
				WITH callable_routes AS (
					SELECT route.id, route.model_id
					FROM model_routes AS route
					LEFT JOIN route_pools AS pool ON pool.id = route.route_pool_id
					WHERE route.status = 'active'
						AND (route.route_pool_id IS NULL OR pool.status = 'active')
				)
				SELECT
					current_user AS database_user,
					(SELECT COUNT(*)::TEXT FROM models) AS models_total,
					(SELECT COUNT(DISTINCT model_id)::TEXT FROM callable_routes) AS active_route_models,
					(SELECT COUNT(*)::TEXT FROM providers) AS providers_total,
					(SELECT COUNT(*)::TEXT FROM providers
						WHERE status = 'active') AS active_providers,
					(SELECT COUNT(*)::TEXT FROM providers
						WHERE api_key LIKE 'env:%') AS providers_with_env_key_reference,
					(SELECT COUNT(*)::TEXT FROM providers
						WHERE endpoints IS NOT NULL
							AND BTRIM(endpoints) NOT IN ('', '{}')) AS providers_with_endpoint_config,
					(SELECT COUNT(*)::TEXT FROM providers
						WHERE shared_channel_type IS NOT NULL) AS shared_channel_providers,
					(SELECT COUNT(*)::TEXT FROM providers
						WHERE status = 'active'
							AND BTRIM(api_key) <> ''
							AND shared_channel_type IS NULL) AS active_operator_providers,
					(SELECT COUNT(*)::TEXT FROM model_routes) AS routes_total,
					(SELECT COUNT(*)::TEXT FROM model_routes WHERE status = 'active') AS active_routes,
					(SELECT COUNT(*)::TEXT FROM callable_routes) AS callable_routes,
					(SELECT COUNT(*)::TEXT FROM model_endpoints) AS endpoints_total,
					(SELECT COUNT(*)::TEXT FROM model_endpoints
						WHERE status = 'verified') AS verified_endpoints,
					(SELECT COUNT(*)::TEXT FROM model_endpoints
						WHERE status = 'verified'
							AND verified_at IS NOT NULL
							AND expires_at IS NOT NULL
							AND expires_at > CURRENT_TIMESTAMP) AS current_verified_endpoints,
					(SELECT COUNT(*)::TEXT FROM model_endpoint_routes) AS endpoint_route_links,
					(SELECT COUNT(*)::TEXT FROM model_endpoint_routes
						WHERE subject_fingerprint ~ '^[0-9a-f]{64}$') AS links_with_valid_subject
			`;
			const facts = rows[0];
			if (!facts) {
				return Response.json({ ok: false, error: 'empty_catalog_probe_result' }, { status: 502 });
			}

			const publishedEndpointCount = documents.reduce(
				(total, document) => total + document.endpoints.length,
				0,
			);
			const ready = documents.length > 0 && providers.providers.length > 0 && publishedEndpointCount > 0;
			return Response.json({
				ok: true,
				ready,
				facts,
				exact_publication: {
					active_model_count: models.length,
					verified_binding_count: bindings.length,
					published_model_count: documents.length,
					published_provider_count: providers.providers.length,
					published_endpoint_count: publishedEndpointCount,
					published_model_ids: documents.map((document) => document.id).sort(),
					published_provider_slugs: providers.providers.map((provider) => provider.slug).sort(),
				},
			}, {
				status: ready ? 200 : 424,
				headers: { 'Cache-Control': 'no-store' },
			});
		} catch (error) {
			console.error(JSON.stringify({
				message: 'catalog readiness probe failed',
				error_type: error instanceof Error ? error.name : 'UnknownError',
			}));
			return Response.json({ ok: false, error: 'catalog_probe_failed' }, { status: 502 });
		} finally {
			if (storage?.client.driver === 'postgres') {
				await storage.client.raw.end({ timeout: 1 }).catch(() => undefined);
			}
		}
	},
} satisfies {
	fetch(request: Request, env: CatalogReadinessProbeEnv): Promise<Response>;
};
