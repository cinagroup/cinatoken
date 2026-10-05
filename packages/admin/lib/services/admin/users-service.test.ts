import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiKeyRow, GatewayRepositories, UserRow } from "@octafuse/core";
import { UserPlanPatchConflictError } from "@octafuse/core/services/user-plan-patch-service";
import { AdminServiceError } from "./errors";
import {
	applyAdminBudgetTransition,
	deleteAdminUser,
	listAdminUserKeys,
	previewAdminBudgetTransition,
	updateAdminUser,
} from "./users-service";

const USER_ID = "00000000-0000-4000-8000-000000000001";

test("ordinary user key lists transport only a field-count summary and a constant secret mask", async () => {
	for (const [metadata, unavailable, preview] of [
		[
			'{"credential":"do-not-transport","nested":{"private":true}}',
			false,
			'{"field_count":2}',
		],
		[null, false, null],
		["not-json-secret", true, null],
		['{"constructor":"private"}', true, null],
		[JSON.stringify({ value: "x".repeat(70_000) }), true, null],
	] as const) {
		const row = {
			id: "key-1",
			key: "sk-full-legacy-secret",
			user_id: USER_ID,
			workspace_id: "personal:user-1",
			name: "Key",
			status: "active",
			metadata,
			last_used_at: null,
			expires_at: null,
			limit_micros: null,
			limit_reset: null,
			include_byok_in_limit: false,
			limit_epoch: 0,
			created_at: "2026-09-30T00:00:00.000Z",
			updated_at: "2026-09-30T00:00:00.000Z",
			storedPreview: "sk-full-legacy-secret",
			futureSecretField: "do-not-spread",
		} as ApiKeyRow;
		const repositories = {
			users: { getById: async () => user() },
			apiKeys: {
				listKeysByUserId: async (id: string) => {
					assert.equal(id, USER_ID);
					return [row];
				},
			},
		} as unknown as GatewayRepositories;
		const listed = await listAdminUserKeys(repositories, USER_ID);
		assert.deepEqual(listed, [
			{
				id: row.id,
				key: "sk-…",
				user_id: USER_ID,
				workspace_id: row.workspace_id,
				name: row.name,
				status: row.status,
				metadata_preview: preview,
				metadata_unavailable: unavailable,
				last_used_at: null,
				created_at: row.created_at,
				updated_at: row.updated_at,
			},
		]);
		const encoded = JSON.stringify(listed);
		assert.ok(!encoded.includes("sk-full-legacy-secret"));
		assert.ok(!encoded.includes("do-not-transport"));
		assert.ok(!encoded.includes("do-not-spread"));
		assert.equal("metadata_raw" in listed[0]!, false);
		assert.equal("metadata" in listed[0]!, false);
	}
});

