/** Execute production reservation/settlement SQL in PostgreSQL WASM, including rollback/replay. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	createFinancialEngine,
	chargeParams,
	now,
	expires,
	later,
} from '../test-support/postgres-financial-engine.mjs';
import { createPostgresUserBudgetReservationsRepository } from '../db/postgres/user-budget-reservations.impl.ts';
import { insertRequestUsageAndChargeTxPg } from '../db/postgres/critical-writes.impl.ts';
process.env.GATEWAY_PGLITE_MODULE ??= fileURLToPath(import.meta.resolve('@electric-sql/pglite'));

test('PostgreSQL period and permanent funds retain atomic reservation semantics', async (t) => {
	const f = await createFinancialEngine();
	try {
		const budgets = createPostgresUserBudgetReservationsRepository(f.client);
		async function reset() {
			await f.reset('pg_catalog,cinatoken_gateway,pg_temp');
			await f.pg.exec(
				"UPDATE cinatoken_gateway.users SET budget_max=1,budget_spent=0.8,wallet_granted=2 WHERE id='user'",
			);
		}
		const row = async () => {
			const r = (
				await f.pg.query(
					"SELECT budget_spent,wallet_spent,budget_reserved_micros FROM cinatoken_gateway.users WHERE id='user'",
				)
			).rows[0];
			return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
		};
		async function reserve(id, micros = 600000) {
			const r = await budgets.reserve({
				requestId: id,
				userId: 'user',
				apiKeyId: 'key',
				expectedBudgetEpoch: 0,
				reservedMicros: micros,
				nowIso: now,
				expiresAtIso: expires,
			});
			assert.equal(r.status, 'reserved');
			assert.equal(await budgets.markDispatched(id, now, expires), true);
		}
		async function settle(id, cost, snapshots = {}) {
			const params = chargeParams(id, cost);
			await insertRequestUsageAndChargeTxPg(f.client, {
				...params,
				audit: { ...params.audit, ...snapshots },
				userBudgetSettlement: { requestId: id, mode: 'actual', reason: 'test_actual' },
			});
		}
		await t.test('combined capacity blocks competing holds and actual replay debits once', async () => {
			await reset();
			await reserve('wallet-actual', 1500000);
			assert.deepEqual(
				await budgets.reserve({
					requestId: 'blocked',
					userId: 'user',
					apiKeyId: 'key',
					expectedBudgetEpoch: 0,
					reservedMicros: 800000,
					nowIso: now,
					expiresAtIso: expires,
				}),
				{ status: 'blocked', remainingMicros: 700000 },
			);
			await settle('wallet-actual', 0.5, {
				beforeUserSnapshot: JSON.stringify({ budget_epoch: 0, budget_spent: 0.8, wallet_spent: 0 }),
				afterUserSnapshot: JSON.stringify({ budget_epoch: 0, budget_spent: 1, wallet_spent: 0.3 }),
				changedFields: JSON.stringify(['budget_spent', 'wallet_spent']),
			});
			await settle('wallet-actual', 0.5);
			assert.deepEqual(await row(), { budget_spent: 1, wallet_spent: 0.3, budget_reserved_micros: 0 });
			assert.equal(
				Number(
					(
						await f.pg.query(
							"SELECT charged_wallet_cost FROM cinatoken_gateway.api_key_request_logs WHERE id='wallet-actual'",
						)
					).rows[0].charged_wallet_cost,
				),
				0.3,
			);
			const audit = (
				await f.pg.query(
					"SELECT before_user_snapshot, after_user_snapshot FROM cinatoken_gateway.user_audit_logs WHERE request_log_id='wallet-actual'",
				)
			).rows[0];
			assert.equal(JSON.parse(audit.before_user_snapshot).wallet_spent, 0);
			assert.equal(JSON.parse(audit.after_user_snapshot).wallet_spent, 0.3);
		});
		await t.test('late actual refunds wallet before period spend', async () => {
			await reset();
			await reserve('wallet-late');
			await budgets.forfeitDispatched('wallet-late', later, 'unknown');
			assert.deepEqual(await row(), { budget_spent: 1, wallet_spent: 0.4, budget_reserved_micros: 0 });
			await settle('wallet-late', 0.1, {
				beforeUserSnapshot: JSON.stringify({ budget_epoch: 0, budget_spent: 1, wallet_spent: 0.4 }),
				afterUserSnapshot: JSON.stringify({ budget_epoch: 0, budget_spent: 1, wallet_spent: 0.5 }),
				changedFields: JSON.stringify(['wallet_spent']),
			});
			assert.deepEqual(
				(
					await f.pg.query(
						"SELECT request_log_id, before_user_snapshot, after_user_snapshot, changed_fields FROM cinatoken_gateway.user_audit_logs WHERE request_log_id='wallet-late'",
					)
				).rows[0],
				{
					request_log_id: 'wallet-late',
					before_user_snapshot: null,
					after_user_snapshot: null,
					changed_fields: null,
				},
			);
			assert.deepEqual(await row(), { budget_spent: 0.9, wallet_spent: 0, budget_reserved_micros: 0 });
		});
		await t.test('permanent refund survives an epoch change', async () => {
			await reset();
			await reserve('wallet-epoch');
			await budgets.forfeitDispatched('wallet-epoch', later, 'unknown');
			await f.pg.exec("UPDATE cinatoken_gateway.users SET budget_spent=0,budget_epoch=1 WHERE id='user'");
			await settle('wallet-epoch', 0.1);
			assert.deepEqual(await row(), { budget_spent: 0, wallet_spent: 0, budget_reserved_micros: 0 });
		});
		await t.test('unreserved tool charges use the same locked pool split', async () => {
			await reset();
			await insertRequestUsageAndChargeTxPg(f.client, chargeParams('wallet-direct', 0.5));
			assert.deepEqual(await row(), { budget_spent: 1, wallet_spent: 0.3, budget_reserved_micros: 0 });
		});
	} finally {
		await f.pg.close();
	}
});
