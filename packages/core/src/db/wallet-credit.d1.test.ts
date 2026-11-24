import assert from 'node:assert/strict';
import test from 'node:test';
import type { D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { createSqliteD1 } from '../../../proxy/src/test-support/sqlite-d1';
import { initD1Drizzle } from '../storage/drizzle/client-d1';
import { grantWalletCreditWithAuditTx, readWalletCreditReceiptFromStorage } from '../storage/critical-write-paths';
import {
	WalletCreditConcurrentMutationError,
	WalletCreditConflictError,
	WalletCreditLegacyUnverifiedError,
	WalletCreditValidationError,
} from './wallet-credit';
import type { D1DatabaseClient } from '../storage/database-client';

function fixture() {
	const f = createSqliteD1();
	f.sqlite.exec(`INSERT INTO users(id,email,budget_max,budget_base,budget_spent,wallet_granted,wallet_spent,rate_limit)
  VALUES('u','u@example.invalid',10,10,0,0.3,0.1,'{ "rpm" : 7 }'),('other','other@example.invalid',10,10,0,0,0,NULL)`);
	f.sqlite.exec(
		`UPDATE users SET metadata='{"nested":{"a":true}}',charged_cost_factors='{"default":0.8}' WHERE id='u'`,
	);
	const client: D1DatabaseClient = { driver: 'd1', raw: f.binding, drizzle: initD1Drizzle(f.binding) };
	const params = { userId: 'u', amount: 0.1, kind: 'topup' as const, externalRef: 'Order_%\\é😀' };
	const state = () => ({
		users: f.sqlite.prepare('SELECT * FROM users ORDER BY id').all(),
		audit: f.sqlite.prepare('SELECT * FROM user_audit_logs ORDER BY id').all(),
	});
	return {
		...f,
		client,
		params,
		state,
		grant: (patch = {}) => grantWalletCreditWithAuditTx(client, { ...params, ...patch }),
		read: (externalRef = params.externalRef) =>
			readWalletCreditReceiptFromStorage(client, { userId: 'u', externalRef }),
	};
}

test('D1 wallet credit commits exact wallet and full audit snapshot; duplicate/read return original receipt after later spend', async () => {
	const f = fixture();
	try {
		const first = await f.grant();
		assert.equal(first.status, 'applied');
		assert.deepEqual(first.receipt.before, { walletGranted: 0.3, walletSpent: 0.1, walletBalance: 0.2 });
		assert.deepEqual(first.receipt.after, { walletGranted: 0.4, walletSpent: 0.1, walletBalance: 0.3 });
		const audit = f.sqlite.prepare('SELECT * FROM user_audit_logs').get()!;
		const before = JSON.parse(String(audit.before_user_snapshot)),
			after = JSON.parse(String(audit.after_user_snapshot));
		assert.equal(before.wallet_granted, 0.3);
		assert.equal(after.wallet_granted, 0.4);
		assert.equal(before.rate_limit, '{"rpm":7}');
		assert.equal(before.metadata, '{"nested":{"a":true}}');
		assert.equal(after.charged_cost_factors, '{"default":0.8}');
		assert.equal(after.budget_spent, 0);
		assert.deepEqual(JSON.parse(String(audit.changed_fields)), ['wallet_granted']);
		f.sqlite.exec("UPDATE users SET wallet_granted=10,wallet_spent=4 WHERE id='u'");
		let concurrentSpend = false;
		f.hooks.beforeStatement = (sql) => {
			if (!concurrentSpend && sql.startsWith('SELECT receipt.*')) {
				concurrentSpend = true;
				f.sqlite.exec("UPDATE users SET wallet_spent=4.1 WHERE id='u'");
			}
		};
		assert.deepEqual(await f.grant({ reason: 'A changed comment does not define idempotency' }), {
			status: 'duplicate',
			walletGranted: 10,
			walletSpent: 4.1,
			walletBalance: 5.9,
			receipt: first.receipt,
		});
		assert.equal(
			concurrentSpend,
			true,
			'current fields must come from the receipt SELECT snapshot, not the preceding user read',
		);
		await f.grant({ externalRef: 'later-credit', amount: 0.2 });
		assert.deepEqual(await f.grant(), {
			status: 'duplicate',
			walletGranted: 10.2,
			walletSpent: 4.1,
			walletBalance: 6.1,
			receipt: first.receipt,
		});
		assert.deepEqual(await f.read(), { version: 1, status: 'recorded', receipt: first.receipt });
		assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM user_audit_logs').get()!.n, 2);
		assert.equal(f.sqlite.prepare("SELECT wallet_granted FROM users WHERE id='u'").get()!.wallet_granted, 10.2);
	} finally {
		f.sqlite.close();
	}
});

test('D1 same reference with different amount/kind conflicts; literal case and other user remain independent', async () => {
	const f = fixture();
	try {
		await f.grant();
		const before = f.state();
		for (const patch of [{ amount: 0.2 }, { kind: 'refund' }])
			await assert.rejects(() => f.grant(patch), WalletCreditConflictError);
		assert.deepEqual(f.state(), before);
		assert.equal((await f.grant({ externalRef: f.params.externalRef.toLowerCase() })).status, 'applied');
		assert.equal((await f.grant({ userId: 'other' })).status, 'applied');
	} finally {
		f.sqlite.close();
	}
});

test('D1 old audit is legacy_unverified and cannot be credited again; missing lookup never writes', async () => {
	const f = fixture();
	try {
		f.sqlite
			.prepare(
				`INSERT INTO user_audit_logs(id,user_id,event_type,actor_type,dedup_key,change_payload)
   VALUES('legacy','u','wallet_credit','admin',?,?)`,
			)
			.run(f.params.externalRef, JSON.stringify({ amount: 0.1, kind: 'topup', external_ref: f.params.externalRef }));
		const before = f.state();
		assert.deepEqual(await f.read(), { version: 1, status: 'legacy_unverified' });
		await assert.rejects(() => f.grant(), WalletCreditLegacyUnverifiedError);
		assert.deepEqual(await f.read('unseen'), { version: 1, status: 'not_found' });
		assert.deepEqual(f.state(), before);
	} finally {
		f.sqlite.close();
	}
});

test('D1 concurrent same-reference submissions apply once and share the same immutable receipt', async () => {
	const f = fixture();
	try {
		const results = await Promise.all([f.grant(), f.grant()]);
		assert.deepEqual(results.map((r) => r.status).sort(), ['applied', 'duplicate']);
		assert.deepEqual(results[0].receipt, results[1].receipt);
		assert.equal(f.sqlite.prepare("SELECT wallet_granted FROM users WHERE id='u'").get()!.wallet_granted, 0.4);
	} finally {
		f.sqlite.close();
	}
});

test('D1 different-reference contention never silently replays a stale audit plan', async () => {
	const f = fixture();
	try {
		const results = await Promise.allSettled([f.grant(), f.grant({ externalRef: 'second' })]);
		assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
		const rejected = results.find((r) => r.status === 'rejected');
		assert.ok(
			rejected && rejected.status === 'rejected' && rejected.reason instanceof WalletCreditConcurrentMutationError,
		);
		assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM user_audit_logs').get()!.n, 1);
	} finally {
		f.sqlite.close();
	}
});

for (const [name, mutation] of [
	['period accounting source', 'budget_spent_micros=1'],
	['wallet spend', 'wallet_spent=0.2'],
	['epoch', 'budget_epoch=1'],
	['held budget', 'budget_reserved_micros=1'],
	['profile', "email='new@example.invalid'"],
	['raw rate JSON', `rate_limit='{"rpm":7}'`],
	['factor JSON', `charged_cost_factors='{"default":0.5}'`],
	['metadata', `metadata='{}'`],
] as const) {
	test(`D1 wallet full read-set CAS detects ${name} mutation even without timestamp change`, async () => {
		const f = fixture();
		try {
			let injected = false;
			f.hooks.beforeStatement = (sql) => {
				if (!injected && /^INSERT INTO user_audit_logs/u.test(sql)) {
					injected = true;
					f.sqlite.exec(`UPDATE users SET ${mutation} WHERE id='u'`);
				}
			};
			await assert.rejects(() => f.grant(), WalletCreditConcurrentMutationError);
			assert.equal(injected, true);
			assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM user_audit_logs').get()!.n, 0);
			assert.equal(f.sqlite.prepare("SELECT wallet_granted FROM users WHERE id='u'").get()!.wallet_granted, 0.3);
		} finally {
			f.sqlite.close();
		}
	});
}

for (const [name, trigger] of [
	[
		'ignored wallet UPDATE',
		`CREATE TRIGGER fail BEFORE UPDATE OF wallet_granted ON users BEGIN SELECT RAISE(IGNORE); END`,
	],
	[
		'rewritten wallet UPDATE',
		`CREATE TRIGGER fail AFTER UPDATE OF wallet_granted ON users BEGIN UPDATE users SET wallet_spent=7 WHERE id=NEW.id; END`,
	],
	[
		'changed audit payload',
		`CREATE TRIGGER fail AFTER INSERT ON user_audit_logs BEGIN UPDATE user_audit_logs SET change_payload='{}' WHERE id=NEW.id; END`,
	],
	[
		'failed audit INSERT',
		`CREATE TRIGGER fail BEFORE INSERT ON user_audit_logs BEGIN SELECT RAISE(ABORT,'injected audit failure'); END`,
	],
] as const) {
	test(`D1 batch rolls back both balance and audit on ${name}`, async () => {
		const f = fixture();
		try {
			f.sqlite.exec(trigger);
			const before = f.state();
			await assert.rejects(() => f.grant());
			assert.deepEqual(f.state(), before);
		} finally {
			f.sqlite.close();
		}
	});
}

test('D1 committed but lost acknowledgement is recovered read-only and replay never moves funds again', async () => {
	const f = fixture();
	try {
		let lost = false;
		f.hooks.afterBatch = () => {
			if (!lost) {
				lost = true;
				throw new Error('commit acknowledgement lost');
			}
		};
		await assert.rejects(() => f.grant(), /acknowledgement lost/u);
		const recovered = await f.read();
		assert.equal(recovered.status, 'recorded');
		const duplicate = await f.grant();
		assert.equal(duplicate.status, 'duplicate');
		if (recovered.status === 'recorded') assert.deepEqual(duplicate.receipt, recovered.receipt);
		assert.equal(f.sqlite.prepare("SELECT wallet_granted FROM users WHERE id='u'").get()!.wallet_granted, 0.4);
	} finally {
		f.sqlite.close();
	}
});

test('D1 signed credits keep wallet counters nonnegative while allowing signed balance and safe zero-granted end state', async () => {
	const f = fixture();
	try {
		const result = await f.grant({ amount: -0.3, kind: 'refund' });
		assert.deepEqual(result.receipt.after, { walletGranted: 0, walletSpent: 0.1, walletBalance: -0.1 });
		const before = f.state();
		await assert.rejects(
			() => f.grant({ amount: -0.000001, externalRef: 'negative-granted' }),
			WalletCreditValidationError,
		);
		assert.deepEqual(f.state(), before);
	} finally {
		f.sqlite.close();
	}
});

for (const shape of ['missing receipt', 'missing statement', 'malformed counter', 'altered receipt'] as const) {
	test(`D1 ${shape} after COMMIT is unknown, not a zero-write conflict`, async () => {
		const f = fixture();
		try {
			const original = f.binding.batch.bind(f.binding);
			f.binding.batch = async function <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
				const results = await original<T>(statements);
				if (shape === 'missing receipt') results[3].results = [];
				if (shape === 'missing statement') results.pop();
				if (shape === 'malformed counter') results[0].meta.changes = '1' as unknown as number;
				if (shape === 'altered receipt')
					results[3].results = [{ ...(results[3].results[0] as object), changePayload: '{}' } as T];
				return results;
			};
			await assert.rejects(
				() => f.grant(),
				(error: unknown) => error instanceof Error && error.constructor === Error,
			);
			f.binding.batch = original;
			assert.equal((await f.read()).status, 'recorded', 'read-only recovery observes the real committed receipt');
			assert.equal((await f.grant()).status, 'duplicate');
			assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM user_audit_logs').get()!.n, 1);
		} finally {
			f.sqlite.close();
		}
	});
}

