import postgres from 'postgres';
import {
	GATEWAY_MIGRATOR_ROLE,
	GATEWAY_RUNTIME_ROLE,
	GATEWAY_SCHEMA,
} from './provision-postgres-roles';

const GRANT_LOCK_KEY = 746923553;

export async function grantPostgresRuntime(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const connectionString = env.DATABASE_URL?.trim();
	if (!connectionString) {
		throw new Error('DATABASE_URL is required and must authenticate as the gateway migrator role.');
	}

	const sql = postgres(connectionString, { max: 1, prepare: true });
	try {
		const [identity] = await sql<Array<{ user_name: string; schema_owner: string | null }>>`
			SELECT current_user AS user_name,
				(SELECT owner.rolname
				 FROM pg_namespace AS namespace
				 JOIN pg_roles AS owner ON owner.oid = namespace.nspowner
				 WHERE namespace.nspname = ${GATEWAY_SCHEMA}) AS schema_owner
		`;
		if (identity?.user_name !== GATEWAY_MIGRATOR_ROLE || identity.schema_owner !== GATEWAY_MIGRATOR_ROLE) {
			throw new Error(
				`Runtime grants must run as ${GATEWAY_MIGRATOR_ROLE}, which must own ${GATEWAY_SCHEMA}.`,
			);
		}

		const [migration] = await sql<Array<{ applied: boolean }>>`
			SELECT EXISTS (
				SELECT 1 FROM cinatoken_gateway.schema_migrations
				WHERE version = '0053_workspace_budgets.sql'
			) AS applied
		`;
		if (!migration?.applied) {
			throw new Error('PostgreSQL migrations are incomplete; 0053_workspace_budgets.sql is required (migration=0053).');
		}

		await sql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(${GRANT_LOCK_KEY})`;
			await tx.unsafe(`
				REVOKE ALL ON SCHEMA ${GATEWAY_SCHEMA} FROM PUBLIC;
				GRANT USAGE ON SCHEMA ${GATEWAY_SCHEMA} TO ${GATEWAY_RUNTIME_ROLE};
				GRANT SELECT, INSERT, UPDATE, DELETE
					ON ALL TABLES IN SCHEMA ${GATEWAY_SCHEMA} TO ${GATEWAY_RUNTIME_ROLE};
				REVOKE ALL ON TABLE ${GATEWAY_SCHEMA}.schema_migrations FROM ${GATEWAY_RUNTIME_ROLE};

				-- 审计 M8：append-only 账本表收回 UPDATE/DELETE（应用与触发器仅 INSERT/SELECT；
				-- 无任何更新/删除路径 —— 收回后，被攻陷的 worker 也无法改写历史流水）
				REVOKE UPDATE, DELETE ON TABLE
					${GATEWAY_SCHEMA}.api_key_request_logs,
					${GATEWAY_SCHEMA}.shared_key_earnings,
					${GATEWAY_SCHEMA}.portal_ledger_entries,
					${GATEWAY_SCHEMA}.request_preset_versions,
					${GATEWAY_SCHEMA}.guardrail_versions,
					${GATEWAY_SCHEMA}.route_data_policy_audit,
					${GATEWAY_SCHEMA}.identity_event_inbox
				FROM ${GATEWAY_RUNTIME_ROLE};

				-- Endpoint apply uses a separately provisioned operator identity. The
				-- public runtime must not be able to manufacture immutable provenance.
				REVOKE INSERT, UPDATE, DELETE ON TABLE
					${GATEWAY_SCHEMA}.model_endpoint_backfill_database_identity,
					${GATEWAY_SCHEMA}.model_endpoint_backfill_trust_registry,
					${GATEWAY_SCHEMA}.model_endpoint_backfill_runs,
					${GATEWAY_SCHEMA}.model_endpoint_evidence_attestations
				FROM ${GATEWAY_RUNTIME_ROLE};
				-- Budget reservations are mutable state machines, but deletion would
				-- erase the evidence used to reconcile admission and settlement.
				REVOKE DELETE ON TABLE
					${GATEWAY_SCHEMA}.guardrail_budget_windows,
					${GATEWAY_SCHEMA}.guardrail_budget_reservations,
					${GATEWAY_SCHEMA}.user_budget_reservations
				FROM ${GATEWAY_RUNTIME_ROLE};
				GRANT USAGE, SELECT, UPDATE
					ON ALL SEQUENCES IN SCHEMA ${GATEWAY_SCHEMA} TO ${GATEWAY_RUNTIME_ROLE};
				REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${GATEWAY_SCHEMA} FROM PUBLIC;
				GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${GATEWAY_SCHEMA} TO ${GATEWAY_RUNTIME_ROLE};

				-- Future tables fail closed for writes. Every migration batch must finish
				-- by rerunning this grant step, which explicitly grants existing business
				-- tables and then narrows immutable/privileged tables above.
				ALTER DEFAULT PRIVILEGES IN SCHEMA ${GATEWAY_SCHEMA}
					REVOKE INSERT, UPDATE, DELETE ON TABLES FROM ${GATEWAY_RUNTIME_ROLE};
				ALTER DEFAULT PRIVILEGES IN SCHEMA ${GATEWAY_SCHEMA}
					GRANT SELECT ON TABLES TO ${GATEWAY_RUNTIME_ROLE};
				ALTER DEFAULT PRIVILEGES IN SCHEMA ${GATEWAY_SCHEMA}
					GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${GATEWAY_RUNTIME_ROLE};
				ALTER DEFAULT PRIVILEGES IN SCHEMA ${GATEWAY_SCHEMA}
					REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
				ALTER DEFAULT PRIVILEGES IN SCHEMA ${GATEWAY_SCHEMA}
					GRANT EXECUTE ON FUNCTIONS TO ${GATEWAY_RUNTIME_ROLE};
			`);
		});

		console.log(
			`Runtime grants applied: schema=${GATEWAY_SCHEMA} role=${GATEWAY_RUNTIME_ROLE} migration=0051`,
		);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/')}`) {
	grantPostgresRuntime().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
