// Focused, opt-in local ACL regression. Only an owned loopback PostgreSQL cluster is used.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';

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
			await migrator.unsafe(`CREATE TABLE ${schema}.schema_migrations (
				version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
			const files = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
			assert.equal(files.length, 73);
			assert.equal(files.at(-1), '0073_recovery_api_key_workspace_lock.sql');
			for (const name of files) {
				const body = await readFile(new URL(name, migrations), 'utf8');
				await migrator.begin(async tx => {
					await tx.unsafe(body).simple();
					await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
				});
			}
			await grantPostgresRuntime({ DATABASE_URL: databaseUrl });

			// A failed partial installation must roll back the broad grant transaction.
			await migrator.unsafe(`CREATE TABLE ${schema}.shared_key_usage_repair_jobs (id text PRIMARY KEY);
				REVOKE ALL ON ${schema}.shared_key_usage_repair_jobs FROM cinatoken_gateway_runtime;`).simple();
			await assert.rejects(grantPostgresRuntime({ DATABASE_URL: databaseUrl }),
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
			await grantPostgresRuntime({ DATABASE_URL: databaseUrl });
			await grantPostgresRuntime({ DATABASE_URL: databaseUrl });
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
			await assert.rejects(grantPostgresRuntime({ DATABASE_URL: databaseUrl }),
				/Shared-key usage repair catalog differs/);
			await migrator.unsafe(`ALTER FUNCTION ${schema}.repair_one_shared_key_usage() SECURITY DEFINER`);
			await grantPostgresRuntime({ DATABASE_URL: databaseUrl });

			// REVOKE from the role alone cannot close privileges inherited elsewhere.
			await cluster.admin.unsafe('CREATE ROLE shared_usage_repair_shadow NOLOGIN');
			await migrator.unsafe(`GRANT SELECT ON ${schema}.shared_key_usage_repair_jobs TO shared_usage_repair_shadow;
				GRANT EXECUTE ON FUNCTION ${schema}.repair_one_shared_key_usage() TO shared_usage_repair_shadow;`).simple();
			assert.equal((await privileges(cluster.admin)).repair_table, false);
			await assert.rejects(grantPostgresRuntime({ DATABASE_URL: databaseUrl }),
				/Shared-key usage repair ACL differs/);
			await cluster.admin.unsafe('GRANT shared_usage_repair_shadow TO cinatoken_gateway_runtime');
			assert.equal((await privileges(cluster.admin)).repair_table, true);
			await assert.rejects(grantPostgresRuntime({ DATABASE_URL: databaseUrl }),
				/Ordinary runtime retains shared-key usage repair privilege/);
			await cluster.admin.unsafe('REVOKE shared_usage_repair_shadow FROM cinatoken_gateway_runtime');
			await migrator.unsafe(`REVOKE SELECT ON ${schema}.shared_key_usage_repair_jobs FROM shared_usage_repair_shadow;
				REVOKE EXECUTE ON FUNCTION ${schema}.repair_one_shared_key_usage() FROM shared_usage_repair_shadow;`).simple();
			await grantPostgresRuntime({ DATABASE_URL: databaseUrl });
			assert.deepEqual(await privileges(cluster.admin), {
				repair_table: false, enqueue: false, repair: false, ordinary_users_select: true,
			});
		} finally {
			await Promise.allSettled(clients.map(client => client.end({ timeout: 1 })));
			await cluster.cleanup();
		}
	});
