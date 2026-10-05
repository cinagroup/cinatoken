import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	AdminKeyMutationWithAudit,
	GatewayRepositories,
	UserRow,
} from "@octafuse/core";
import {
	deleteAdminUser,
	deleteAdminUserKey,
	patchAdminUserKey,
} from "./users-service";
import { deleteAdminKey, updateAdminKey } from "./keys-service";

const userId = "00000000-0000-4000-8000-000000000001";
const keyId = "00000000-0000-4000-8000-000000000002";
const actorId = "admin-atomicity-probe";
const user: UserRow = {
	id: userId,
	email: "atomicity@example.test",
	budget_max: 10,
	budget_base: 10,
	budget_spent: 3,
	budget_period: "none",
	budget_reset_at: null,
	budget_epoch: 0,
	budget_reserved_micros: 0,
	status: "active",
	metadata: null,
	charged_cost_factors: null,
	external_system: null,
	external_user_id: null,
	created_at: "2026-01-01T00:00:00.000Z",
	updated_at: "2026-01-01T00:00:00.000Z",
};

type Fault = "none" | "audit" | "second_field" | "cas" | "user_cas";

function fixture() {
	let currentUser = { ...user };
	let key = {
		id: keyId,
		key: "sk-secret-value",
		key_preview: "sk-…",
		user_id: userId,
		workspace_id: "w1",
		name: "before" as string | null,
		status: "active",
		metadata: "{}" as string | null,
		user_email: user.email,
		user_metadata: null,
		user_charged_cost_factors: null,
		budget_spent: 3,
		budget_max: 10,
		budget_base: 10,
		budget_period: "none",
		budget_reset_at: null,
		budget_epoch: 0,
		budget_reserved_micros: 0,
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
	};
	let fault: Fault = "none";
	let legacyCalls = 0;
	const mutations: AdminKeyMutationWithAudit[] = [];
	const repos = {
		users: {
			getById: async () => ({ ...currentUser }),
			deleteUserHard: async () => false,
		},
		apiKeys: {
			getApiKeyWithUserById: async () => ({ ...key }),
			getApiKeyById: async () => ({ ...key }),
			updateApiKeyName: async () => {
				legacyCalls++;
				return true;
			},
			updateApiKeyStatusById: async () => {
				legacyCalls++;
				return true;
			},
			setApiKeyMetadataById: async () => {
				legacyCalls++;
				return true;
			},
			revokeApiKey: async () => {
				legacyCalls++;
				return true;
			},
			applyAdminKeyMutationWithAudit: async (
				mutation: AdminKeyMutationWithAudit
			) => {
				mutations.push(mutation);
				if (fault === "user_cas") {
					currentUser = {
						...currentUser,
						budget_spent: currentUser.budget_spent + 1,
					};
					return "conflict" as const;
				}
				if (
					fault === "cas" ||
					mutation.expected.name !== key.name ||
					mutation.expected.status !== key.status ||
					mutation.expected.metadata !== key.metadata
				)
					return "conflict" as const;
				// The transaction drafts all fields and the audit before exposing either.
				const next = { ...key, ...mutation.patch };
				if (fault === "second_field")
					throw new Error("injected second-field failure");
				if (fault === "audit") throw new Error("injected audit failure");
				key = next;
				return "applied" as const;
			},
		},
		userAuditLogs: {
			insertUserAuditLog: async () => {
				legacyCalls++;
			},
		},
	} as unknown as GatewayRepositories;
	return {
		repos,
		mutations,
		key: () => ({ ...key }),
		fault: (value: Fault) => {
			fault = value;
		},
		userBudget: (value: number) => {
			currentUser = { ...currentUser, budget_spent: value };
		},
		legacyCalls: () => legacyCalls,
	};
}

test("missing atomic repositories fail closed for user DELETE and Key PATCH/DELETE", async () => {
	const state = fixture();
	delete state.repos.apiKeys.applyAdminKeyMutationWithAudit;
	await assert.rejects(
		() => deleteAdminUser(state.repos, userId, actorId),
		/Atomic user deletion audit repository is unavailable/u
	);
	await assert.rejects(
		() => deleteAdminKey(state.repos, keyId, actorId),
		/Atomic Admin Key mutation repository is unavailable/u
	);
	await assert.rejects(
		() => deleteAdminUserKey(state.repos, userId, keyId, actorId),
		/Atomic Admin Key mutation repository is unavailable/u
	);
	await assert.rejects(
		() => updateAdminKey(state.repos, keyId, { name: "after" }, actorId),
		/Atomic Admin Key mutation repository is unavailable/u
	);
	assert.equal(state.legacyCalls(), 0);
	assert.equal(state.key().status, "active");
});

