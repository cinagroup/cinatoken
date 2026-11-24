import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UserRow } from '../types';
import {
	buildWalletCreditAuditRow,
	walletCreditResult,
	readWalletCreditAuditReceipt,
	parseWalletCreditReceipt,
	requireMatchingWalletCreditReceipt,
	walletCreditMicros,
	walletCreditStoredAmount,
	assertWalletCreditReference,
	WalletCreditConflictError,
	WalletCreditLegacyUnverifiedError,
	WalletCreditValidationError,
} from './wallet-credit';

const user: UserRow = {
	budget_epoch: 0,
	budget_reserved_micros: 0,

	id: 'user-1',
	email: 'wallet@example.com',
	budget_max: 40,
	budget_base: 40,
	budget_spent: 10,
	budget_period: 'monthly',
	budget_reset_at: null,
	wallet_granted: 2,
	wallet_spent: 0.5,
	status: 'active',
	metadata: null,
	rate_limit: null,
	charged_cost_factors: null,
	external_system: 'soloent',
	external_user_id: 'ext-1',
	created_at: '2026-01-01T00:00:00Z',
	updated_at: '2026-01-01T00:00:00Z',
};

test('buildWalletCreditAuditRow writes wallet_credit with dedup_key', () => {
	const { audit, afterGranted } = buildWalletCreditAuditRow(
		user,
		{
			userId: user.id,
			amount: 10,
			kind: 'topup',
			externalRef: 'stripe_session_abc',
			reason: 'stripe:topup',
		},
		'audit-1',
	);
	assert.equal(afterGranted, 12);
	assert.equal(audit.eventType, 'wallet_credit');
	assert.equal(audit.source, 'admin_wallet');
	assert.equal(audit.dedupKey, 'stripe_session_abc');
	assert.equal(audit.reasonCode, 'wallet_credit_topup');
	const payload = JSON.parse(String(audit.changePayload ?? '{}')) as {
		amount: number;
		kind: string;
		external_ref: string;
	};
	assert.equal(payload.amount, 10);
	assert.equal(payload.kind, 'topup');
	assert.equal(payload.external_ref, 'stripe_session_abc');
	const after = JSON.parse(String(audit.afterUserSnapshot ?? '{}')) as { wallet_granted: number };
	assert.equal(after.wallet_granted, 12);
});

test('same external_ref produces the same dedup_key for replay', () => {
	const first = buildWalletCreditAuditRow(
		user,
		{ userId: user.id, amount: 10, kind: 'topup', externalRef: 'order-1' },
		'audit-a',
	);
	const second = buildWalletCreditAuditRow(
		user,
		{ userId: user.id, amount: 10, kind: 'topup', externalRef: 'order-1' },
		'audit-b',
	);
	assert.equal(first.audit.dedupKey, second.audit.dedupKey);
	assert.equal(first.audit.dedupKey, 'order-1');
	assert.notEqual(first.audit.id, second.audit.id);
});

test('walletCreditResult marks applied vs duplicate', () => {
	assert.deepEqual(walletCreditResult('applied', 12, 0.5), {
		status: 'applied',
		walletGranted: 12,
		walletSpent: 0.5,
		walletBalance: 11.5,
	});
	assert.equal(walletCreditResult('duplicate', 12, 0.5).status, 'duplicate');
});

const creditedAt = '2026-10-18T10:00:00.123Z';
const params = { userId: user.id, amount: 0.1, kind: 'topup' as const, externalRef: 'order-1' };
function evidence() {
	const built = buildWalletCreditAuditRow(user, params, 'audit-verified', creditedAt);
	return {
		built,
		stored: {
			id: built.audit.id,
			userId: user.id,
			eventType: 'wallet_credit',
			dedupKey: params.externalRef,
			changePayload: built.audit.changePayload ?? null,
			beforeUserSnapshot: built.audit.beforeUserSnapshot ?? null,
			afterUserSnapshot: built.audit.afterUserSnapshot ?? null,
			createdAt: creditedAt,
		},
	};
}

