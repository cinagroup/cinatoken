/** Explicit, test-owned local PostgreSQL only; no DATABASE_URL or existing instance. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import { startNativePostgres } from '../test-support/postgres-native-cluster.mjs';
import { pgCoreSchema } from '../storage/drizzle/schema.pg.ts';
import { grantWalletCreditWithAuditTxPg, readWalletCreditReceiptPg } from './postgres/critical-writes.impl.ts';
import { WalletCreditConflictError } from './wallet-credit.ts';

test('native PostgreSQL wallet credits serialize distinct connections and preserve exact committed receipts', async (t) => {
	const cluster = await startNativePostgres();
	const rawA = cluster.client('wallet-a'),
		rawB = cluster.client('wallet-b');
	const a = { driver: 'postgres', raw: rawA, drizzle: drizzle(rawA, { schema: pgCoreSchema }) };
	const b = { driver: 'postgres', raw: rawB, drizzle: drizzle(rawB, { schema: pgCoreSchema }) };
	const admin = cluster.admin;
	const params = { userId: 'u', externalRef: 'Native_é😀%\\', amount: 0.1, kind: 'topup' };
	const grant = (client, patch = {}) => grantWalletCreditWithAuditTxPg(client, { ...params, ...patch });
	try {
		await admin.unsafe(`CREATE SCHEMA cinatoken_gateway;
   CREATE TABLE cinatoken_gateway.users(id text PRIMARY KEY,email text NOT NULL,budget_max numeric(18,6),
    budget_base numeric(18,6) NOT NULL DEFAULT 0,budget_spent numeric(18,6) NOT NULL DEFAULT 0,
    budget_period text NOT NULL DEFAULT 'monthly',budget_reset_at timestamptz,budget_epoch bigint NOT NULL DEFAULT 0,
    budget_reserved_micros bigint NOT NULL DEFAULT 0,wallet_granted numeric(18,6) NOT NULL DEFAULT 0,
    wallet_spent numeric(18,6) NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'active',metadata text,
    rate_limit text,charged_cost_factors text,external_system text,external_user_id text,
    created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
   CREATE TABLE cinatoken_gateway.user_audit_logs(id text PRIMARY KEY,user_id text REFERENCES cinatoken_gateway.users(id),
    api_key_id text,event_type text NOT NULL,actor_type text NOT NULL,request_log_id text,change_payload text,
    before_user_snapshot text,after_user_snapshot text,changed_fields text,correlation_id text,source text,actor_id text,
    reason_code text,reason_text text,dedup_key text,created_at timestamptz NOT NULL,UNIQUE(user_id,dedup_key));
   INSERT INTO cinatoken_gateway.users(id,email) VALUES('u','u@example.invalid');`);
		const reset = () =>
			admin.unsafe(`TRUNCATE cinatoken_gateway.user_audit_logs;
   UPDATE cinatoken_gateway.users SET wallet_granted=0.3,wallet_spent=0.1,budget_spent=1,budget_epoch=5,
    budget_reserved_micros=123,metadata='{"nested":{"a":true}}',rate_limit='{ "rpm" : 7 }',
    charged_cost_factors='{"default":0.8}' WHERE id='u'`);
		const state = async () => ({
			users: await admin.unsafe('SELECT * FROM cinatoken_gateway.users ORDER BY id'),
			audit: await admin.unsafe('SELECT * FROM cinatoken_gateway.user_audit_logs ORDER BY id'),
		});
		await t.test(
			'same exact reference concurrently applies once and duplicate/read agree after later settlement',
			async () => {
				await reset();
				const results = await Promise.all([grant(a), grant(b)]);
				assert.deepEqual(results.map((r) => r.status).sort(), ['applied', 'duplicate']);
				assert.deepEqual(results[0].receipt, results[1].receipt);
				assert.equal(results[0].walletBalance, 0.3);
				await admin.unsafe("UPDATE cinatoken_gateway.users SET wallet_spent=0.4 WHERE id='u'");
				assert.deepEqual(await grant(a), {
					status: 'duplicate',
					walletGranted: 0.4,
					walletSpent: 0.4,
					walletBalance: 0,
					receipt: results[0].receipt,
				});
				await grant(b, { externalRef: 'later-credit', amount: 0.2 });
				assert.deepEqual(await grant(a), {
					status: 'duplicate',
					walletGranted: 0.6,
					walletSpent: 0.4,
					walletBalance: 0.2,
					receipt: results[0].receipt,
				});
				const read = await readWalletCreditReceiptPg(b, params);
				assert.deepEqual(read, { version: 1, status: 'recorded', receipt: results[0].receipt });
				assert.equal((await state()).audit.length, 2);
			},
		);
		await t.test(
			'different refs serialize on user row and their immutable before/after form a commit chain',
			async () => {
				await reset();
				const results = await Promise.all([grant(a), grant(b, { externalRef: 'second', amount: 0.2 })]);
				assert.ok(results.every((r) => r.status === 'applied'));
				const ordered = results.toSorted((x, y) => x.receipt.before.walletGranted - y.receipt.before.walletGranted);
				assert.deepEqual(ordered[1].receipt.before, ordered[0].receipt.after);
				assert.equal(ordered[1].receipt.after.walletGranted, 0.6);
				assert.equal((await state()).audit.length, 2);
			},
		);
		await t.test(
			'same reference with different payload concurrently commits only one and rejects the other',
			async () => {
				await reset();
				const results = await Promise.allSettled([grant(a), grant(b, { amount: 0.2, kind: 'refund' })]);
				assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
				assert.ok(results.some((r) => r.status === 'rejected' && r.reason instanceof WalletCreditConflictError));
				assert.equal((await state()).audit.length, 1);
			},
		);
		await t.test(
			'credit waiting behind a real wallet/period update observes that committed full snapshot',
			async () => {
				await reset();
				let unlock, locked;
				const release = new Promise((resolve) => {
					unlock = resolve;
				});
				const acquired = new Promise((resolve) => {
					locked = resolve;
				});
				const holder = rawA.begin(async (tx) => {
					await tx.unsafe("SELECT id FROM cinatoken_gateway.users WHERE id='u' FOR UPDATE");
					locked();
					await release;
					await tx.unsafe(
						"UPDATE cinatoken_gateway.users SET wallet_spent=0.2,budget_epoch=6,budget_spent=0,budget_reserved_micros=0 WHERE id='u'",
					);
				});
				await Promise.race([
					acquired,
					holder.then(() => {
						throw new Error('Lock holder ended before acquisition');
					}),
				]);
				const pending = grant(b);
				const done = Promise.allSettled([holder, pending]);
				let waitError;
				try {
					let waiting = false;
					for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
						const rows = await admin.unsafe(
							"SELECT wait_event_type FROM pg_stat_activity WHERE application_name='cinatoken-native-wallet-b'",
						);
						waiting = rows.some((row) => row.wait_event_type === 'Lock');
						if (!waiting) await pause(10);
					}
					assert.equal(waiting, true, 'separate production driver session must really wait for row lock');
				} catch (error) {
					waitError = error;
				} finally {
					unlock();
				}
				const [held, credited] = await done;
				if (waitError) throw waitError;
				if (held.status === 'rejected') throw held.reason;
				if (credited.status === 'rejected') throw credited.reason;
				const result = credited.value;
				assert.equal(result.receipt.before.walletSpent, 0.2);
				const audit = (await state()).audit[0];
				assert.equal(JSON.parse(audit.before_user_snapshot).budget_epoch, 6);
				assert.equal(JSON.parse(audit.before_user_snapshot).budget_reserved_micros, 0);
				assert.equal(JSON.parse(audit.after_user_snapshot).wallet_spent, 0.2);
			},
		);
		for (const [name, target, timing, body] of [
			['audit constraint error', 'user_audit_logs', 'BEFORE INSERT', "RAISE EXCEPTION 'injected audit failure';"],
			['ignored wallet update', 'users', 'BEFORE UPDATE OF wallet_granted', 'RETURN NULL;'],
			['rewritten wallet update', 'users', 'BEFORE UPDATE OF wallet_granted', 'NEW.wallet_spent:=7; RETURN NEW;'],
			[
				'AFTER trigger wallet write',
				'users',
				'AFTER UPDATE OF wallet_granted',
				'UPDATE cinatoken_gateway.users SET wallet_spent=7 WHERE id=NEW.id; RETURN NEW;',
			],
		]) {
			await t.test(`${name} rolls back both tables`, async () => {
				await reset();
				const before = await state();
				await admin.unsafe(`CREATE FUNCTION cinatoken_gateway.credit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END; $$;
     CREATE TRIGGER credit_fail ${timing} ON cinatoken_gateway.${target} FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.credit_fail();`);
				try {
					await assert.rejects(() => grant(a));
					assert.deepEqual(await state(), before);
				} finally {
					await admin.unsafe(
						`DROP TRIGGER credit_fail ON cinatoken_gateway.${target}; DROP FUNCTION cinatoken_gateway.credit_fail();`,
					);
				}
			});
		}
	} finally {
		await cluster.cleanup();
	}
});