test("audit failure leaves global and user-scoped Key PATCH/DELETE unchanged, without split writes", async () => {
	const state = fixture();
	state.fault("audit");
	await assert.rejects(
		() =>
			updateAdminKey(
				state.repos,
				keyId,
				{ name: "after", status: "revoked" },
				actorId
			),
		/injected audit failure/u
	);
	await assert.rejects(
		() =>
			patchAdminUserKey(state.repos, userId, keyId, { name: "after" }, actorId),
		/injected audit failure/u
	);
	await assert.rejects(
		() => deleteAdminKey(state.repos, keyId, actorId),
		/injected audit failure/u
	);
	await assert.rejects(
		() => deleteAdminUserKey(state.repos, userId, keyId, actorId),
		/injected audit failure/u
	);
	assert.equal(state.key().name, "before");
	assert.equal(state.key().status, "active");
	assert.equal(state.legacyCalls(), 0);
});

test("a second-field failure rolls back a multi-field Admin Key PATCH", async () => {
	const state = fixture();
	state.fault("second_field");
	await assert.rejects(
		() =>
			updateAdminKey(
				state.repos,
				keyId,
				{
					name: "after",
					status: "revoked",
					metadata: { team: "ops" },
				},
				actorId
			),
		/injected second-field failure/u
	);
	assert.deepEqual(
		{
			name: state.key().name,
			status: state.key().status,
			metadata: state.key().metadata,
		},
		{ name: "before", status: "active", metadata: "{}" }
	);
	assert.equal(state.legacyCalls(), 0);
});

test("CAS mismatch returns conflict without retry or a split success audit", async () => {
	const state = fixture();
	state.fault("cas");
	await assert.rejects(
		() => updateAdminKey(state.repos, keyId, { name: "after" }, actorId),
		/Key changed concurrently; retry/u
	);
	await assert.rejects(
		() => deleteAdminUserKey(state.repos, userId, keyId, actorId),
		/Key changed concurrently; retry/u
	);
	assert.equal(state.mutations.length, 2);
	assert.equal(state.key().name, "before");
	assert.equal(state.key().status, "active");
	assert.equal(state.legacyCalls(), 0);
});

test("Key audit uses the freshly read user budget and rejects a later user CAS change", async () => {
	const fresh = fixture();
	fresh.userBudget(5); // The earlier Key JOIN still carries budget_spent=3.
	await updateAdminKey(fresh.repos, keyId, { name: "after" }, actorId);
	assert.equal(fresh.mutations[0]?.expectedUserSnapshot?.budget_spent, 5);
	assert.equal(
		JSON.parse(fresh.mutations[0]?.audit?.beforeUserSnapshot ?? "{}")
			.budget_spent,
		5
	);

	const stale = fixture();
	stale.fault("user_cas");
	await assert.rejects(
		() => updateAdminKey(stale.repos, keyId, { name: "after" }, actorId),
		/Key changed concurrently; retry/u
	);
	assert.equal(stale.key().name, "before");
	assert.equal(stale.legacyCalls(), 0);
});

test("global and user-scoped Key PATCH keep audit source/reason and omit Key secret", async () => {
	const state = fixture();
	const globalResult = await updateAdminKey(
		state.repos,
		keyId,
		{ name: "after" },
		actorId
	);
	const userResult = await patchAdminUserKey(
		state.repos,
		userId,
		keyId,
		{ metadata: { team: "ops" } },
		actorId
	);
	assert.equal(globalResult.metadata_raw, "{}");
	assert.equal("metadata_raw" in userResult, false);
	assert.deepEqual(userResult.metadata, { team: "ops" });
	assert.equal(state.mutations[0]?.audit?.source, "admin_keys");
	assert.equal(state.mutations[0]?.audit?.reasonCode, "admin_patch_key_name");
	assert.equal(state.mutations[1]?.audit?.source, "admin_user_key");
	assert.equal(
		state.mutations[1]?.audit?.reasonCode,
		"admin_patch_key_metadata"
	);
	for (const mutation of state.mutations)
		assert.doesNotMatch(JSON.stringify(mutation.audit), /sk-secret-value/u);
	assert.equal(state.legacyCalls(), 0);
});

test("a no-op Key PATCH keeps the legacy timestamp write without a success audit", async () => {
	const state = fixture();
	await updateAdminKey(state.repos, keyId, { name: "before" }, actorId);
	assert.equal(state.mutations.length, 1);
	assert.equal(state.mutations[0]?.audit, null);
	assert.equal(state.mutations[0]?.expectedUserSnapshot, null);
	assert.equal(state.legacyCalls(), 0);
});

test("repeated global and user-scoped Key DELETE retain tombstone event, reason and source", async () => {
	const state = fixture();
	await deleteAdminKey(state.repos, keyId, actorId);
	await deleteAdminKey(state.repos, keyId, actorId);
	await deleteAdminUserKey(state.repos, userId, keyId, actorId);
	assert.equal(state.key().status, "revoked");
	assert.deepEqual(
		state.mutations.map((mutation) => [
			mutation.audit?.eventType,
			mutation.audit?.reasonCode,
			mutation.audit?.source,
		]),
		[
			["key_revoked", "admin_key_delete_tombstone", "admin_keys"],
			["key_revoked", "admin_key_delete_tombstone", "admin_keys"],
			["key_revoked", "admin_user_key_delete_tombstone", "admin_user_key"],
		]
	);
	assert.equal(state.legacyCalls(), 0);
});
