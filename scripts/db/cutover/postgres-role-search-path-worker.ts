import postgres from 'postgres';
import { isDiagnosticRequestAuthorized } from './diagnostic-auth';
import {
	GATEWAY_MIGRATOR_ROLE,
	GATEWAY_RUNTIME_ROLE,
	GATEWAY_SCHEMA,
} from './provision-postgres-roles';

interface RoleSearchPathEnv {
	ADMIN_HYPERDRIVE: { readonly connectionString: string };
	PREFLIGHT_TOKEN?: string;
}

const ROLE_DEFAULTS_LOCK_KEY = 746923553;
const EXPECTED_SEARCH_PATH = `${GATEWAY_SCHEMA}, public`;

export default {
	async fetch(request: Request, env: RoleSearchPathEnv): Promise<Response> {
		if (request.method !== 'POST' || new URL(request.url).pathname !== '/apply') {
			return new Response('Not found', { status: 404 });
		}
		if (!env.PREFLIGHT_TOKEN) {
			return Response.json({ ok: false, error: 'missing_preflight_token' }, { status: 503 });
		}
		if (!await isDiagnosticRequestAuthorized(request, env.PREFLIGHT_TOKEN)) {
			return new Response('Not found', { status: 404 });
		}
		if (!env.ADMIN_HYPERDRIVE?.connectionString) {
			return Response.json({ ok: false, error: 'missing_admin_hyperdrive' }, { status: 503 });
		}

		const sql = postgres(env.ADMIN_HYPERDRIVE.connectionString, {
			max: 1,
			fetch_types: false,
			prepare: true,
			connect_timeout: 10,
			idle_timeout: 5,
		});
		try {
			const [identity] = await sql<Array<{
				user_name: string;
				can_create_role: boolean;
				gateway_exists: boolean;
			}>>`
				SELECT current_user AS user_name,
					COALESCE((SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user), FALSE)
						AS can_create_role,
					to_regnamespace(${GATEWAY_SCHEMA}) IS NOT NULL AS gateway_exists
			`;
			if (!identity?.can_create_role || !identity.gateway_exists) {
				throw new Error('admin_role_contract_failed');
			}

			await sql.begin(async (tx) => {
				await tx`SELECT pg_advisory_xact_lock(${ROLE_DEFAULTS_LOCK_KEY})`;
				await tx.unsafe(
					`ALTER ROLE "${GATEWAY_MIGRATOR_ROLE}" SET search_path TO "${GATEWAY_SCHEMA}", public`,
				);
				await tx.unsafe(
					`ALTER ROLE "${GATEWAY_RUNTIME_ROLE}" SET search_path TO "${GATEWAY_SCHEMA}", public`,
				);
			});

			const settings = await sql<Array<{ role_name: string; search_path: string | null }>>`
				SELECT role.rolname AS role_name,
					(
						SELECT setting
						FROM unnest(COALESCE(config.setconfig, ARRAY[]::text[])) AS setting
						WHERE setting LIKE 'search_path=%'
						LIMIT 1
					) AS search_path
				FROM pg_roles AS role
				LEFT JOIN pg_db_role_setting AS config
					ON config.setrole = role.oid AND config.setdatabase = 0
				WHERE role.rolname IN (${GATEWAY_MIGRATOR_ROLE}, ${GATEWAY_RUNTIME_ROLE})
				ORDER BY role.rolname
			`;
			const expectedSetting = `search_path=${EXPECTED_SEARCH_PATH}`;
			if (
				settings.length !== 2 ||
				settings.some((setting) => setting.search_path !== expectedSetting)
			) {
				throw new Error('role_search_path_verification_failed');
			}

			const terminated = await sql<Array<{ role_name: string; terminated: boolean }>>`
				SELECT usename AS role_name, pg_terminate_backend(pid) AS terminated
				FROM pg_stat_activity
				WHERE usename IN (${GATEWAY_MIGRATOR_ROLE}, ${GATEWAY_RUNTIME_ROLE})
				  AND pid <> pg_backend_pid()
			`;
			if (terminated.some((connection) => !connection.terminated)) {
				throw new Error('old_role_connection_termination_failed');
			}

			return Response.json({
				ok: true,
				admin_role: identity.user_name,
				settings,
				terminated_connections: terminated.length,
			}, { headers: { 'Cache-Control': 'no-store' } });
		} catch (error) {
			console.error('cinatoken.postgres_role_search_path_failed', {
				error: error instanceof Error ? error.message : 'unknown',
			});
			return Response.json({ ok: false, error: 'role_search_path_failed' }, { status: 502 });
		} finally {
			await sql.end({ timeout: 1 }).catch(() => undefined);
		}
	},
} satisfies {
	fetch(request: Request, env: RoleSearchPathEnv): Promise<Response>;
};
