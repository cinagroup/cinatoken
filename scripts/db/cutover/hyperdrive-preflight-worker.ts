import postgres from 'postgres';
import { isDiagnosticRequestAuthorized } from './diagnostic-auth';

interface PreflightEnv {
	HYPERDRIVE: { readonly connectionString: string };
	PREFLIGHT_TOKEN?: string;
}

type PreflightRow = {
	database_name: string;
	database_user: string;
	server_version_num: string;
	can_create_schema: boolean;
	can_create_role: boolean;
	migrator_role_exists: boolean;
	runtime_role_exists: boolean;
	gateway_schema_exists: boolean;
	gateway_schema_usage: boolean;
	gateway_schema_create: boolean;
	migration_table_exists: boolean;
	migration_count: string;
	latest_migration: string | null;
};

/**
 * Temporary `wrangler dev --remote` entrypoint for a fixed, read-only
 * Hyperdrive cutover preflight. It intentionally accepts no SQL or parameters.
 */
export default {
	async fetch(request: Request, env: PreflightEnv): Promise<Response> {
		if (request.method !== 'GET' || new URL(request.url).pathname !== '/') {
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

		const sql = postgres(env.HYPERDRIVE.connectionString, {
			max: 1,
			fetch_types: false,
			prepare: true,
			connect_timeout: 10,
			idle_timeout: 5,
		});
		try {
			const rows = await sql<PreflightRow[]>`
				WITH gateway_namespace AS (
					SELECT to_regnamespace('cinatoken_gateway') AS oid
				)
				SELECT
					current_database() AS database_name,
					current_user AS database_user,
					current_setting('server_version_num') AS server_version_num,
					has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_schema,
					COALESCE((SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user), FALSE)
						AS can_create_role,
					EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cinatoken_gateway_migrator')
						AS migrator_role_exists,
					EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cinatoken_gateway_runtime')
						AS runtime_role_exists,
					gateway_namespace.oid IS NOT NULL AS gateway_schema_exists,
					COALESCE(has_schema_privilege(current_user, gateway_namespace.oid, 'USAGE'), FALSE)
						AS gateway_schema_usage,
					COALESCE(has_schema_privilege(current_user, gateway_namespace.oid, 'CREATE'), FALSE)
						AS gateway_schema_create,
					to_regclass('cinatoken_gateway.schema_migrations') IS NOT NULL
						AS migration_table_exists,
					(SELECT COUNT(*)::TEXT FROM cinatoken_gateway.schema_migrations)
						AS migration_count,
					(SELECT MAX(version) FROM cinatoken_gateway.schema_migrations)
						AS latest_migration
				FROM gateway_namespace
			`;
			const row = rows[0];
			if (!row) {
				return Response.json({ ok: false, error: 'empty_preflight_result' }, { status: 502 });
			}
			return Response.json({ ok: true, ...row }, {
				headers: { 'Cache-Control': 'no-store' },
			});
		} catch (error) {
			console.error('cinatoken.hyperdrive_preflight_failed', {
				error: error instanceof Error ? error.message : 'unknown',
			});
			return Response.json({ ok: false, error: 'preflight_query_failed' }, { status: 502 });
		} finally {
			await sql.end({ timeout: 1 }).catch(() => undefined);
		}
	},
} satisfies {
	fetch(request: Request, env: PreflightEnv): Promise<Response>;
};
