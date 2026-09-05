import postgres from 'postgres';
import { isDiagnosticRequestAuthorized } from './diagnostic-auth';
import {
	GATEWAY_MIGRATOR_ROLE,
	GATEWAY_RUNTIME_ROLE,
	GATEWAY_SCHEMA,
} from './provision-postgres-roles';

interface AccessProbeEnv {
	MIGRATOR_HYPERDRIVE: { readonly connectionString: string };
	RUNTIME_HYPERDRIVE: { readonly connectionString: string };
	PREFLIGHT_TOKEN?: string;
}

type MigratorProbe = {
	user_name: string;
	schema_owner: string | null;
	can_create_database_object: boolean;
	can_create_role: boolean;
	schema_usage: boolean;
	schema_create: boolean;
	migration_count: string;
	latest_migration: string | null;
	latest_migration_applied: boolean;
};

type RuntimeProbe = {
	user_name: string;
	current_search_path: string;
	models_count: string;
	providers_count: string;
	routes_count: string;
	active_routes_count: string;
	users_count: string;
	user_budget_reservations_exists: boolean;
	workspaces_exists: boolean;
	management_api_keys_exists: boolean;
	byok_keys_exists: boolean;
	generation_feedback_exists: boolean;
	provider_attempt_availability_exists: boolean;
	batches_exists: boolean;
	batch_items_exists: boolean;
	can_create_database_object: boolean;
	can_create_role: boolean;
	schema_usage: boolean;
	schema_create: boolean;
	users_select: boolean;
	users_insert: boolean;
	users_update: boolean;
	users_delete: boolean;
	users_truncate: boolean;
	management_api_keys_select: boolean;
	management_api_keys_insert: boolean;
	management_api_keys_update: boolean;
	management_api_keys_delete: boolean;
	byok_keys_select: boolean;
	byok_keys_insert: boolean;
	byok_keys_update: boolean;
	byok_keys_delete: boolean;
	generation_feedback_select: boolean;
	generation_feedback_insert: boolean;
	generation_feedback_update: boolean;
	generation_feedback_delete: boolean;
	provider_attempt_availability_select: boolean;
	provider_attempt_availability_insert: boolean;
	provider_attempt_availability_update: boolean;
	provider_attempt_availability_delete: boolean;
	batches_select: boolean;
	batches_insert: boolean;
	batches_update: boolean;
	batches_delete: boolean;
	batch_items_select: boolean;
	batch_items_insert: boolean;
	batch_items_update: boolean;
	batch_items_delete: boolean;
	provider_attempt_retention_execute: boolean;
	user_budget_reservations_delete: boolean;
	migrations_select: boolean;
	migrations_insert: boolean;
	ledger_trigger_execute: boolean;
};

function migratorContractPassed(row: MigratorProbe | undefined): boolean {
	return row?.user_name === GATEWAY_MIGRATOR_ROLE &&
		row.schema_owner === GATEWAY_MIGRATOR_ROLE &&
		!row.can_create_database_object &&
		!row.can_create_role &&
		row.schema_usage &&
		row.schema_create &&
		row.migration_count === '67' &&
		row.latest_migration === '0067_batch_jobs.sql' &&
		row.latest_migration_applied;
}

