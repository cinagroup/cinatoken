import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { GatewayRepositories } from "@octafuse/core";
import type { AdminEnv } from "@/lib/admin-env";
import type { UserEnv } from "@/lib/user-env";
import { adminSharedKeysRoutes } from "./admin/shared-keys";
import { userSharedKeysRoutes } from "./user/shared-keys";
import { isSharedKeyEarningHistoryDeleteError } from "./shared-key-history-error";

const sqliteGuard = Object.assign(
	new Error("D1_ERROR: credited_shared_key_earning_history_immutable"),
	{
		code: "D1_ERROR",
	}
);
const postgresGuard = Object.assign(
	new Error("Credited shared-key earning history is immutable"),
	{
		code: "23514",
		constraint_name: "shared_key_earnings_history_immutable",
	}
);
const parentGuards = [
	...["request_log_id", "shared_key_id", "seller_user_id"].map((field) => ({
		code: "23503",
		constraint_name: `shared_key_earnings_${field}_fkey`,
	})),
	...["log", "key", "user"].map((field) => ({
		code: "ER_ROW_IS_REFERENCED_2",
		errno: 1451,
		sqlMessage: `Cannot delete parent: CONSTRAINT \`fk_shared_key_earnings_${field}\` FOREIGN KEY`,
	})),
	{
		code: "ER_SIGNAL_EXCEPTION",
		errno: 1644,
		sqlMessage: "credited_shared_key_earning_history_immutable",
	},
];

test("only the specific credited history guard maps to a deletion conflict", () => {
	assert.equal(isSharedKeyEarningHistoryDeleteError(sqliteGuard), true);
	assert.equal(
		isSharedKeyEarningHistoryDeleteError({ cause: postgresGuard }),
		true
	);
	assert.equal(
		isSharedKeyEarningHistoryDeleteError({
			code: "23514",
			constraint_name: "other_check",
		}),
		false
	);
	assert.equal(
		isSharedKeyEarningHistoryDeleteError(new Error("unrelated SQL failure")),
		false
	);
	for (const guard of parentGuards)
		assert.equal(isSharedKeyEarningHistoryDeleteError({ cause: guard }), true);
	assert.equal(
		isSharedKeyEarningHistoryDeleteError({
			code: "23503",
			constraint_name: "shared_key_earnings_other_fkey",
		}),
		false
	);
	assert.equal(
		isSharedKeyEarningHistoryDeleteError({
			code: "ER_ROW_IS_REFERENCED_2",
			errno: 1451,
			message: "CONSTRAINT `other_history_key`",
		}),
		false
	);
	assert.equal(
		isSharedKeyEarningHistoryDeleteError({
			code: "ER_ROW_IS_REFERENCED_2",
			errno: 1451,
			message: "CONSTRAINT `fk_shared_key_earnings_key_backup`",
		}),
		false
	);
	assert.equal(
		isSharedKeyEarningHistoryDeleteError({
			code: "unexpected",
			message: "CONSTRAINT `fk_shared_key_earnings_key`",
		}),
		false
	);
	const cyclic: { cause?: unknown } = {};
	cyclic.cause = cyclic;
	assert.equal(isSharedKeyEarningHistoryDeleteError(cyclic), false);
});

function repositoriesFor(error: unknown): GatewayRepositories {
	return {
		sharedKeys: {
			async getSharedKeyById() {
				return { id: "used-key", sellerUserId: "seller" };
			},
			async getAdminSharedKeyById() {
				return { id: "used-key", sellerUserId: "seller" };
			},
			async deleteSharedKeyAdminWithAudit() {
				throw error;
			},
			async deleteSharedKey() {
				throw error;
			},
		},
	} as unknown as GatewayRepositories;
}

test("admin and seller deletion APIs expose the same safe 409 for credited history", async () => {
	for (const error of [sqliteGuard, postgresGuard, ...parentGuards]) {
		const repositories = repositoriesFor(error);
		const admin = new Hono<AdminEnv>();
		admin.use("*", async (c, next) => {
			c.set("repositories", repositories);
			c.set("principal", {
				type: "console",
				id: "console:test",
				username: "test",
			});
			await next();
		});
		admin.route("/admin/shared-keys", adminSharedKeysRoutes);

		const seller = new Hono<UserEnv>();
		seller.use("*", async (c, next) => {
			c.set("repositories", repositories);
			c.set("principal", {
				userId: "seller",
				subject: "subject-seller",
				email: "seller@example.invalid",
				isAdmin: false,
				capabilities: ["shared_keys.manage"],
			});
			await next();
		});
		seller.route("/user/shared-keys", userSharedKeysRoutes);

		for (const app of [admin, seller]) {
			const prefix = app === admin ? "/admin" : "/user";
			const response = await app.request(`${prefix}/shared-keys/used-key`, {
				method: "DELETE",
			});
			assert.equal(response.status, 409);
			assert.deepEqual(await response.json(), {
				success: false,
				code: "shared_key_earning_history_immutable",
				message: "Shared key has credited earnings and cannot be deleted",
			});
		}
	}
});
