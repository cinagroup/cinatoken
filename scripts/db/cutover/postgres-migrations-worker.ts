import postgres from 'postgres';
import { isDiagnosticRequestAuthorized } from './diagnostic-auth';
import { grantPostgresRuntime } from './grant-postgres-runtime';
import { GATEWAY_MIGRATOR_ROLE, GATEWAY_SCHEMA } from './provision-postgres-roles';
import migration0001 from '../../../packages/core/migrations-postgres/0001_baseline.sql';
import migration0002 from '../../../packages/core/migrations-postgres/0002_seed.sql';
import migration0003 from '../../../packages/core/migrations-postgres/0003_model_modalities_released.sql';
import migration0004 from '../../../packages/core/migrations-postgres/0004_provider_api_keys.sql';
import migration0005 from '../../../packages/core/migrations-postgres/0005_drop_providers_api_key.sql';
import migration0006 from '../../../packages/core/migrations-postgres/0006_upstream_trace_ids.sql';
import migration0007 from '../../../packages/core/migrations-postgres/0007_key_limits_and_sticky_config.sql';
import migration0008 from '../../../packages/core/migrations-postgres/0008_request_timing_metrics.sql';
import migration0009 from '../../../packages/core/migrations-postgres/0009_first_reasoning_token_ms.sql';
import migration0010 from '../../../packages/core/migrations-postgres/0010_models_max_tokens_nullable.sql';
import migration0011 from '../../../packages/core/migrations-postgres/0011_provider_endpoints.sql';
import migration0012 from '../../../packages/core/migrations-postgres/0012_drop_provider_base_url_columns.sql';
import migration0013 from '../../../packages/core/migrations-postgres/0013_request_log_image_billing.sql';
import migration0014 from '../../../packages/core/migrations-postgres/0014_request_log_audio_billing.sql';
import migration0015 from '../../../packages/core/migrations-postgres/0015_single_provider_key.sql';
import migration0016 from '../../../packages/core/migrations-postgres/0016_route_surfaces_pools.sql';
import migration0017 from '../../../packages/core/migrations-postgres/0017_gemini_models_generate.sql';
import migration0018 from '../../../packages/core/migrations-postgres/0018_route_pool_tier_strategies.sql';
import migration0019 from '../../../packages/core/migrations-postgres/0019_route_strategy_canonical_ids.sql';
import migration0020 from '../../../packages/core/migrations-postgres/0020_route_pool_sticky_routing.sql';
import migration0021 from '../../../packages/core/migrations-postgres/0021_route_strategy_display_ids.sql';
import migration0022 from '../../../packages/core/migrations-postgres/0022_request_log_audio_characters.sql';
import migration0023 from '../../../packages/core/migrations-postgres/0023_admin_access_identity.sql';
import migration0024 from '../../../packages/core/migrations-postgres/0024_drop_legacy_master_key_config.sql';
import migration0025 from '../../../packages/core/migrations-postgres/0025_user_audit_actor_index.sql';
import migration0026 from '../../../packages/core/migrations-postgres/0026_user_charged_cost_factors.sql';
import migration0027 from '../../../packages/core/migrations-postgres/0027_user_portal_shared_keys.sql';
import migration0028 from '../../../packages/core/migrations-postgres/0028_portal_marketplace_config.sql';
import migration0029 from '../../../packages/core/migrations-postgres/0029_portal_integer_ledger.sql';
import migration0030 from '../../../packages/core/migrations-postgres/0030_chain_job_transactions.sql';
import migration0031 from '../../../packages/core/migrations-postgres/0031_ledger_integrity_guards.sql';
import migration0032 from '../../../packages/core/migrations-postgres/0032_key_hash_lookup.sql';

interface MigrationEnv {
	MIGRATOR_HYPERDRIVE: { readonly connectionString: string };
	PREFLIGHT_TOKEN?: string;
}