function runtimeContractPassed(row: RuntimeProbe | undefined): boolean {
	return row?.user_name === GATEWAY_RUNTIME_ROLE &&
		row.current_search_path === `${GATEWAY_SCHEMA}, public` &&
		/^\d+$/.test(row.models_count) &&
		/^\d+$/.test(row.providers_count) &&
		/^\d+$/.test(row.routes_count) &&
		/^\d+$/.test(row.active_routes_count) &&
		/^\d+$/.test(row.users_count) &&
		row.user_budget_reservations_exists &&
		row.workspaces_exists &&
		row.management_api_keys_exists &&
		row.byok_keys_exists &&
		row.generation_feedback_exists &&
		row.provider_attempt_availability_exists &&
		row.batches_exists &&
		row.batch_items_exists &&
		!row.can_create_database_object &&
		!row.can_create_role &&
		row.schema_usage &&
		!row.schema_create &&
		row.users_select &&
		row.users_insert &&
		row.users_update &&
		row.users_delete &&
		!row.users_truncate &&
		row.management_api_keys_select &&
		row.management_api_keys_insert &&
		row.management_api_keys_update &&
		row.management_api_keys_delete &&
		row.byok_keys_select &&
		row.byok_keys_insert &&
		row.byok_keys_update &&
		row.byok_keys_delete &&
		row.generation_feedback_select &&
		row.generation_feedback_insert &&
		!row.generation_feedback_update &&
		!row.generation_feedback_delete &&
		row.provider_attempt_availability_select &&
		row.provider_attempt_availability_insert &&
		!row.provider_attempt_availability_update &&
		!row.provider_attempt_availability_delete &&
		row.batches_select &&
		row.batches_insert &&
		row.batches_update &&
		!row.batches_delete &&
		row.batch_items_select &&
		row.batch_items_insert &&
		row.batch_items_update &&
		!row.batch_items_delete &&
		row.provider_attempt_retention_execute &&
		!row.user_budget_reservations_delete &&
		!row.migrations_select &&
		!row.migrations_insert &&
		row.ledger_trigger_execute;
}

