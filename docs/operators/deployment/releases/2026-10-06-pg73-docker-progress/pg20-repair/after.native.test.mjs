// Focused, opt-in local ACL regression. Only an owned loopback PostgreSQL cluster is used.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const historyGuard = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-earnings-history-guard.sql', import.meta.url);
const repairJobs = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-usage-repair-jobs.sql', import.meta.url);

function migratorClient(cluster, password) {
	return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
		username: 'cinatoken_gateway_migrator', password, ssl: false, max: 1,
		prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
		max_lifetime: 0, backoff: 0, onnotice() {},
		connection: { application_name: 'cinatoken-shared-usage-runtime-grant' } });
}

async function privileges(sql) {
	const [row] = await sql.unsafe(`SELECT
		pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
			'${schema}.shared_key_usage_repair_jobs',
			'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN') AS repair_table,
		pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
			'${schema}.enqueue_shared_key_usage_repair()', 'EXECUTE') AS enqueue,
		pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
			'${schema}.repair_one_shared_key_usage()', 'EXECUTE') AS repair,
		pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
			'${schema}.users', 'SELECT') AS ordinary_users_select`);
	return row;
}

async function pg73State(sql) {
	const [state] = await sql.unsafe(`SELECT current_user AS current_role,
		(SELECT owner.rolname FROM pg_catalog.pg_namespace AS namespace
		 JOIN pg_catalog.pg_roles AS owner ON owner.oid=namespace.nspowner
		 WHERE namespace.nspname='${schema}') AS schema_owner,
		(SELECT count(*)::int FROM ${schema}.schema_migrations) AS migration_count,
		(SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\\n'
		 ORDER BY version COLLATE "C")) FROM ${schema}.schema_migrations) AS migration_md5,
		pg_catalog.to_regclass('${schema}.config_change_audit') IS NOT NULL AS audit_table,
		EXISTS (SELECT 1 FROM ${schema}.schema_migrations
		 WHERE version='0074_config_change_audit.sql') AS audit_ledger`);
	assert.deepEqual(state, { current_role: 'cinatoken_gateway_migrator',
		schema_owner: 'cinatoken_gateway_migrator', migration_count: 73,
		migration_md5: 'ca1ea96a1b4bcd0675642f30dcf48042', audit_table: false, audit_ledger: false });
}

async function runtimeState(sql) {
	const [role] = await sql.unsafe(`SELECT oid::text AS oid, rolname AS name,
		rolcanlogin AS can_login, rolsuper AS is_superuser, rolcreatedb AS can_create_database,
		rolcreaterole AS can_create_role, rolreplication AS can_replicate,
		rolbypassrls AS can_bypass_rls, rolinherit AS inherits,
		rolconnlimit AS connection_limit, rolvaliduntil::text AS valid_until, rolconfig AS config
		FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime'`);
	assert.ok(role);
	const memberships = await sql.unsafe(`SELECT parent.rolname AS role_name,
		member.rolname AS member_name, grantor.rolname AS grantor_name,
		memberships.admin_option, memberships.inherit_option, memberships.set_option
		FROM pg_catalog.pg_auth_members AS memberships
		JOIN pg_catalog.pg_roles AS parent ON parent.oid=memberships.roleid
		JOIN pg_catalog.pg_roles AS member ON member.oid=memberships.member
		JOIN pg_catalog.pg_roles AS grantor ON grantor.oid=memberships.grantor
		WHERE memberships.member=$1::oid OR memberships.roleid=$1::oid
		ORDER BY memberships.roleid, memberships.member, memberships.grantor`, [role.oid]);
	return { role, memberships: [...memberships] };
}

async function repairAclState(sql) {
	const acl = await sql.unsafe(`SELECT 'table' AS kind, relname AS name,
		relowner::text AS owner, relacl::text AS acl
		FROM pg_catalog.pg_class WHERE oid IN
		('${schema}.shared_key_usage_repair_jobs'::regclass, '${schema}.users'::regclass)
		UNION ALL SELECT 'function', proname, proowner::text, proacl::text
		FROM pg_catalog.pg_proc WHERE oid IN
		('${schema}.enqueue_shared_key_usage_repair()'::regprocedure,
		 '${schema}.repair_one_shared_key_usage()'::regprocedure)
		ORDER BY kind, name`);
	return { effective: await privileges(sql), acl: [...acl] };
}