const MIGRATION_LOCK_KEY = 746923551;
const MIGRATIONS = [
	['0001_baseline.sql', migration0001],
	['0002_seed.sql', migration0002],
	['0003_model_modalities_released.sql', migration0003],
	['0004_provider_api_keys.sql', migration0004],
	['0005_drop_providers_api_key.sql', migration0005],
	['0006_upstream_trace_ids.sql', migration0006],
	['0007_key_limits_and_sticky_config.sql', migration0007],
	['0008_request_timing_metrics.sql', migration0008],
	['0009_first_reasoning_token_ms.sql', migration0009],
	['0010_models_max_tokens_nullable.sql', migration0010],
	['0011_provider_endpoints.sql', migration0011],
	['0012_drop_provider_base_url_columns.sql', migration0012],
	['0013_request_log_image_billing.sql', migration0013],
	['0014_request_log_audio_billing.sql', migration0014],
	['0015_single_provider_key.sql', migration0015],
	['0016_route_surfaces_pools.sql', migration0016],
	['0017_gemini_models_generate.sql', migration0017],
	['0018_route_pool_tier_strategies.sql', migration0018],
	['0019_route_strategy_canonical_ids.sql', migration0019],
	['0020_route_pool_sticky_routing.sql', migration0020],
	['0021_route_strategy_display_ids.sql', migration0021],
	['0022_request_log_audio_characters.sql', migration0022],
	['0023_admin_access_identity.sql', migration0023],
	['0024_drop_legacy_master_key_config.sql', migration0024],
	['0025_user_audit_actor_index.sql', migration0025],
	['0026_user_charged_cost_factors.sql', migration0026],
	['0027_user_portal_shared_keys.sql', migration0027],
	['0028_portal_marketplace_config.sql', migration0028],
	['0029_portal_integer_ledger.sql', migration0029],
	['0030_chain_job_transactions.sql', migration0030],
	['0031_ledger_integrity_guards.sql', migration0031],
	['0032_key_hash_lookup.sql', migration0032],
] as const;

export default {
	async fetch(request: Request, env: MigrationEnv): Promise<Response> {
		if (request.method !== 'POST' || new URL(request.url).pathname !== '/migrate') {
			return new Response('Not found', { status: 404 });
		}
		if (!env.PREFLIGHT_TOKEN) {
			return Response.json({ ok: false, error: 'missing_preflight_token' }, { status: 503 });
		}
		if (!await isDiagnosticRequestAuthorized(request, env.PREFLIGHT_TOKEN)) {
			return new Response('Not found', { status: 404 });
		}
		if (!env.MIGRATOR_HYPERDRIVE?.connectionString) {
			return Response.json({ ok: false, error: 'missing_migrator_hyperdrive' }, { status: 503 });
		}

		const sql = postgres(env.MIGRATOR_HYPERDRIVE.connectionString, {
			max: 1,
			fetch_types: false,
			prepare: true,
			connect_timeout: 10,
			idle_timeout: 5,
			connection: { search_path: `${GATEWAY_SCHEMA}, public` },
		});
		let applied = 0;
		let skipped = 0;
		try {
			const [identity] = await sql<Array<{ user_name: string; owner_name: string | null }>>`
				SELECT current_user AS user_name,
					(SELECT owner.rolname
					 FROM pg_namespace AS namespace
					 JOIN pg_roles AS owner ON owner.oid = namespace.nspowner
					 WHERE namespace.nspname = ${GATEWAY_SCHEMA}) AS owner_name
			`;
			if (
				identity?.user_name !== GATEWAY_MIGRATOR_ROLE ||
				identity.owner_name !== GATEWAY_MIGRATOR_ROLE
			) {
				throw new Error('unexpected_migrator_identity_or_schema_owner');
			}

			await sql.begin(async (tx) => {
				await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
				await tx`
					CREATE TABLE IF NOT EXISTS cinatoken_gateway.schema_migrations (
						version TEXT PRIMARY KEY,
						applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
					)
				`;
				const rows = await tx<Array<{ version: string }>>`
					SELECT version FROM cinatoken_gateway.schema_migrations
				`;
				const appliedVersions = new Set(rows.map((row) => row.version));
				for (const [version, migrationSql] of MIGRATIONS) {
					if (appliedVersions.has(version)) {
						skipped += 1;
						continue;
					}
					await tx.unsafe(migrationSql);
					await tx`
						INSERT INTO cinatoken_gateway.schema_migrations (version)
						VALUES (${version})
					`;
					applied += 1;
				}
			});

			await grantPostgresRuntime({
				DATABASE_URL: env.MIGRATOR_HYPERDRIVE.connectionString,
			});
			return Response.json({
				ok: true,
				role: GATEWAY_MIGRATOR_ROLE,
				schema: GATEWAY_SCHEMA,
				applied,
				skipped,
				total: MIGRATIONS.length,
				runtime_grants_applied: true,
			}, { headers: { 'Cache-Control': 'no-store' } });
		} catch (error) {
			console.error('cinatoken.postgres_migration_failed', {
				error: error instanceof Error ? error.message : 'unknown',
				applied,
				skipped,
			});
			return Response.json({ ok: false, error: 'postgres_migration_failed' }, { status: 502 });
		} finally {
			await sql.end({ timeout: 1 }).catch(() => undefined);
		}
	},
} satisfies {
	fetch(request: Request, env: MigrationEnv): Promise<Response>;
};