export default {
	async fetch(request: Request, env: AccessProbeEnv): Promise<Response> {
		const pathname = new URL(request.url).pathname;
		if (request.method !== 'GET' || !['/probe', '/probe/migrator'].includes(pathname)) {
			return new Response('Not found', { status: 404 });
		}
		if (!env.PREFLIGHT_TOKEN) {
			return Response.json({ ok: false, error: 'missing_preflight_token' }, { status: 503 });
		}
		if (!await isDiagnosticRequestAuthorized(request, env.PREFLIGHT_TOKEN)) {
			return new Response('Not found', { status: 404 });
		}
		if (
			!env.MIGRATOR_HYPERDRIVE?.connectionString ||
			!env.RUNTIME_HYPERDRIVE?.connectionString
		) {
			return Response.json({ ok: false, error: 'missing_hyperdrive_binding' }, { status: 503 });
		}

		const migrator = postgres(env.MIGRATOR_HYPERDRIVE.connectionString, {
			max: 1,
			fetch_types: false,
			prepare: true,
			connect_timeout: 10,
			idle_timeout: 5,
		});
		const runtime = postgres(env.RUNTIME_HYPERDRIVE.connectionString, {
			max: 1,
			fetch_types: false,
			prepare: true,
			connect_timeout: 10,
			idle_timeout: 5,
		});

		try {
			const [migratorRow] = await migrator<MigratorProbe[]>`
					SELECT current_user AS user_name,
						(SELECT owner.rolname
						 FROM pg_namespace AS namespace
						 JOIN pg_roles AS owner ON owner.oid = namespace.nspowner
						 WHERE namespace.nspname = ${GATEWAY_SCHEMA}) AS schema_owner,
						has_database_privilege(current_user, current_database(), 'CREATE')
							AS can_create_database_object,
						COALESCE((SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user), FALSE)
							AS can_create_role,
						has_schema_privilege(current_user, ${GATEWAY_SCHEMA}, 'USAGE') AS schema_usage,
						has_schema_privilege(current_user, ${GATEWAY_SCHEMA}, 'CREATE') AS schema_create,
						(SELECT COUNT(*)::TEXT FROM cinatoken_gateway.schema_migrations) AS migration_count,
						(SELECT MAX(version) FROM cinatoken_gateway.schema_migrations) AS latest_migration,
						EXISTS (
							SELECT 1 FROM cinatoken_gateway.schema_migrations
							WHERE version = '0067_batch_jobs.sql'
						) AS latest_migration_applied
				`;
			const migratorPassed = migratorContractPassed(migratorRow);
			if (pathname === '/probe/migrator') {
				return Response.json({
					ok: migratorPassed,
					migrator: { contract_passed: migratorPassed, ...migratorRow },
				}, {
					status: migratorPassed ? 200 : 502,
					headers: { 'Cache-Control': 'no-store' },
				});
			}
			const [runtimeRow] = await runtime<RuntimeProbe[]>`
					SELECT current_user AS user_name,
						current_setting('search_path') AS current_search_path,
						(SELECT COUNT(*)::TEXT FROM models) AS models_count,
						(SELECT COUNT(*)::TEXT FROM providers) AS providers_count,
						(SELECT COUNT(*)::TEXT FROM model_routes) AS routes_count,
						(SELECT COUNT(*)::TEXT FROM model_routes WHERE status = 'active')
							AS active_routes_count,
						(SELECT COUNT(*)::TEXT FROM users) AS users_count,
						to_regclass('cinatoken_gateway.user_budget_reservations') IS NOT NULL
							AS user_budget_reservations_exists,
						to_regclass('cinatoken_gateway.workspaces') IS NOT NULL AS workspaces_exists,
						to_regclass('cinatoken_gateway.management_api_keys') IS NOT NULL
							AS management_api_keys_exists,
						to_regclass('cinatoken_gateway.byok_keys') IS NOT NULL AS byok_keys_exists,
						to_regclass('cinatoken_gateway.generation_feedback') IS NOT NULL
							AS generation_feedback_exists,
						to_regclass('cinatoken_gateway.provider_attempt_availability') IS NOT NULL
							AS provider_attempt_availability_exists,
						to_regclass('cinatoken_gateway.batches') IS NOT NULL AS batches_exists,
						to_regclass('cinatoken_gateway.batch_items') IS NOT NULL AS batch_items_exists,
						has_database_privilege(current_user, current_database(), 'CREATE')
							AS can_create_database_object,
						COALESCE((SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user), FALSE)
							AS can_create_role,
						has_schema_privilege(current_user, ${GATEWAY_SCHEMA}, 'USAGE') AS schema_usage,
						has_schema_privilege(current_user, ${GATEWAY_SCHEMA}, 'CREATE') AS schema_create,
						has_table_privilege(current_user, 'cinatoken_gateway.users', 'SELECT') AS users_select,
						has_table_privilege(current_user, 'cinatoken_gateway.users', 'INSERT') AS users_insert,
						has_table_privilege(current_user, 'cinatoken_gateway.users', 'UPDATE') AS users_update,
						has_table_privilege(current_user, 'cinatoken_gateway.users', 'DELETE') AS users_delete,
						has_table_privilege(current_user, 'cinatoken_gateway.users', 'TRUNCATE') AS users_truncate,
						has_table_privilege(
							current_user, 'cinatoken_gateway.management_api_keys', 'SELECT'
						) AS management_api_keys_select,
						has_table_privilege(
							current_user, 'cinatoken_gateway.management_api_keys', 'INSERT'
						) AS management_api_keys_insert,
						has_table_privilege(
							current_user, 'cinatoken_gateway.management_api_keys', 'UPDATE'
						) AS management_api_keys_update,
						has_table_privilege(
							current_user, 'cinatoken_gateway.management_api_keys', 'DELETE'
						) AS management_api_keys_delete,
						has_table_privilege(
							current_user, 'cinatoken_gateway.byok_keys', 'SELECT'
						) AS byok_keys_select,
						has_table_privilege(
							current_user, 'cinatoken_gateway.byok_keys', 'INSERT'
						) AS byok_keys_insert,
						has_table_privilege(
							current_user, 'cinatoken_gateway.byok_keys', 'UPDATE'
						) AS byok_keys_update,
						has_table_privilege(
							current_user, 'cinatoken_gateway.byok_keys', 'DELETE'
						) AS byok_keys_delete,
						has_table_privilege(
							current_user, 'cinatoken_gateway.generation_feedback', 'SELECT'
						) AS generation_feedback_select,
						has_table_privilege(
							current_user, 'cinatoken_gateway.generation_feedback', 'INSERT'
						) AS generation_feedback_insert,
						has_table_privilege(
							current_user, 'cinatoken_gateway.generation_feedback', 'UPDATE'
						) AS generation_feedback_update,
						has_table_privilege(
							current_user, 'cinatoken_gateway.generation_feedback', 'DELETE'
						) AS generation_feedback_delete,
						has_table_privilege(
							current_user, 'cinatoken_gateway.provider_attempt_availability', 'SELECT'
						) AS provider_attempt_availability_select,
						has_table_privilege(
							current_user, 'cinatoken_gateway.provider_attempt_availability', 'INSERT'
						) AS provider_attempt_availability_insert,
						has_table_privilege(
							current_user, 'cinatoken_gateway.provider_attempt_availability', 'UPDATE'
						) AS provider_attempt_availability_update,
						has_table_privilege(
							current_user, 'cinatoken_gateway.provider_attempt_availability', 'DELETE'
						) AS provider_attempt_availability_delete,
						has_table_privilege(
							current_user, 'cinatoken_gateway.batches', 'SELECT'
						) AS batches_select,
						has_table_privilege(
							current_user, 'cinatoken_gateway.batches', 'INSERT'
						) AS batches_insert,
						has_table_privilege(
							current_user, 'cinatoken_gateway.batches', 'UPDATE'
						) AS batches_update,
						has_table_privilege(
							current_user, 'cinatoken_gateway.batches', 'DELETE'
						) AS batches_delete,
						has_table_privilege(
							current_user, 'cinatoken_gateway.batch_items', 'SELECT'
						) AS batch_items_select,
						has_table_privilege(
							current_user, 'cinatoken_gateway.batch_items', 'INSERT'
						) AS batch_items_insert,
						has_table_privilege(
							current_user, 'cinatoken_gateway.batch_items', 'UPDATE'
						) AS batch_items_update,
						has_table_privilege(
							current_user, 'cinatoken_gateway.batch_items', 'DELETE'
						) AS batch_items_delete,
						has_function_privilege(
							current_user,
							'cinatoken_gateway.delete_provider_attempt_availability_before(timestamptz, integer)',
							'EXECUTE'
						) AS provider_attempt_retention_execute,
						COALESCE(has_table_privilege(
							current_user,
							to_regclass('cinatoken_gateway.user_budget_reservations'),
							'DELETE'
						), FALSE) AS user_budget_reservations_delete,
						has_table_privilege(
							current_user, 'cinatoken_gateway.schema_migrations', 'SELECT'
						) AS migrations_select,
						has_table_privilege(
							current_user, 'cinatoken_gateway.schema_migrations', 'INSERT'
						) AS migrations_insert,
						has_function_privilege(
							current_user,
							'cinatoken_gateway.shared_key_earnings_credit_after_insert_fn()',
							'EXECUTE'
						) AS ledger_trigger_execute
				`;

			const runtimePassed = runtimeContractPassed(runtimeRow);
			return Response.json({
				ok: migratorPassed && runtimePassed,
				migrator: { contract_passed: migratorPassed, ...migratorRow },
				runtime: { contract_passed: runtimePassed, ...runtimeRow },
			}, {
				status: migratorPassed && runtimePassed ? 200 : 502,
				headers: { 'Cache-Control': 'no-store' },
			});
		} catch (error) {
			console.error('cinatoken.hyperdrive_access_probe_failed', {
				error: error instanceof Error ? error.message : 'unknown',
			});
			return Response.json({ ok: false, error: 'access_probe_failed' }, { status: 502 });
		} finally {
			await Promise.all([
				migrator.end({ timeout: 1 }).catch(() => undefined),
				runtime.end({ timeout: 1 }).catch(() => undefined),
			]);
		}
	},
} satisfies {
	fetch(request: Request, env: AccessProbeEnv): Promise<Response>;
};
