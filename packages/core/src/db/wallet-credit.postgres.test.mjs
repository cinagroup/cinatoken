/** PostgreSQL engine execution (PGlite): real parser, DECIMALs, schema and rollback.
 * Native multi-session locking/wire acknowledgement is a separate validation. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFinancialEngine } from '../test-support/postgres-financial-engine.mjs';
import { grantWalletCreditWithAuditTxPg, readWalletCreditReceiptPg } from './postgres/critical-writes.impl.ts';
import {
	WalletCreditConflictError,
	WalletCreditLegacyUnverifiedError,
	WalletCreditValidationError,
} from './wallet-credit.ts';
process.env.GATEWAY_PGLITE_MODULE ??= fileURLToPath(import.meta.resolve('@electric-sql/pglite'));

test('PostgreSQL wallet receipt is committed with exact funds and original full snapshots', async (t) => {
	const f = await createFinancialEngine();
	const params = { userId: 'user', amount: 0.1, kind: 'topup', externalRef: 'Order_%\\é😀' };
	const grant = (patch = {}) => grantWalletCreditWithAuditTxPg(f.client, { ...params, ...patch });
	async function reset() {
		await f.reset('pg_catalog,public,pg_temp,cinatoken_gateway');
		await f.pg.exec(
			'UPDATE cinatoken_gateway.users SET wallet_granted=0.3,wallet_spent=0.1,rate_limit=\'{ "rpm" : 7 }\',metadata=\'{"nested":{"a":true}}\',charged_cost_factors=\'{"default":0.8}\' WHERE id=\'user\'',
		);
	}
	async function state() {
		return {
			users: (await f.pg.query('SELECT * FROM cinatoken_gateway.users ORDER BY id')).rows,
			audit: (await f.pg.query('SELECT * FROM cinatoken_gateway.user_audit_logs ORDER BY id')).rows,
		};
	}
	try {
		await t.test(
			'schema-qualified locked write returns exact receipt and read/duplicate survives later balance change',
			async () => {
				await reset();
				const first = await grant();
				assert.equal(first.status, 'applied');
				assert.deepEqual(first.receipt.before, { walletGranted: 0.3, walletSpent: 0.1, walletBalance: 0.2 });
				assert.deepEqual(first.receipt.after, { walletGranted: 0.4, walletSpent: 0.1, walletBalance: 0.3 });
				assert.ok(
					f.queries.filter((q) => /from "cinatoken_gateway"\."users"/u.test(q.query))[0].query.endsWith('for update'),
				);
				const audit = (await state()).audit[0];
				assert.equal(JSON.parse(audit.before_user_snapshot).wallet_granted, 0.3);
				assert.equal(JSON.parse(audit.after_user_snapshot).wallet_granted, 0.4);
				assert.equal(JSON.parse(audit.before_user_snapshot).metadata, '{"nested":{"a":true}}');
				assert.equal(JSON.parse(audit.after_user_snapshot).charged_cost_factors, '{"default":0.8}');
				assert.deepEqual(JSON.parse(audit.changed_fields), ['wallet_granted']);
				assert.equal(
					(await f.pg.query('SELECT count(*)::integer AS n FROM public.user_audit_logs')).rows[0].n,
					0,
					'no shadow table write',
				);
				await f.pg.exec("UPDATE cinatoken_gateway.users SET wallet_granted=10,wallet_spent=4 WHERE id='user'");
				assert.deepEqual(await grant(), {
					status: 'duplicate',
					walletGranted: 10,
					walletSpent: 4,
					walletBalance: 6,
					receipt: first.receipt,
				});
				await grant({ externalRef: 'later-credit', amount: 0.2 });
				assert.deepEqual(await grant(), {
					status: 'duplicate',
					walletGranted: 10.2,
					walletSpent: 4,
					walletBalance: 6.2,
					receipt: first.receipt,
				});
				assert.deepEqual(await readWalletCreditReceiptPg(f.client, params), {
					version: 1,
					status: 'recorded',
					receipt: first.receipt,
				});
				assert.equal((await state()).audit.length, 2);
			},
		);
		await t.test('exact ref different amount/kind conflicts, Unicode and case remain literal', async () => {
			await reset();
			await grant();
			const before = await state();
			for (const patch of [{ amount: 0.2 }, { kind: 'refund' }])
				await assert.rejects(() => grant(patch), WalletCreditConflictError);
			assert.deepEqual(await state(), before);
			assert.equal((await grant({ externalRef: params.externalRef.toLowerCase() })).status, 'applied');
			assert.equal((await grant({ userId: 'other' })).status, 'applied');
		});
		await t.test(
			'distinct credit snapshots follow commit order and signed amount permits negative balance',
			async () => {
				await reset();
				const first = await grant();
				const second = await grant({ externalRef: 'next', amount: -0.4, kind: 'admin_adjust' });
				assert.deepEqual(second.receipt.before, first.receipt.after);
				assert.deepEqual(second.receipt.after, { walletGranted: 0, walletSpent: 0.1, walletBalance: -0.1 });
				const before = await state();
				await assert.rejects(() => grant({ externalRef: 'too-much', amount: -0.000001 }), WalletCreditValidationError);
				assert.deepEqual(await state(), before);
			},
		);
		await t.test('legacy and missing refs return distinct evidence states; neither invents a new audit', async () => {
			await reset();
			await f.pg.query(
				`INSERT INTO cinatoken_gateway.user_audit_logs(id,user_id,event_type,actor_type,change_payload,dedup_key,created_at)
    VALUES('legacy','user','wallet_credit','admin','{}',$1,now())`,
				[params.externalRef],
			);
			const before = await state();
			assert.deepEqual(await readWalletCreditReceiptPg(f.client, params), { version: 1, status: 'legacy_unverified' });
			await assert.rejects(() => grant(), WalletCreditLegacyUnverifiedError);
			assert.deepEqual(await readWalletCreditReceiptPg(f.client, { ...params, externalRef: 'missing' }), {
				version: 1,
				status: 'not_found',
			});
			assert.deepEqual(await state(), before);
		});
		for (const [name, target, timing, body] of [
			['failed audit INSERT', 'user_audit_logs', 'BEFORE INSERT', "RAISE EXCEPTION 'injected audit failure';"],
			['ignored wallet UPDATE', 'users', 'BEFORE UPDATE OF wallet_granted', 'RETURN NULL;'],
			['rewritten wallet UPDATE', 'users', 'BEFORE UPDATE OF wallet_granted', 'NEW.wallet_spent := 7; RETURN NEW;'],
			['changed audit payload', 'user_audit_logs', 'BEFORE INSERT', "NEW.change_payload := '{}'; RETURN NEW;"],
			[
				'AFTER trigger wallet write',
				'users',
				'AFTER UPDATE OF wallet_granted',
				'UPDATE cinatoken_gateway.users SET wallet_spent=7 WHERE id=NEW.id; RETURN NEW;',
			],
		]) {
			await t.test(`transaction rolls back wallet and audit on ${name}`, async () => {
				await reset();
				const before = await state();
				await f.pg
					.exec(`CREATE FUNCTION cinatoken_gateway.wallet_credit_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END; $$;
     CREATE TRIGGER wallet_credit_test_failure ${timing} ON cinatoken_gateway.${target}
     FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.wallet_credit_test_failure();`);
				try {
					await assert.rejects(() => grant());
					assert.deepEqual(await state(), before);
				} finally {
					await f.pg.exec(
						`DROP TRIGGER wallet_credit_test_failure ON cinatoken_gateway.${target}; DROP FUNCTION cinatoken_gateway.wallet_credit_test_failure();`,
					);
				}
			});
		}
		await t.test('commit acknowledgement loss is read-only recoverable without a second wallet update', async () => {
			await reset();
			const original = f.client.raw.begin;
			f.client.raw.begin = async (callback) => {
				await original(callback);
				throw new Error('commit acknowledgement lost');
			};
			try {
				await assert.rejects(() => grant(), /acknowledgement lost/u);
			} finally {
				f.client.raw.begin = original;
			}
			const recovered = await readWalletCreditReceiptPg(f.client, params);
			assert.equal(recovered.status, 'recorded');
			const duplicate = await grant();
			assert.equal(duplicate.status, 'duplicate');
			assert.deepEqual(duplicate.receipt, recovered.receipt);
			assert.equal((await state()).audit.length, 1);
		});
	} finally {
		await f.pg.close();
	}
});
