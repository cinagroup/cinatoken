/** Actual PostgreSQL SQL + formal migrations in local WASM only. Native wire,
 * roles, pooling, two concurrent sessions and lock scheduling remain separate gates. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFinancialEngine } from '../test-support/postgres-financial-engine.mjs';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../route-data-policy.ts';
import { createPostgresRouteDataPoliciesRepository } from './postgres/route-data-policies.impl.ts';
import { RouteDataPolicyWriteConflictError } from './route-data-policy-types.ts';

const instant = '2026-10-01T09:00:00.123456Z';
test('route data policy conditional writes on actual migrated PostgreSQL schema', async (t) => {
	const f = await createFinancialEngine();
	const raw = Object.assign({}, f.client.raw, { typed: (value) => value });
	const repo = createPostgresRouteDataPoliciesRepository({ ...f.client, raw });
	try {
		await f.pg.exec(`INSERT INTO cinatoken_gateway.models(id,display_name) VALUES('Model','Model');
			INSERT INTO cinatoken_gateway.providers(id,name,api_key,endpoints,shared_channel_type)
			VALUES('Provider-A','Provider','synthetic-credential','{"openai":"https://provider.example.invalid/v1"}',NULL),('Provider-B','Other','synthetic-other','{}',NULL);
			INSERT INTO cinatoken_gateway.model_routes(id,model_id,provider_id,provider_model_name,upstream_protocol,upstream_operation,adapter,custom_params)
			VALUES('Route-A','Model','Provider-A','upstream-model','openai','chat.completions','passthrough','{"temperature":0.2}');
			CREATE TABLE public.route_data_policies(LIKE cinatoken_gateway.route_data_policies INCLUDING DEFAULTS INCLUDING INDEXES);
			CREATE TEMP TABLE route_data_policies(LIKE cinatoken_gateway.route_data_policies INCLUDING DEFAULTS INCLUDING INDEXES);
			CREATE TABLE public.route_data_policy_audit(LIKE cinatoken_gateway.route_data_policy_audit INCLUDING DEFAULTS INCLUDING INDEXES);
			CREATE TEMP TABLE route_data_policy_audit(LIKE cinatoken_gateway.route_data_policy_audit INCLUDING DEFAULTS INCLUDING INDEXES);
			SET search_path TO pg_catalog,public,pg_temp,cinatoken_gateway;
			SET TIME ZONE 'Asia/Singapore';`);
		const subjectReadSet = {
			route: (await f.pg.query('SELECT * FROM cinatoken_gateway.model_routes')).rows[0],
			provider: (await f.pg.query("SELECT * FROM cinatoken_gateway.providers WHERE id='Provider-A'")).rows[0],
		};
		const subjectFingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(subjectReadSet.route, subjectReadSet.provider);
		let audit = 0;
		const input = async () => ({
			id: 'audit-' + ++audit,
			routeTargetId: 'Route-A',
			subjectFingerprint,
			retentionDays: 0,
			trainingAllowed: false,
			zdrSupported: true,
			evidenceUrl: 'https://provider.example.invalid/policy',
			verifiedBy: 'Admin',
			verifiedAt: instant,
			expiresAt: '2099-01-01T00:00:00.654321Z',
			status: 'verified',
			actorId: 'Admin',
			nowIso: instant,
			precondition: {
				currentSubjectFingerprint: subjectFingerprint,
				subjectReadSet: structuredClone(subjectReadSet),
				priorPolicy: await repo.getByRouteTargetId('Route-A'),
			},
		});
		const state = async () => ({
			rows: (await f.pg.query('SELECT * FROM cinatoken_gateway.route_data_policies')).rows,
			audit: (await f.pg.query('SELECT * FROM cinatoken_gateway.route_data_policy_audit ORDER BY id')).rows,
		});
		await t.test('absent creation and exact six-microsecond UTC reads are independent of session timezone and search path', async () => {
			const row = await repo.upsertWithAudit(await input());
			assert.equal(row.verified_at, instant);
			assert.equal(row.updated_at, instant);
			assert.equal(row.expires_at, '2099-01-01T00:00:00.654321Z');
			assert.equal((await repo.listAll())[0].verified_at, instant);
			assert.equal((await repo.getByRouteTargetId('Route-A')).verified_at, instant);
			assert.equal((await repo.getByRouteTargetIds(['Route-A']))[0].verified_at, instant);
			assert.equal((await repo.listAudit('Route-A'))[0].created_at, instant);
			for (const schema of ['public', 'pg_temp'])
				for (const table of ['route_data_policies', 'route_data_policy_audit'])
					assert.equal((await f.pg.query(`SELECT * FROM ${schema}.${table}`)).rows.length, 0);
		});
		await t.test('all thirteen raw policy fields are compared, including microseconds and byte case', async () => {
			const columns = [
				'route_target_id',
				'subject_fingerprint',
				'retention_days',
				'training_allowed',
				'zdr_supported',
				'evidence_url',
				'verified_by',
				'verified_at',
				'expires_at',
				'status',
				'invalidated_at',
				'invalidation_reason',
				'updated_at',
			];
			for (const column of columns) {
				const next = await input(),
					before = await state();
				const prior = next.precondition.priorPolicy;
				prior[column] =
					column === 'route_target_id'
						? 'route-a'
						: column === 'retention_days'
							? 9
							: column === 'training_allowed' || column === 'zdr_supported'
								? !prior[column]
								: column === 'status'
									? 'unknown'
									: column === 'subject_fingerprint'
										? 'b'.repeat(64)
										: column.endsWith('_at')
											? '2026-10-01T09:00:00.123457Z'
											: prior[column] === null
												? 'Changed'
												: prior[column].toUpperCase();
				await assert.rejects(repo.upsertWithAudit(next), RouteDataPolicyWriteConflictError);
				assert.deepEqual(await state(), before);
			}
		});
		await t.test('stale trust row, deleted policy and competing absent-policy insertion cannot write or audit', async () => {
			const stale = await input();
			await f.pg.query("UPDATE cinatoken_gateway.providers SET api_key='synthetic-rotated' WHERE id='Provider-A'");
			const before = await state();
			await assert.rejects(repo.upsertWithAudit(stale), RouteDataPolicyWriteConflictError);
			assert.deepEqual(await state(), before);
			await f.pg.query("UPDATE cinatoken_gateway.providers SET api_key='synthetic-credential' WHERE id='Provider-A'");
			const absent = await input();
			absent.precondition.priorPolicy = null;
			await assert.rejects(repo.upsertWithAudit(absent), RouteDataPolicyWriteConflictError);
			const deleted = await input();
			await f.pg.query('DELETE FROM cinatoken_gateway.route_data_policies');
			await assert.rejects(repo.upsertWithAudit(deleted), RouteDataPolicyWriteConflictError);
			await repo.upsertWithAudit(await input());
		});
		await t.test('audit constraint failure rolls back policy mutation in the same PostgreSQL transaction', async () => {
			await f.pg.exec(
				`ALTER TABLE cinatoken_gateway.route_data_policy_audit ADD CONSTRAINT fixture_audit_failure CHECK(actor_id <> 'fail')`,
			);
			const next = await input(),
				before = await state();
			next.retentionDays = 42;
			next.actorId = 'fail';
			await assert.rejects(repo.upsertWithAudit(next), /fixture_audit_failure/u);
			assert.deepEqual(await state(), before);
		});
		await t.test('existing UPDATE, no-op and ABA retain exact current-value semantics and normalized legacy reads', async () => {
			const original = await input(),
				b = await input();
			b.retentionDays = 7;
			await repo.upsertWithAudit(b);
			const a = await input();
			await repo.upsertWithAudit(a);
			await repo.upsertWithAudit(original);
			const legacy = await input();
			delete legacy.precondition;
			assert.equal((await repo.upsertWithAudit(legacy)).verified_at, instant);
			assert.ok(f.queries.some((x) => /ON CONFLICT\(route_target_id\) DO NOTHING/u.test(x.query)));
			assert.ok(f.queries.some((x) => /FOR UPDATE OF r/u.test(x.query)));
			assert.ok(f.queries.some((x) => /COLLATE "C"/u.test(x.query)));
		});
	} finally {
		await f.pg.close();
	}
});