// The ordinary PG73 bridge intentionally refuses role memberships. This case
// must reach the real reconciler's earlier direct LOGIN/membership rejection.
async function rejectMembershipBeforeRuntimeGrant({ cluster, migrator, databaseUrl }) {
	const target = new URL(databaseUrl);
	assert.ok(cluster?.owned && Number.isSafeInteger(cluster.port)
		&& ['postgres:', 'postgresql:'].includes(target.protocol)
		&& target.hostname === '127.0.0.1' && Number(target.port) === cluster.port
		&& target.username === 'cinatoken_gateway_migrator' && target.pathname === '/postgres');
	await listPg73Migrations();
	await pg73State(migrator);
	const original = await runtimeState(cluster.admin);
	assert.ok(!original.role.can_login && !original.role.is_superuser
		&& !original.role.can_create_database && !original.role.can_create_role
		&& !original.role.can_replicate && !original.role.can_bypass_rls);
	assert.deepEqual(original.memberships.map(({ role_name, member_name }) => ({ role_name, member_name })),
		[{ role_name: 'shared_usage_repair_shadow', member_name: 'cinatoken_gateway_runtime' }]);
	const beforeAcl = await repairAclState(cluster.admin);
	assert.equal(beforeAcl.effective.repair_table, true);
	const auditMigration = '0074_config_change_audit.sql';
	const auditBody = await readFile(new URL(auditMigration, migrations), 'utf8');
	let auditAttempted = false;
	let loginAttempted = false;
	try {
		auditAttempted = true;
		await migrator.begin(async tx => {
			await tx.unsafe(auditBody).simple();
			await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [auditMigration]);
		});
		loginAttempted = true;
		await cluster.admin.unsafe('ALTER ROLE cinatoken_gateway_runtime LOGIN');
		assert.deepEqual(await runtimeState(cluster.admin),
			{ role: { ...original.role, can_login: true }, memberships: original.memberships });
		await assert.rejects(grantPostgresRuntime({ DATABASE_URL: databaseUrl }),
			error => error?.code === 'P0001'
				&& error?.message === 'Runtime must be a restricted direct LOGIN without role memberships');
		assert.deepEqual(await runtimeState(cluster.admin),
			{ role: { ...original.role, can_login: true }, memberships: original.memberships });
		assert.deepEqual(await repairAclState(cluster.admin), beforeAcl);
	} finally {
		try {
			if (auditAttempted) {
				await migrator.begin(async tx => {
					await tx.unsafe(`DROP TABLE IF EXISTS ${schema}.config_change_audit`);
					await tx.unsafe(`DELETE FROM ${schema}.schema_migrations WHERE version=$1`, [auditMigration]);
				});
			}
			await pg73State(migrator);
		} finally {
			if (loginAttempted) await cluster.admin.unsafe('ALTER ROLE cinatoken_gateway_runtime NOLOGIN');
			assert.deepEqual(await runtimeState(cluster.admin), original);
			assert.deepEqual(await repairAclState(cluster.admin), beforeAcl);
		}
	}
}

