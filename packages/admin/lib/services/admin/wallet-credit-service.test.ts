import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayRepositories } from "@octafuse/core";
import {
	WalletCreditValidationError,
	WalletCreditConflictError,
	WalletCreditLegacyUnverifiedError,
	WalletCreditConcurrentMutationError,
	WalletCreditUserNotFoundError,
} from "@octafuse/core/db/wallet-credit";
import {
	applyAdminWalletCredit,
	readAdminWalletCredit,
	normalizeAdminWalletCreditInput,
} from "./wallet-credit-service";
import { AdminServiceError } from "./errors";

const repos = {} as GatewayRepositories;
const userId = "f2b74bc0-32f3-4613-aea7-96f723d08e12";
const input = {
	amount: 0.000001,
	kind: "topup",
	external_ref: "ORDER-1",
	reason: "QA",
	require_receipt_version: 1,
};
test("verified wallet input requires version and real exact signed numbers, not coerced JSON values", () => {
	assert.equal(normalizeAdminWalletCreditInput(input, true).amount, 0.000001);
	assert.equal(
		normalizeAdminWalletCreditInput({ ...input, amount: -0.000001 }, true)
			.amount,
		-0.000001,
	);
	for (const amount of [
		true,
		false,
		[],
		{},
		"1",
		null,
		NaN,
		Infinity,
		0,
		-0,
		0.0000001,
		9007199254.740992,
	])
		assert.throws(
			() => normalizeAdminWalletCreditInput({ ...input, amount }, true),
			(error) => error instanceof AdminServiceError && error.status === 400,
		);
	for (const value of [
		null,
		[],
		{},
		{ ...input, require_receipt_version: undefined },
		{ ...input, require_receipt_version: "1" },
		{ ...input, another: 1 },
		{ ...input, kind: "purchase" },
		{ ...input, reason: {} },
		{ ...input, reason: "line\nbreak" },
	])
		assert.throws(() => normalizeAdminWalletCreditInput(value, true));
});
test("legacy trimming remains compatible while verified references and exact reads remain literal", async () => {
	assert.equal(
		normalizeAdminWalletCreditInput({ ...input, external_ref: " ORDER " })
			.externalRef,
		"ORDER",
	);
	assert.equal(
		normalizeAdminWalletCreditInput({ ...input, external_ref: " ORDER " }, true)
			.externalRef,
		" ORDER ",
	);
	let reference = "";
	const deps = {
		grant: async () => {
			throw new Error("No credit on read");
		},
		read: async (
			_repos: GatewayRepositories,
			params: { userId: string; externalRef: string },
		) => {
			reference = params.externalRef;
			return { version: 1 as const, status: "not_found" as const };
		},
	};
	assert.deepEqual(
		await readAdminWalletCredit(repos, userId, " é + / ", deps),
		{ version: 1, status: "not_found" },
	);
	assert.equal(reference, " é + / ");
	for (const external_ref of [" ", "x".repeat(256), "x\u200by", "\uD800"])
		assert.throws(() =>
			normalizeAdminWalletCreditInput({ ...input, external_ref }, true),
		);
});
test("normalized amount/reference and authenticated audit actor are forwarded without body impersonation", async () => {
	let observed: unknown;
	const deps = {
		grant: async (_repos: GatewayRepositories, params: unknown) => {
			observed = params;
			throw new WalletCreditConcurrentMutationError();
		},
		read: async () => ({ version: 1 as const, status: "not_found" as const }),
	};
	await assert.rejects(
		applyAdminWalletCredit(repos, userId, input, "console:trusted", true, deps),
		(error) => error instanceof AdminServiceError && error.status === 409,
	);
	assert.deepEqual(observed, {
		userId,
		amount: 0.000001,
		kind: "topup",
		externalRef: "ORDER-1",
		reason: "QA",
		actorType: "admin",
		actorId: "console:trusted",
		source: "admin_wallet",
	});
	await assert.rejects(
		applyAdminWalletCredit(
			repos,
			userId,
			{ ...input, actorId: "forged" },
			"console:trusted",
			true,
			deps,
		),
	);
});
test("known transactional errors map to explicit HTTP statuses while uncertain failures stay unknown", async () => {
	for (const [failure, status] of [
		[new WalletCreditValidationError(), 400],
		[new WalletCreditUserNotFoundError(userId), 404],
		[new WalletCreditConflictError(), 409],
		[new WalletCreditLegacyUnverifiedError(), 409],
		[new WalletCreditConcurrentMutationError(), 409],
	] as const) {
		const deps = {
			grant: async () => {
				throw failure;
			},
			read: async () => {
				throw failure;
			},
		};
		await assert.rejects(
			applyAdminWalletCredit(
				repos,
				userId,
				input,
				"console:trusted",
				true,
				deps,
			),
			(error) => error instanceof AdminServiceError && error.status === status,
		);
		await assert.rejects(
			readAdminWalletCredit(repos, userId, "ORDER-1", deps),
			(error) => error instanceof AdminServiceError && error.status === status,
		);
	}
	const unknown = new Error("Connection lost after dispatch");
	await assert.rejects(
		applyAdminWalletCredit(repos, userId, input, "console:trusted", true, {
			grant: async () => {
				throw unknown;
			},
			read: async () => {
				throw unknown;
			},
		}),
		(error) => error === unknown,
	);
});
