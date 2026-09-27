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
				WHERE version = '0073_recovery_api_key_workspace_lock.sql'
			) AS applied
		`;
		if (!migration?.applied) {
			throw new Error('PostgreSQL migrations are incomplete; 0073_recovery_api_key_workspace_lock.sql is required (migration=0073).');
		}

		await sql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(${GRANT_LOCK_KEY})`;
			// The review-only v356 capability table carries one-request bearer
			// proof. This legacy reconciler broadly grants gateway table DML and
			// function EXECUTE, so reject a rerun before any ACL mutation.
			const [requestCapability] = await tx<Array<{ installed: boolean }>>`
				SELECT (
					pg_catalog.to_regclass(
						'cinatoken_gateway.authenticated_request_capabilities_v356'
					) IS NOT NULL
					OR pg_catalog.to_regprocedure(
						'cinatoken_gateway.issue_request_capability_v356(text,text,text)'
					) IS NOT NULL
					OR pg_catalog.to_regprocedure(
						'cinatoken_gateway.claim_request_capability_v356(text,text,text)'
					) IS NOT NULL
				) AS installed
			`;
			if (requestCapability?.installed) {
				throw new Error('Request capability v356 is installed; legacy broad runtime grants would reopen its privileges.');
			}
			// The buyer settlement cutover installs this migrator-owned marker in
			// the same locked transaction as its financial revokes. Never commit
			// the legacy broad grant after that cutover, even on an ordinary rerun.
			const [buyerSplit] = await tx<Array<{ active: boolean }>>`
				SELECT pg_catalog.to_regprocedure(
					'cinatoken_gateway.buyer_split_grant_policy_v348()'
				) IS NOT NULL AS active
			`;
			if (buyerSplit?.active) {
				throw new Error('Buyer settlement split is active; use the v348 split grant reconciler.');
			}
			await tx.unsafe(`
				REVOKE ALL ON SCHEMA ${GATEWAY_SCHEMA} FROM PUBLIC;
				GRANT USAGE ON SCHEMA ${GATEWAY_SCHEMA} TO ${GATEWAY_RUNTIME_ROLE};
				GRANT SELECT, INSERT, UPDATE, DELETE
					ON ALL TABLES IN SCHEMA ${GATEWAY_SCHEMA} TO ${GATEWAY_RUNTIME_ROLE};
				REVOKE ALL ON TABLE ${GATEWAY_SCHEMA}.schema_migrations FROM ${GATEWAY_RUNTIME_ROLE};

				-- Recovery schema is present for a controlled cutover, but the ordinary
				-- runtime cannot create/claim facts or receipts while C03 is disabled.
				-- This must follow the broad legacy grant on every rerun.
				REVOKE ALL ON TABLE
					${GATEWAY_SCHEMA}.request_dispatch_intents,
					${GATEWAY_SCHEMA}.request_usage_settlements,
					${GATEWAY_SCHEMA}.request_usage_settlement_outbox,
					${GATEWAY_SCHEMA}.request_usage_recovery_jobs,
					${GATEWAY_SCHEMA}.request_usage_commit_receipts
				FROM ${GATEWAY_RUNTIME_ROLE};

				-- 审计 M8：append-only 账本表收回 UPDATE/DELETE（应用与触发器仅 INSERT/SELECT；
				-- 无任何更新/删除路径 —— 收回后，被攻陷的 worker 也无法改写历史流水）
				REVOKE UPDATE, DELETE ON TABLE
					${GATEWAY_SCHEMA}.api_key_request_logs,
					${GATEWAY_SCHEMA}.shared_key_earnings,
					${GATEWAY_SCHEMA}.portal_ledger_entries,
					${GATEWAY_SCHEMA}.request_preset_versions,
					${GATEWAY_SCHEMA}.guardrail_versions,
					${GATEWAY_SCHEMA}.route_data_policy_audit,
					${GATEWAY_SCHEMA}.identity_event_inbox,
					${GATEWAY_SCHEMA}.generation_feedback,
					${GATEWAY_SCHEMA}.provider_attempt_availability
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
					${GATEWAY_SCHEMA}.user_budget_reservations,
					${GATEWAY_SCHEMA}.batches,
					${GATEWAY_SCHEMA}.batch_items
				FROM ${GATEWAY_RUNTIME_ROLE};
				GRANT USAGE, SELECT, UPDATE
					ON ALL SEQUENCES IN SCHEMA ${GATEWAY_SCHEMA} TO ${GATEWAY_RUNTIME_ROLE};
				REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${GATEWAY_SCHEMA} FROM PUBLIC;
				GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${GATEWAY_SCHEMA} TO ${GATEWAY_RUNTIME_ROLE};
				-- SECURITY DEFINER helper is reserved for the eventual recovery role.
				REVOKE EXECUTE ON FUNCTION
					${GATEWAY_SCHEMA}.recovery_api_key_workspace_matches(text, text)
				FROM ${GATEWAY_RUNTIME_ROLE};
				-- The review-only v371 buyer accountant is dedicated to the buyer
				-- LOGIN. A broad grant rerun must not reopen runtime EXECUTE.
				DO $runtime_buyer_window_privilege$
				BEGIN
					IF pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.settle_legacy_buyer_windowed_v371(text,text)') IS NOT NULL THEN
						EXECUTE 'REVOKE EXECUTE ON FUNCTION ${GATEWAY_SCHEMA}.settle_legacy_buyer_windowed_v371(text,text) FROM ${GATEWAY_RUNTIME_ROLE}';
					END IF;
				END
				$runtime_buyer_window_privilege$;
				-- The optional legacy log guard is installed only at recovery cutover.
				-- A rerun of this broad grant must not expose its definer entry point.
				DO $runtime_recovery_guard_privilege$
				BEGIN
					IF pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.guard_fact_owned_usage_log()') IS NOT NULL THEN
						EXECUTE 'REVOKE EXECUTE ON FUNCTION ${GATEWAY_SCHEMA}.guard_fact_owned_usage_log() FROM ${GATEWAY_RUNTIME_ROLE}';
					END IF;
					IF pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.guard_fact_without_legacy_log()') IS NOT NULL THEN
						EXECUTE 'REVOKE EXECUTE ON FUNCTION ${GATEWAY_SCHEMA}.guard_fact_without_legacy_log() FROM ${GATEWAY_RUNTIME_ROLE}';
					END IF;
					-- Optional C03.5 producer proposals may replace these trigger
					-- functions with migrator-owned SECURITY DEFINER entry points.
					-- Keep the ordinary role unable to attach them to its own table.
					IF pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.guard_request_dispatch_intent()') IS NOT NULL THEN
						EXECUTE 'REVOKE EXECUTE ON FUNCTION ${GATEWAY_SCHEMA}.guard_request_dispatch_intent() FROM ${GATEWAY_RUNTIME_ROLE}';
					END IF;
					IF pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.enqueue_usage_settlement_fact()') IS NOT NULL THEN
						EXECUTE 'REVOKE EXECUTE ON FUNCTION ${GATEWAY_SCHEMA}.enqueue_usage_settlement_fact() FROM ${GATEWAY_RUNTIME_ROLE}';
					END IF;
					END
					$runtime_recovery_guard_privilege$;

				-- The review-only request parent may be installed after formal migration.
				-- A rerun of the broad grants must not turn the ordinary runtime into
				-- a direct parent writer or a SECURITY DEFINER claim caller. Reject a
				-- partial installation and verify effective privileges after revoking.
				DO $runtime_request_parent_privilege$
				DECLARE parent_oid oid;
				DECLARE prepare_oid oid;
				DECLARE claim_oid oid;
				DECLARE classify_oid oid;
				DECLARE runtime_oid oid;
				BEGIN
					SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
						WHERE rolname = '${GATEWAY_RUNTIME_ROLE}';
					parent_oid := pg_catalog.to_regclass('${GATEWAY_SCHEMA}.request_dispatch_requests');
					prepare_oid := pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.prepare_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,integer)');
					claim_oid := pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.claim_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,text)');
					classify_oid := pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.classify_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint)');
					IF parent_oid IS NULL AND prepare_oid IS NULL AND claim_oid IS NULL AND classify_oid IS NULL THEN
						RETURN;
					END IF;
					IF runtime_oid IS NULL OR parent_oid IS NULL OR prepare_oid IS NULL
						OR claim_oid IS NULL OR classify_oid IS NULL THEN
						RAISE EXCEPTION 'Request parent installation is incomplete';
					END IF;
					EXECUTE 'REVOKE ALL ON TABLE ${GATEWAY_SCHEMA}.request_dispatch_requests FROM ${GATEWAY_RUNTIME_ROLE}';
					EXECUTE 'REVOKE EXECUTE ON FUNCTION ${GATEWAY_SCHEMA}.prepare_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,integer) FROM ${GATEWAY_RUNTIME_ROLE}';
					EXECUTE 'REVOKE EXECUTE ON FUNCTION ${GATEWAY_SCHEMA}.claim_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,text) FROM ${GATEWAY_RUNTIME_ROLE}';
					EXECUTE 'REVOKE EXECUTE ON FUNCTION ${GATEWAY_SCHEMA}.classify_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint) FROM ${GATEWAY_RUNTIME_ROLE}';
					IF pg_catalog.has_table_privilege(runtime_oid, parent_oid,
						'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
						OR pg_catalog.has_function_privilege(runtime_oid, prepare_oid, 'EXECUTE')
						OR pg_catalog.has_function_privilege(runtime_oid, claim_oid, 'EXECUTE')
						OR pg_catalog.has_function_privilege(runtime_oid, classify_oid, 'EXECUTE') THEN
						RAISE EXCEPTION 'Ordinary runtime retains request parent privilege';
					END IF;
				END
				$runtime_request_parent_privilege$;

				-- The optional replay registry permanently reserves request IDs. The
				-- broad legacy grant above must never give the ordinary runtime direct
				-- DML or even read access to that table on a grant rerun. Its trigger
				-- functions are invoked by PostgreSQL, not called by this role.
				DO $runtime_replay_privilege$
				DECLARE registry_oid oid;
				DECLARE runtime_oid oid;
				DECLARE function_name text;
				DECLARE function_oid oid;
				BEGIN
					registry_oid := pg_catalog.to_regclass('${GATEWAY_SCHEMA}.request_dispatch_replay_tombstones');
					IF registry_oid IS NULL THEN
						IF pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.guard_request_dispatch_replay_insert()') IS NOT NULL
							OR pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.reject_request_dispatch_replay_mutation()') IS NOT NULL
							OR pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.reserve_request_dispatch_intent_id()') IS NOT NULL
							OR pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.reserve_request_log_replay_id()') IS NOT NULL
							OR pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.guard_request_log_replay_id_update()') IS NOT NULL
							OR pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.reserve_request_dispatch_parent_id()') IS NOT NULL THEN
							RAISE EXCEPTION 'Replay registry installation is incomplete';
						END IF;
						RETURN;
					END IF;
					SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
						WHERE rolname = '${GATEWAY_RUNTIME_ROLE}';
					IF runtime_oid IS NULL THEN
						RAISE EXCEPTION 'Ordinary runtime role is absent';
					END IF;
					EXECUTE 'REVOKE ALL ON TABLE ${GATEWAY_SCHEMA}.request_dispatch_replay_tombstones FROM ${GATEWAY_RUNTIME_ROLE}';
					FOREACH function_name IN ARRAY ARRAY[
						'guard_request_dispatch_replay_insert',
						'reject_request_dispatch_replay_mutation',
						'reserve_request_dispatch_intent_id',
						'reserve_request_log_replay_id',
						'guard_request_log_replay_id_update',
						'reserve_request_dispatch_parent_id'
					] LOOP
						function_oid := pg_catalog.to_regprocedure(
							'${GATEWAY_SCHEMA}.' || function_name || '()');
						IF function_oid IS NULL THEN
							IF function_name <> 'reserve_request_dispatch_parent_id' THEN
								RAISE EXCEPTION 'Replay registry function % is absent', function_name;
							END IF;
							CONTINUE;
						END IF;
						EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION ${GATEWAY_SCHEMA}.%I() FROM ${GATEWAY_RUNTIME_ROLE}', function_name);
						IF pg_catalog.has_function_privilege(runtime_oid, function_oid, 'EXECUTE') THEN
							RAISE EXCEPTION 'Ordinary runtime retains replay function % privilege', function_name;
						END IF;
					END LOOP;
					IF pg_catalog.has_table_privilege(runtime_oid, registry_oid,
						'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
						RAISE EXCEPTION 'Ordinary runtime retains replay registry privilege';
					END IF;
				END
				$runtime_replay_privilege$;

				-- Review-only shared-key repair is migrator-owned. Broad grants above
				-- must not make its job table or SECURITY DEFINER entrypoints
				-- callable by the ordinary runtime on a later grant rerun.
				DO $runtime_shared_key_usage_repair_privilege$
				DECLARE job_oid oid;
				DECLARE enqueue_oid oid;
				DECLARE repair_oid oid;
				DECLARE attempt_oid oid;
				DECLARE requeue_oid oid;
				DECLARE claim_oid oid;
				DECLARE finish_oid oid;
				DECLARE migrator_oid oid;
				DECLARE runtime_oid oid;
				DECLARE repair_consumer_oid oid;
				BEGIN
					job_oid := pg_catalog.to_regclass('${GATEWAY_SCHEMA}.shared_key_usage_repair_jobs');
					enqueue_oid := pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.enqueue_shared_key_usage_repair()');
				repair_oid := pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.repair_one_shared_key_usage()');
					attempt_oid := pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.attempt_one_shared_key_usage_repair()');
					requeue_oid := pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.requeue_shared_key_usage_repair_dead_letter(text,text)');
					claim_oid := pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.claim_one_shared_key_usage_repair()');
					finish_oid := pg_catalog.to_regprocedure('${GATEWAY_SCHEMA}.finish_claimed_shared_key_usage_repair(text,uuid)');
					IF job_oid IS NULL AND enqueue_oid IS NULL AND repair_oid IS NULL
						AND attempt_oid IS NULL AND requeue_oid IS NULL
						AND claim_oid IS NULL AND finish_oid IS NULL THEN
						RETURN;
					END IF;
					SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
						WHERE rolname = '${GATEWAY_MIGRATOR_ROLE}';
					SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
						WHERE rolname = '${GATEWAY_RUNTIME_ROLE}';
					SELECT oid INTO repair_consumer_oid FROM pg_catalog.pg_roles
						WHERE rolname = 'cinatoken_gateway_shared_key_usage_repair_consumer';
					IF migrator_oid IS NULL OR runtime_oid IS NULL OR job_oid IS NULL
						OR enqueue_oid IS NULL OR repair_oid IS NULL
						OR (attempt_oid IS NULL) <> (requeue_oid IS NULL)
						OR (claim_oid IS NULL) <> (finish_oid IS NULL)
						OR (claim_oid IS NOT NULL AND attempt_oid IS NULL) THEN
						RAISE EXCEPTION 'Shared-key usage repair installation is incomplete';
					END IF;
					IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
						WHERE oid = job_oid AND relkind = 'r' AND relowner = migrator_oid)
						OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc
							WHERE oid = enqueue_oid AND prokind = 'f' AND prosecdef AND proowner = migrator_oid)
						OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc
							WHERE oid = repair_oid AND prokind = 'f' AND prosecdef AND proowner = migrator_oid)
						OR (attempt_oid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc
							WHERE oid = attempt_oid AND prokind = 'f' AND prosecdef AND proowner = migrator_oid))
						OR (requeue_oid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc
							WHERE oid = requeue_oid AND prokind = 'f' AND NOT prosecdef AND proowner = migrator_oid))
						OR (claim_oid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc
							WHERE oid = claim_oid AND prokind = 'f' AND prosecdef AND proowner = migrator_oid))
						OR (finish_oid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc
							WHERE oid = finish_oid AND prokind = 'f' AND prosecdef AND proowner = migrator_oid)) THEN
						RAISE EXCEPTION 'Shared-key usage repair catalog differs';
					END IF;
					EXECUTE 'REVOKE ALL ON TABLE ${GATEWAY_SCHEMA}.shared_key_usage_repair_jobs FROM ${GATEWAY_RUNTIME_ROLE}';
					EXECUTE 'REVOKE EXECUTE ON FUNCTION ${GATEWAY_SCHEMA}.enqueue_shared_key_usage_repair() FROM ${GATEWAY_RUNTIME_ROLE}';
					EXECUTE 'REVOKE EXECUTE ON FUNCTION ${GATEWAY_SCHEMA}.repair_one_shared_key_usage() FROM ${GATEWAY_RUNTIME_ROLE}';
					IF attempt_oid IS NOT NULL THEN
						EXECUTE 'REVOKE EXECUTE ON FUNCTION ${GATEWAY_SCHEMA}.attempt_one_shared_key_usage_repair() FROM ${GATEWAY_RUNTIME_ROLE}';
						EXECUTE 'REVOKE EXECUTE ON FUNCTION ${GATEWAY_SCHEMA}.requeue_shared_key_usage_repair_dead_letter(text,text) FROM ${GATEWAY_RUNTIME_ROLE}';
					END IF;
					IF claim_oid IS NOT NULL THEN
						EXECUTE 'REVOKE EXECUTE ON FUNCTION ${GATEWAY_SCHEMA}.claim_one_shared_key_usage_repair() FROM ${GATEWAY_RUNTIME_ROLE}';
						EXECUTE 'REVOKE EXECUTE ON FUNCTION ${GATEWAY_SCHEMA}.finish_claimed_shared_key_usage_repair(text,uuid) FROM ${GATEWAY_RUNTIME_ROLE}';
					END IF;
					IF pg_catalog.has_table_privilege(runtime_oid, job_oid,
						'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
						OR pg_catalog.has_function_privilege(runtime_oid, enqueue_oid, 'EXECUTE')
						OR pg_catalog.has_function_privilege(runtime_oid, repair_oid, 'EXECUTE')
						OR (attempt_oid IS NOT NULL AND
							pg_catalog.has_function_privilege(runtime_oid, attempt_oid, 'EXECUTE'))
						OR (requeue_oid IS NOT NULL AND
							pg_catalog.has_function_privilege(runtime_oid, requeue_oid, 'EXECUTE'))
						OR (claim_oid IS NOT NULL AND
							pg_catalog.has_function_privilege(runtime_oid, claim_oid, 'EXECUTE'))
						OR (finish_oid IS NOT NULL AND
							pg_catalog.has_function_privilege(runtime_oid, finish_oid, 'EXECUTE')) THEN
						RAISE EXCEPTION 'Ordinary runtime retains shared-key usage repair privilege';
					END IF;
					-- A dedicated direct LOGIN may call only the reviewed repair
					-- entrypoints. A
					-- non-inheriting membership could still be reached by SET ROLE.
					IF repair_consumer_oid IS NOT NULL AND (
						NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid = repair_consumer_oid
							AND rolcanlogin AND NOT rolinherit AND NOT rolsuper
							AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
							AND NOT rolbypassrls)
						OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
							WHERE roleid = repair_consumer_oid OR member = repair_consumer_oid)) THEN
						RAISE EXCEPTION 'Shared-key usage repair consumer role differs';
					END IF;
					IF EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c
						CROSS JOIN LATERAL pg_catalog.aclexplode(
							COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS acl
						WHERE c.oid = job_oid AND acl.grantee <> migrator_oid)
					OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p
						CROSS JOIN LATERAL pg_catalog.aclexplode(
							COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS acl
						WHERE (p.oid IN (enqueue_oid,requeue_oid) AND acl.grantee <> migrator_oid)
							OR (p.oid = repair_oid
								AND acl.grantee <> migrator_oid
								AND (attempt_oid IS NOT NULL OR repair_consumer_oid IS NULL
									OR acl.grantee <> repair_consumer_oid
									OR acl.privilege_type <> 'EXECUTE'))
							OR (p.oid = attempt_oid
								AND acl.grantee <> migrator_oid
								AND (claim_oid IS NOT NULL OR repair_consumer_oid IS NULL
									OR acl.grantee <> repair_consumer_oid
									OR acl.privilege_type <> 'EXECUTE'))
							OR (p.oid IN (claim_oid,finish_oid)
								AND acl.grantee <> migrator_oid
								AND (repair_consumer_oid IS NULL OR acl.grantee <> repair_consumer_oid
									OR acl.privilege_type <> 'EXECUTE'))) THEN
						RAISE EXCEPTION 'Shared-key usage repair ACL differs';
					END IF;
				END
				$runtime_shared_key_usage_repair_privilege$;

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
			`Runtime grants applied: schema=${GATEWAY_SCHEMA} role=${GATEWAY_RUNTIME_ROLE} migration=0073`,
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