test('D1 legacy += binary tails are canonicalized only for snapshots; CAS still binds the full original raw row', async () => {
	const f = fixture();
	try {
		f.sqlite.exec("UPDATE users SET wallet_granted=0.1+0.2 WHERE id='u'");
		const raw = f.sqlite.prepare("SELECT wallet_granted FROM users WHERE id='u'").get()!.wallet_granted;
		assert.notEqual(raw, 0.3);
		let boundRaw = false;
		f.hooks.beforeStatement = (sql, bindings) => {
			if (/^INSERT INTO user_audit_logs/u.test(sql)) boundRaw = bindings.includes(raw as number);
		};
		const result = await f.grant();
		assert.equal(boundRaw, true);
		assert.deepEqual(result.receipt.before, { walletGranted: 0.3, walletSpent: 0.1, walletBalance: 0.2 });
		assert.deepEqual(result.receipt.after, { walletGranted: 0.4, walletSpent: 0.1, walletBalance: 0.3 });
		const read = await f.read();
		assert.equal(read.status, 'recorded');
	} finally {
		f.sqlite.close();
	}
});

test('D1 legacy tail normalization cannot erase real submicros or claim an unrepresentable high-value one-micro credit', async () => {
	const f = fixture();
	try {
		for (const raw of [0.0000001, Number.MIN_VALUE, 1_000_000_000.0000004]) {
			f.sqlite.prepare("UPDATE users SET wallet_granted=? WHERE id='u'").run(raw);
			const before = f.state();
			await assert.rejects(() => f.grant(), WalletCreditValidationError);
			assert.deepEqual(f.state(), before);
		}
		f.sqlite.exec("UPDATE users SET wallet_granted=9000000000 WHERE id='u'");
		const before = f.state();
		await assert.rejects(() => f.grant({ amount: 0.000001 }), WalletCreditValidationError);
		assert.deepEqual(f.state(), before);
	} finally {
		f.sqlite.close();
	}
});
