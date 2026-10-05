/** Real PostgreSQL SQL and SET ROLE privileges in local PGlite WASM.
 * This does not establish native sockets, pooling or multi-session isolation. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFinancialEngine } from '../test-support/postgres-financial-engine.mjs';
import { createPostgresSystemConfigRepository } from './postgres/system-config.impl.ts';

// Normal npm/CI runs use the pinned test dependency. Local audit runs may reuse
// an existing ESM installation without installing or contacting a database.
process.env.GATEWAY_PGLITE_MODULE ??= fileURLToPath(import.meta.resolve('@electric-sql/pglite'));

const role = 'fixture_config_audit_runtime';
const nowIso = '2026-10-05T00:00:00.000Z';
const input = (auditId, key = 'BUSINESS_TIMEZONE', value = 'UTC') => ({
	auditId, key, value, actorKind: 'console', actorId: 'console:fixture', nowIso,
});

test('configuration writes preserve INSERT-only audit ACL with actual PostgreSQL roles', async (t) => {
	const f = await createFinancialEngine();
	const repo = createPostgresSystemConfigRepository(f.client);
	try {
		assert.equal(f.migrations.at(-1), '0081_tools_config_group_audit.sql');
		await f.pg.exec(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
			GRANT USAGE ON SCHEMA cinatoken_gateway TO ${role};
			GRANT SELECT, INSERT, UPDATE ON cinatoken_gateway.system_config TO ${role};
			GRANT INSERT ON cinatoken_gateway.config_change_audit TO ${role};
			GRANT SELECT, UPDATE(id) ON cinatoken_gateway.system_config_write_mutex TO ${role};`);
		const state = async () => ({
			config: (await f.pg.query('SELECT key,value,revision,updated_at::text FROM cinatoken_gateway.system_config ORDER BY key')).rows,
			audit: (await f.pg.query('SELECT * FROM cinatoken_gateway.config_change_audit ORDER BY id')).rows,
		});
		async function asRuntime(callback) {
			await f.pg.exec(`SET ROLE ${role}`);
			try { return await callback(); }
			finally { await f.pg.exec('RESET ROLE'); }
		}
		const revision = async (key) => (await f.pg.query('SELECT revision FROM cinatoken_gateway.system_config WHERE key=$1', [key])).rows[0]?.revision;
		function assertCommitted(before, after, key, value) {
			assert.equal(after.config.find(row => row.key === key)?.value, value);
			assert.equal(after.audit.length, before.audit.length + 1);
			assert.match(after.config.find(row => row.key === key).revision, /^[0-9a-f-]{36}$/);
			assert.notEqual(after.config.find(row => row.key === key).revision, before.config.find(row => row.key === key)?.revision);
		}

		await t.test('INSERT-only grants accept a constant receipt and reject RETURNING id and audit reads/mutations', async () => {
			const privileges = (await f.pg.query(`SELECT
				has_table_privilege($1,'cinatoken_gateway.config_change_audit','INSERT') AS insert,
				has_table_privilege($1,'cinatoken_gateway.config_change_audit','SELECT') AS select,
				has_column_privilege($1,'cinatoken_gateway.config_change_audit','id','SELECT') AS select_id,
				has_table_privilege($1,'cinatoken_gateway.config_change_audit','UPDATE') AS update,
				has_table_privilege($1,'cinatoken_gateway.config_change_audit','DELETE') AS delete`, [role])).rows[0];
			assert.deepEqual(privileges, { insert: true, select: false, select_id: false, update: false, delete: false });
			const sql = `INSERT INTO cinatoken_gateway.config_change_audit
				(id,config_key,action,actor_kind,actor_id,created_at)
				VALUES($1,'BUSINESS_TIMEZONE','set','console','console:fixture',$2)`;
			await asRuntime(async () => {
				assert.deepEqual((await f.pg.query(sql + ' RETURNING 1 AS inserted', ['constant-receipt', nowIso])).rows, [{ inserted: 1 }]);
				for (const denied of [
					() => f.pg.query(sql + ' RETURNING id', ['denied-column-receipt', nowIso]),
					() => f.pg.query('SELECT id FROM cinatoken_gateway.config_change_audit'),
					() => f.pg.query("UPDATE cinatoken_gateway.config_change_audit SET actor_id='changed'"),
					() => f.pg.query('DELETE FROM cinatoken_gateway.config_change_audit'),
				]) await assert.rejects(denied, error => error.code === '42501');
			});
			assert.equal((await state()).audit.length, 1);
		});

		await t.test('ordinary repository creates and updates configuration with the same INSERT-only role', async () => {
			for (const [id, value] of [['ordinary-create', 'UTC'], ['ordinary-update', 'Asia/Tokyo']]) {
				const before = await state();
				await asRuntime(() => repo.upsertSystemConfigValueWithAudit(input(id, 'BUSINESS_TIMEZONE', value)));
				assertCommitted(before, await state(), 'BUSINESS_TIMEZONE', value);
			}
		});

		await t.test('CAS repository updates only the matched revision and rejects stale or repeated absent-row creates', async () => {
			const expectedRevision = await revision('BUSINESS_TIMEZONE');
			const before = await state();
			const won = await asRuntime(() => repo.upsertSystemConfigValueWithAuditIfRevision({ ...input('cas-update', 'BUSINESS_TIMEZONE', 'Asia/Shanghai'), expectedRevision }));
			assert.equal(won.committed, true);
			assert.equal(won.revision, await revision('BUSINESS_TIMEZONE'));
			assertCommitted(before, await state(), 'BUSINESS_TIMEZONE', 'Asia/Shanghai');
			const after = await state();
			assert.deepEqual(await asRuntime(() => repo.upsertSystemConfigValueWithAuditIfRevision({ ...input('cas-stale'), expectedRevision })), { committed: false, revision: null });
			assert.deepEqual(await state(), after);
			const key = 'fixture_missing_config';
			const created = await asRuntime(() => repo.upsertSystemConfigValueWithAuditIfRevision({ ...input('cas-create', key), expectedRevision: null }));
			assert.equal(created.committed, true);
			assert.equal(created.revision, await revision(key));
			const createdState = await state();
			assert.deepEqual(await asRuntime(() => repo.upsertSystemConfigValueWithAuditIfRevision({ ...input('cas-recreate', key), expectedRevision: null })), { committed: false, revision: null });
			assert.deepEqual(await state(), createdState);
		});

		for (const mode of ['ordinary-create', 'ordinary-update', 'cas-create', 'cas-update']) {
			await t.test(`${mode} rolls back configuration and revision when an actual audit constraint rejects INSERT`, async () => {
				const before = await state();
				const key = mode.endsWith('create') ? `fixture_${mode}` : 'BUSINESS_TIMEZONE';
				const write = input('constant-receipt', key, 'replacement'); // Existing audit PK forces failure.
				await assert.rejects(asRuntime(() => mode.startsWith('ordinary')
					? repo.upsertSystemConfigValueWithAudit(write)
					: repo.upsertSystemConfigValueWithAuditIfRevision({ ...write, expectedRevision: mode.endsWith('create') ? null : before.config.find(row => row.key === key).revision })), error => error.code === '23505');
				assert.deepEqual(await state(), before);
				assert.equal(f.transactions.at(-1).state, 'rolled_back');
			});
		}

		await f.pg.exec(`CREATE FUNCTION cinatoken_gateway.fixture_skip_config_audit() RETURNS trigger
			LANGUAGE plpgsql AS $$ BEGIN IF NEW.id LIKE 'skip-%' THEN RETURN NULL; END IF; RETURN NEW; END $$;
			CREATE TRIGGER fixture_skip_config_audit BEFORE INSERT ON cinatoken_gateway.config_change_audit
			FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.fixture_skip_config_audit();`);
		for (const mode of ['ordinary', 'cas']) {
			await t.test(`${mode} rolls back an ignored audit insert instead of committing a configuration-only write`, async () => {
				const before = await state();
				const write = input(`skip-${mode}`, 'BUSINESS_TIMEZONE', 'replacement');
				await assert.rejects(asRuntime(() => mode === 'ordinary'
					? repo.upsertSystemConfigValueWithAudit(write)
					: repo.upsertSystemConfigValueWithAuditIfRevision({ ...write, expectedRevision: before.config.find(row => row.key === write.key).revision })), /Config audit did not commit/);
				assert.deepEqual(await state(), before);
			});
		}

		for (const mode of ['ordinary', 'cas']) {
			await t.test(`${mode} rejects a corrupt driver receipt and rolls back the actual audit/config INSERTs`, async () => {
				for (const receipt of [[{ inserted: 0 }], [{ inserted: '1' }], [{ inserted: 1 }, { inserted: 1 }]]) {
					const before = await state();
					const raw = { begin: callback => f.client.raw.begin(tx => callback({
						async unsafe(sql, values) {
							const rows = await tx.unsafe(sql, values);
							return sql.includes('INSERT INTO cinatoken_gateway.config_change_audit') ? receipt : rows;
						},
					})) };
					const corrupt = createPostgresSystemConfigRepository({ ...f.client, raw });
					const write = input(`corrupt-${mode}`, 'BUSINESS_TIMEZONE', 'replacement');
					await assert.rejects(asRuntime(() => mode === 'ordinary'
						? corrupt.upsertSystemConfigValueWithAudit(write)
						: corrupt.upsertSystemConfigValueWithAuditIfRevision({ ...write, expectedRevision: before.config.find(row => row.key === write.key).revision })), /Config audit did not commit/);
					assert.deepEqual(await state(), before);
				}
			});
		}
	} finally { await f.pg.close(); }
});