test('runtime grant reruns keep optional shared-key repair table and definers owner-only',
	{ timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
		const cluster = await startNativePostgres();
		const clients = [];
		try {
			const password = randomBytes(24).toString('hex');
			await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${password}';
				CREATE ROLE cinatoken_gateway_runtime NOLOGIN;
				CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
				REVOKE CREATE ON SCHEMA public FROM PUBLIC;
				GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
			const migrator = migratorClient(cluster, password);
			clients.push(migrator);
			const databaseUrl = `postgres://cinatoken_gateway_migrator:${password}@127.0.0.1:${cluster.port}/postgres`;
			const grantRuntime = () => grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: databaseUrl });
			await migrator.unsafe(`CREATE TABLE ${schema}.schema_migrations (
				version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
			const files = await listPg73Migrations();
			assert.equal(files.length, 73);
			assert.equal(files.at(-1), '0073_recovery_api_key_workspace_lock.sql');
			for (const name of files) {
				const body = await readFile(new URL(name, migrations), 'utf8');
				await migrator.begin(async tx => {
					await tx.unsafe(body).simple();
					await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
				});
			}
			await grantRuntime();

			// A failed partial installation must roll back the broad grant transaction.
			await migrator.unsafe(`CREATE TABLE ${schema}.shared_key_usage_repair_jobs (id text PRIMARY KEY);
				REVOKE ALL ON ${schema}.shared_key_usage_repair_jobs FROM cinatoken_gateway_runtime;`).simple();
			await assert.rejects(grantRuntime(),
				/Shared-key usage repair installation is incomplete/);
			assert.equal((await cluster.admin.unsafe(`SELECT pg_catalog.has_table_privilege(
				'cinatoken_gateway_runtime', '${schema}.shared_key_usage_repair_jobs', 'SELECT') AS allowed`))[0].allowed, false);
			await migrator.unsafe(`DROP TABLE ${schema}.shared_key_usage_repair_jobs`);

			for (const [setting, url] of [
				['cinatoken.shared_key_earnings_history_guard_activation', historyGuard],
				['cinatoken.shared_key_usage_repair_activation', repairJobs],
			]) {
				await migrator.begin(async tx => {
					await tx.unsafe(`SET LOCAL ${setting} = 'reviewed-v1'`);
					await tx.unsafe(await readFile(url, 'utf8')).simple();
				});
			}
			assert.deepEqual(await privileges(cluster.admin), {
				repair_table: false, enqueue: false, repair: false, ordinary_users_select: true,
			});
			await grantRuntime();
			await grantRuntime();
			assert.deepEqual(await privileges(cluster.admin), {
				repair_table: false, enqueue: false, repair: false, ordinary_users_select: true,
			});
			const runtime = cluster.client('shared-usage-runtime-acl');
			await runtime.unsafe('SET ROLE cinatoken_gateway_runtime');
			await assert.rejects(runtime.unsafe(`SELECT * FROM ${schema}.shared_key_usage_repair_jobs`),
				cause => cause.code === '42501');
			await assert.rejects(runtime.unsafe(`SELECT ${schema}.repair_one_shared_key_usage()`),
				cause => cause.code === '42501');
			await migrator.unsafe(`ALTER FUNCTION ${schema}.repair_one_shared_key_usage() SECURITY INVOKER`);
			await assert.rejects(grantRuntime(),
				/Shared-key usage repair catalog differs/);
			await migrator.unsafe(`ALTER FUNCTION ${schema}.repair_one_shared_key_usage() SECURITY DEFINER`);
			await grantRuntime();

			// REVOKE from the role alone cannot close privileges inherited elsewhere.
			await cluster.admin.unsafe('CREATE ROLE shared_usage_repair_shadow NOLOGIN');
			await migrator.unsafe(`GRANT SELECT ON ${schema}.shared_key_usage_repair_jobs TO shared_usage_repair_shadow;
				GRANT EXECUTE ON FUNCTION ${schema}.repair_one_shared_key_usage() TO shared_usage_repair_shadow;`).simple();
			assert.equal((await privileges(cluster.admin)).repair_table, false);
			await assert.rejects(grantRuntime(),
				/Shared-key usage repair ACL differs/);
			await cluster.admin.unsafe('GRANT shared_usage_repair_shadow TO cinatoken_gateway_runtime');
			assert.equal((await privileges(cluster.admin)).repair_table, true);
			await rejectMembershipBeforeRuntimeGrant({ cluster, migrator, databaseUrl });
			await cluster.admin.unsafe('REVOKE shared_usage_repair_shadow FROM cinatoken_gateway_runtime');
			await migrator.unsafe(`REVOKE SELECT ON ${schema}.shared_key_usage_repair_jobs FROM shared_usage_repair_shadow;
				REVOKE EXECUTE ON FUNCTION ${schema}.repair_one_shared_key_usage() FROM shared_usage_repair_shadow;`).simple();
			await grantRuntime();
			assert.deepEqual(await privileges(cluster.admin), {
				repair_table: false, enqueue: false, repair: false, ordinary_users_select: true,
			});
		} finally {
			await Promise.allSettled(clients.map(client => client.end({ timeout: 1 })));
			await cluster.cleanup();
		}
	});