function user(overrides: Partial<UserRow> = {}): UserRow {
	return {
		id: USER_ID,
		email: "user@example.com",
		budget_max: 10,
		budget_base: 10,
		budget_spent: 3,
		budget_period: "monthly",
		budget_reset_at: "2030-01-01T00:00:00.000Z",
		budget_epoch: 4,
		budget_reserved_micros: 500_000,
		status: "active",
		metadata: JSON.stringify({ existing: true }),
		charged_cost_factors: null,
		external_system: null,
		external_user_id: null,
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function mockRepositories(initial: UserRow) {
	let current = { ...initial };
	let directPlanWrites = 0;
	const profileAudits: Array<Record<string, unknown>> = [];
	const repos = {
		users: {
			getById: async (id: string) =>
				id === current.id ? { ...current } : null,
			updateUserPlan: async () => {
				directPlanWrites += 1;
				throw new Error("legacy non-atomic plan writer must not be called");
			},
			updateUserStatus: async (_id: string, status: string) => {
				current = { ...current, status };
				return true;
			},
			setUserEmailById: async (_id: string, email: string) => {
				current = { ...current, email };
				return true;
			},
			setUserExternalIdentityById: async (
				_id: string,
				system: string | null,
				externalId: string | null
			) => {
				current = {
					...current,
					external_system: system,
					external_user_id: externalId,
				};
				return true;
			},
			setUserChargedCostFactorsById: async (
				_id: string,
				value: string | null
			) => {
				current = { ...current, charged_cost_factors: value };
				return true;
			},
			setUserMetadataById: async (_id: string, value: string | null) => {
				current = { ...current, metadata: value };
				return true;
			},
		},
		userAuditLogs: {
			insertUserAuditLog: async (audit: Record<string, unknown>) => {
				profileAudits.push(audit);
			},
		},
	} as unknown as GatewayRepositories;
	return {
		repos,
		read: () => ({ ...current }),
		write: (next: UserRow) => {
			current = { ...next };
		},
		profileAudits,
		directPlanWrites: () => directPlanWrites,
	};
}

test("budget transition rejects inconsistent or imminent reset targets before storage access", async () => {
	const unavailable = {} as GatewayRepositories;
	const base = { target_budget_base: 10, budget_period: "monthly" as const };
	for (const input of [
		{ ...base, budget_reset_at: "2000-01-01T00:00:00Z" },
		{ ...base, budget_reset_at: new Date(Date.now() + 30_000).toISOString() },
		{ ...base, budget_reset_at: "2030-01-01T00:00:00+00:00" },
		{
			...base,
			budget_period: "none" as const,
			budget_reset_at: "2030-01-01T00:00:00Z",
		},
	]) {
		await assert.rejects(
			() => previewAdminBudgetTransition(unavailable, USER_ID, input),
			(error: unknown) =>
				error instanceof AdminServiceError && error.status === 400
		);
		await assert.rejects(
			() => applyAdminBudgetTransition(unavailable, USER_ID, input, "admin-1"),
			(error: unknown) =>
				error instanceof AdminServiceError && error.status === 400
		);
	}
});

test("admin budget transition maps a stale preview to HTTP 409 without writing", async () => {
	const state = mockRepositories(user());
	await assert.rejects(
		() =>
			applyAdminBudgetTransition(
				state.repos,
				USER_ID,
				{
					target_budget_base: 12,
					budget_period: "monthly",
					expected_before: {
						budget_max: 11,
						budget_base: 10,
						budget_spent: 3,
						budget_period: "monthly",
						budget_reset_at: "2030-01-01T00:00:00.000Z",
						budget_epoch: 4,
						budget_reserved_micros: 500_000,
					},
				},
				"admin-1"
			),
		(error: unknown) =>
			error instanceof AdminServiceError && error.status === 409
	);
	assert.equal(state.directPlanWrites(), 0);
	assert.equal(state.profileAudits.length, 0);
});

test("admin budget reset uses the atomic plan service and profile audit excludes budget fields", async () => {
	const state = mockRepositories(user());
	let atomicCalls = 0;
	const result = await updateAdminUser(
		state.repos,
		USER_ID,
		{
			budget_max: 20,
			reset_budget: true,
			status: "disabled",
			reason: "support correction",
		},
		"admin-1",
		{
			applyPlanPatch: async (_repos, _userId, input) => {
				atomicCalls += 1;
				const before = state.read();
				const after: UserRow = {
					...before,
					budget_max:
						input.budget_max === undefined
							? before.budget_max
							: input.budget_max,
					budget_spent: 0,
					budget_epoch: before.budget_epoch + 1,
					budget_reserved_micros: 0,
				};
				state.write(after);
				return { before, after, audited: true };
			},
		}
	);

	assert.equal(atomicCalls, 1);
	assert.equal(state.directPlanWrites(), 0);
	assert.equal(result?.budget_epoch, 5);
	assert.equal(result?.budget_reserved_micros, 0);
	assert.equal(state.profileAudits.length, 1);
	assert.equal(state.profileAudits[0]?.reasonCode, "admin_patch_status");
	assert.deepEqual(JSON.parse(String(state.profileAudits[0]?.changedFields)), [
		"status",
	]);
});

test("metadata changed with a budget PATCH is owned by the atomic audit without a duplicate profile audit", async () => {
	const state = mockRepositories(user());
	let metadataMutation: unknown;
	await updateAdminUser(
		state.repos,
		USER_ID,
		{ budget_max: 20, metadata: { added: true } },
		"admin-1",
		{
			applyPlanPatch: async (_repos, _userId, input) => {
				metadataMutation = input.metadata;
				const before = state.read();
				const after: UserRow = {
					...before,
					budget_max:
						input.budget_max === undefined
							? before.budget_max
							: input.budget_max,
					metadata: JSON.stringify({ existing: true, added: true }),
				};
				state.write(after);
				return { before, after, audited: true };
			},
		}
	);
	assert.deepEqual(metadataMutation, { kind: "merge", value: { added: true } });
	assert.equal(state.profileAudits.length, 0);
	assert.equal(state.directPlanWrites(), 0);
});

test("empty metadata replacement is preserved as an atomic null replacement", async () => {
	const state = mockRepositories(user());
	let metadataMutation: unknown;
	await updateAdminUser(
		state.repos,
		USER_ID,
		{ budget_max: 20, metadata_replace: "" },
		"admin-1",
		{
			applyPlanPatch: async (_repos, _userId, input) => {
				metadataMutation = input.metadata;
				const before = state.read();
				const after = { ...before, budget_max: 20, metadata: null };
				state.write(after);
				return { before, after, audited: true };
			},
		}
	);
	assert.deepEqual(metadataMutation, { kind: "replace", value: null });
	assert.equal(state.profileAudits.length, 0);
});

test("invalid budget input is rejected before an independently stored status change", async () => {
	const state = mockRepositories(user());
	await assert.rejects(
		() =>
			updateAdminUser(
				state.repos,
				USER_ID,
				{ budget_max: -1, status: "disabled" },
				"admin-1"
			),
		(error: unknown) =>
			error instanceof AdminServiceError && error.status === 400
	);
	assert.equal(state.read().status, "active");
	assert.equal(state.directPlanWrites(), 0);
});

test("persistent plan CAS conflict maps to an explicit HTTP 409", async () => {
	const state = mockRepositories(user());
	await assert.rejects(
		() =>
			updateAdminUser(
				state.repos,
				USER_ID,
				{ budget_max: 20, status: "disabled" },
				"admin-1",
				{
					applyPlanPatch: async () => {
						throw new UserPlanPatchConflictError();
					},
				}
			),
		(error: unknown) =>
			error instanceof AdminServiceError &&
			error.status === 409 &&
			error.message.includes("concurrently")
	);
	assert.equal(state.directPlanWrites(), 0);
	assert.equal(state.read().status, "active");
});

test("a blocked PostgreSQL user deletion maps to 409 without a separate success audit", async () => {
	const state = mockRepositories(user());
	state.repos.users.deleteUserHard = async () => {
		throw new Error("legacy delete path used");
	};
	state.repos.users.deleteUserHardWithAudit = async (id, audit) => {
		assert.equal(id, USER_ID);
		assert.equal(audit.userId, USER_ID);
		assert.equal(audit.eventType, "user_deleted");
		return "dispatch_history";
	};
	await assert.rejects(
		() => deleteAdminUser(state.repos, USER_ID, "admin-1"),
		(error: unknown) =>
			error instanceof AdminServiceError && error.status === 409
	);
	assert.equal(state.profileAudits.length, 0);
});

test("a successful PostgreSQL user deletion delegates the audit atomically", async () => {
	const state = mockRepositories(user());
	let deleted = false;
	state.repos.users.deleteUserHard = async () => {
		throw new Error("legacy delete path used");
	};
	state.repos.users.deleteUserHardWithAudit = async (id, audit) => {
		assert.equal(id, USER_ID);
		assert.equal(audit.userId, USER_ID);
		assert.equal(audit.eventType, "user_deleted");
		deleted = true;
		return "deleted";
	};
	await deleteAdminUser(state.repos, USER_ID, "admin-1");
	assert.equal(deleted, true);
	assert.equal(state.profileAudits.length, 0);
});

test("an atomic user deletion rejected by a guard writes no separate success audit", async () => {
	const state = mockRepositories(user());
	state.repos.users.deleteUserHard = async () => {
		throw new Error("legacy delete path used");
	};
	state.repos.users.deleteUserHardWithAudit = async () => "not_deleted";
	await assert.rejects(
		() => deleteAdminUser(state.repos, USER_ID, "admin-1"),
		(error: unknown) =>
			error instanceof AdminServiceError && error.status === 404
	);
	assert.equal(state.profileAudits.length, 0);
});

test("unrelated PostgreSQL user deletion failures pass through unchanged", async () => {
	const state = mockRepositories(user());
	const failure = new Error("unexpected audit write failure");
	state.repos.users.deleteUserHardWithAudit = async () => {
		throw failure;
	};
	await assert.rejects(
		() => deleteAdminUser(state.repos, USER_ID, "admin-1"),
		(error) => error === failure
	);
	assert.equal(state.profileAudits.length, 0);
});

test("credited earning parent guards prevent seller deletion without a separate success audit", async () => {
	for (const failure of [
		new Error("D1_ERROR: credited_shared_key_earning_history_immutable"),
		{
			code: "23503",
			constraint_name: "shared_key_earnings_seller_user_id_fkey",
		},
		{
			code: "ER_ROW_IS_REFERENCED_2",
			errno: 1451,
			sqlMessage: "CONSTRAINT `fk_shared_key_earnings_user` FOREIGN KEY",
		},
	]) {
		const state = mockRepositories(user());
		state.repos.users.deleteUserHardWithAudit = async () => {
			throw failure;
		};
		await assert.rejects(
			() => deleteAdminUser(state.repos, USER_ID, "admin-1"),
			(error: unknown) =>
				error instanceof AdminServiceError &&
				error.status === 409 &&
				error.message.includes("credited shared-key earnings")
		);
		assert.equal(state.profileAudits.length, 0);
		assert.equal(state.read().id, USER_ID);
	}
});