test('v1 receipt proves exact signed micros and both committed snapshots, with rounded balance', () => {
	const { built, stored } = evidence();
	assert.deepEqual(built.receipt, {
		version: 1,
		userId: user.id,
		externalRef: 'order-1',
		amountMicros: 100000,
		kind: 'topup',
		auditId: 'audit-verified',
		creditedAt,
		before: { walletGranted: 2, walletSpent: 0.5, walletBalance: 1.5 },
		after: { walletGranted: 2.1, walletSpent: 0.5, walletBalance: 1.6 },
	});
	assert.deepEqual(readWalletCreditAuditReceipt(stored, params), {
		version: 1,
		status: 'recorded',
		receipt: built.receipt,
	});
	const minus = buildWalletCreditAuditRow(
		{ ...user, wallet_granted: 0.3, wallet_spent: 0.1 },
		{ ...params, amount: -0.1 },
		'minus',
		creditedAt,
	);
	assert.deepEqual(minus.receipt.after, { walletGranted: 0.2, walletSpent: 0.1, walletBalance: 0.1 });
	assert.equal(minus.receipt.amountMicros, -100000);
	assert.equal(JSON.parse(minus.audit.beforeUserSnapshot!).budget_epoch, user.budget_epoch);
	assert.equal(JSON.parse(minus.audit.afterUserSnapshot!).budget_reserved_micros, user.budget_reserved_micros);
});

test('receipt parsing rejects zero/unsafe/different-granted or spent transitions and malformed time', () => {
	const { built } = evidence();
	for (const changed of [
		{ ...built.receipt, version: 2 },
		{ ...built.receipt, amountMicros: 0 },
		{ ...built.receipt, amountMicros: Number.MAX_SAFE_INTEGER + 1 },
		{ ...built.receipt, creditedAt: '2026-10-18' },
		{ ...built.receipt, after: { ...built.receipt.after, walletGranted: 3.1 } },
		{ ...built.receipt, after: { ...built.receipt.after, walletSpent: 0.6 } },
		{ ...built.receipt, after: { ...built.receipt.after, walletBalance: 1.6000000000000003 } },
		{ ...built.receipt, externalRef: '\ud800' },
	])
		assert.equal(parseWalletCreditReceipt(changed), null);
});

test('audit binding rejects tampered payload, user, snapshot, event and timestamp without inventing legacy evidence', () => {
	const { built, stored } = evidence();
	for (const patch of [
		{
			changePayload: JSON.stringify({
				amount: 10,
				kind: params.kind,
				external_ref: params.externalRef,
				receipt: built.receipt,
			}),
		},
		{ changePayload: '{}' },
		{ changePayload: '{' },
		{ afterUserSnapshot: JSON.stringify({ ...JSON.parse(stored.afterUserSnapshot!), budget_spent: 0 }) },
		{ beforeUserSnapshot: null },
		{ eventType: 'admin_adjust' },
		{ id: 'different-audit' },
		{ createdAt: '2026-10-18T10:01:00.123Z' },
	])
		assert.deepEqual(readWalletCreditAuditReceipt({ ...stored, ...patch }, params), {
			version: 1,
			status: 'legacy_unverified',
		});
	assert.throws(() => readWalletCreditAuditReceipt({ ...stored, userId: 'other' }, params), WalletCreditConflictError);
	assert.throws(
		() => readWalletCreditAuditReceipt({ ...stored, dedupKey: 'ORDER-1' }, params),
		WalletCreditConflictError,
	);
});

test('exact duplicate matches amount/kind, not reason or a later live wallet', () => {
	const { stored, built } = evidence();
	const read = readWalletCreditAuditReceipt(stored, params);
	assert.deepEqual(requireMatchingWalletCreditReceipt(read, params), built.receipt);
	assert.throws(() => requireMatchingWalletCreditReceipt(read, { ...params, amount: 0.2 }), WalletCreditConflictError);
	assert.throws(
		() => requireMatchingWalletCreditReceipt(read, { ...params, kind: 'refund' }),
		WalletCreditConflictError,
	);
	assert.throws(
		() => requireMatchingWalletCreditReceipt({ version: 1, status: 'legacy_unverified' }, params),
		WalletCreditLegacyUnverifiedError,
	);
	assert.deepEqual(readWalletCreditAuditReceipt(undefined, params), { version: 1, status: 'not_found' });
});

test('amount validation forbids coercion, silently rounded submicros and unsafe/negative next counters', () => {
	for (const amount of [
		0,
		-0,
		NaN,
		Infinity,
		'1',
		true,
		null,
		[],
		1e-7,
		Number.MIN_VALUE,
		0.3 - 0.1,
		9007199254.740992,
	]) {
		assert.throws(
			() => buildWalletCreditAuditRow(user, { ...params, amount: amount as number }, 'a', creditedAt),
			WalletCreditValidationError,
		);
	}
	assert.throws(
		() => buildWalletCreditAuditRow(user, { ...params, amount: -2.000001 }, 'a', creditedAt),
		WalletCreditValidationError,
	);
	assert.throws(
		() =>
			buildWalletCreditAuditRow(
				{ ...user, wallet_granted: 9_000_000_000 },
				{ ...params, amount: -0.000001 },
				'a',
				creditedAt,
			),
		WalletCreditValidationError,
	);
	assert.equal(walletCreditMicros(1.000001), 1000001);
	assert.equal(walletCreditStoredAmount('1.000001'), 1.000001);
	for (const value of ['9007199254.740992', '1.0000001', '', 'NaN', null])
		assert.throws(() => walletCreditStoredAmount(value), WalletCreditValidationError);
});

test('literal references preserve case/Unicode/spaces and reject invalid Unicode, controls and >255 codepoints', () => {
	for (const externalRef of ['Order_%\\é😀', ' Order-1 ', '😀'.repeat(255)]) {
		assertWalletCreditReference(externalRef);
		assert.equal(
			buildWalletCreditAuditRow(user, { ...params, externalRef }, 'a', creditedAt).receipt.externalRef,
			externalRef,
		);
	}
	for (const externalRef of ['', '  ', 'x\n', 'x\u200d', '\ud800', '\udc00', 'a'.repeat(256), '😀'.repeat(256)])
		assert.throws(() => assertWalletCreditReference(externalRef), WalletCreditValidationError);
});

test('receipt binds exact PostgreSQL/MySQL timestamp precision and unchanged structured snapshot fields', () => {
	const { built, stored } = evidence();
	for (const createdAt of ['2026-10-18 10:00:00.123000', '2026-10-18 10:00:00.123+00', '2026-10-18 12:00:00.123+02'])
		assert.equal(readWalletCreditAuditReceipt({ ...stored, createdAt }, params).status, 'recorded');
	assert.equal(
		readWalletCreditAuditReceipt({ ...stored, createdAt: '2026-10-18 10:00:00.123001+00' }, params).status,
		'legacy_unverified',
	);
	const unixMicros = BigInt(Date.parse(creditedAt)) * 1000n;
	assert.equal(
		readWalletCreditAuditReceipt(
			{ ...stored, createdAt: '2026-10-18 12:00:00.123000', createdAtUnixMicros: `${unixMicros}.000000` },
			params,
		).status,
		'recorded',
	);
	assert.equal(
		readWalletCreditAuditReceipt({ ...stored, createdAtUnixMicros: String(unixMicros + 1n) }, params).status,
		'legacy_unverified',
	);
	const before = JSON.parse(stored.beforeUserSnapshot!),
		after = JSON.parse(stored.afterUserSnapshot!);
	before.metadata = { nested: { first: 1, second: [true, null] } };
	after.metadata = { nested: { second: [true, null], first: 1 } };
	const structured = {
		...stored,
		beforeUserSnapshot: JSON.stringify(before),
		afterUserSnapshot: JSON.stringify(after),
	};
	assert.deepEqual(readWalletCreditAuditReceipt(structured, params), {
		version: 1,
		status: 'recorded',
		receipt: built.receipt,
	});
	after.metadata.nested.second[0] = false;
	assert.equal(
		readWalletCreditAuditReceipt({ ...structured, afterUserSnapshot: JSON.stringify(after) }, params).status,
		'legacy_unverified',
	);
});
