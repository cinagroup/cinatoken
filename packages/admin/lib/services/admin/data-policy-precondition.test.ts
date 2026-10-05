import assert from "node:assert/strict";
import test from "node:test";
import type {
	GatewayRepositories,
	RouteDataPolicyRow,
	UpsertRouteDataPolicyParams,
} from "@octafuse/core";
import {
	computeRouteDataPolicySubjectFingerprintFromRows,
	RouteDataPolicyWriteConflictError,
} from "@octafuse/core";
import { createAdminApp } from "@/lib/admin-app";
import type { AdminBindings } from "@/lib/admin-env";
import { protectAdminConfigResponse } from "@/lib/admin-config-cache";
import {
	currentPolicyFingerprint,
	parseDataPolicyClientPrecondition,
} from "./data-policy-precondition";

const route = {
	id: "r",
	model_id: "m",
	provider_id: "p",
	provider_model_name: "model",
	upstream_protocol: "openai",
	upstream_operation: "chat",
	adapter: "passthrough",
	custom_params: null,
};
const provider = {
	id: "p",
	name: "P",
	endpoints: '{"openai":{"base":"https://synthetic.invalid/v1"}}',
	api_key: "PRIVATE_SYNTHETIC",
	shared_channel_type: null,
};
const principal = {
	type: "console" as const,
	username: "cinaauth:operator",
	id: "console:cinaauth:operator",
};
const input = {
	status: "unknown",
	retention_days: 0,
	training_allowed: false,
	zdr_supported: true,
	evidence_url: null,
	expires_at: null,
};
const policy: RouteDataPolicyRow = {
	route_target_id: "r",
	subject_fingerprint: "a".repeat(64),
	retention_days: null,
	training_allowed: 1,
	zdr_supported: 0,
	evidence_url: null,
	verified_by: null,
	verified_at: null,
	expires_at: null,
	status: "unknown",
	invalidated_at: null,
	invalidation_reason: null,
	updated_at: "2026-10-01T00:00:00.123456Z",
};
function fixture(
	options: {
		prior?: RouteDataPolicyRow | null;
		concurrent?: boolean;
		required?: string;
		denied?: boolean;
		unavailable?: boolean;
		staleJoined?: boolean;
	} = {}
) {
	const prior = options.prior === undefined ? policy : options.prior;
	const attempts: UpsertRouteDataPolicyParams[] = [];
	const commits: UpsertRouteDataPolicyParams[] = [];
	const repositories = {
		client: { driver: "d1", raw: {} },
		routes: { getModelRouteRowById: async () => route },
		providers: { getProviderById: async () => provider },
		routeDataPolicies: {
			getByRouteTargetId: async () => prior,
			listAll: async () => [
				{
					...policy,
					model_id: options.staleJoined ? "old-model" : "m",
					provider_id: options.staleJoined ? "old-provider" : "p",
					provider_name: options.staleJoined ? "Old provider" : "P",
					provider_model_name: options.staleJoined ? "old-upstream" : "model",
					upstream_protocol: options.staleJoined ? "gemini" : "openai",
					upstream_operation: options.staleJoined ? "old-operation" : "chat",
					route_group: options.staleJoined ? "old-group" : null,
				},
			],
			listAudit: async () => [],
			upsertWithAudit: async (params: UpsertRouteDataPolicyParams) => {
				attempts.push(params);
				if (options.unavailable) throw new Error("Synthetic repository fault");
				if (options.concurrent) throw new RouteDataPolicyWriteConflictError();
				commits.push(params);
				return {
					...policy,
					subject_fingerprint: params.subjectFingerprint,
					retention_days: params.retentionDays,
					training_allowed: params.trainingAllowed,
					zdr_supported: params.zdrSupported,
					evidence_url: params.evidenceUrl,
					verified_by: params.verifiedBy,
					verified_at: params.verifiedAt,
					expires_at: params.expiresAt,
					status: params.status,
					invalidated_at: null,
					invalidation_reason: null,
					updated_at: params.nowIso,
				};
			},
		},
	} as unknown as GatewayRepositories;
	const bindings = {
		STORAGE_CONTEXT: { repositories },
		ADMIN_PRINCIPAL: options.denied ? undefined : principal,
		CINATOKEN_ADMIN_DATA_POLICIES_REQUIRE_PRECONDITION: options.required,
	} as unknown as AdminBindings;
	const app = createAdminApp();
	return {
		attempts,
		commits,
		request: (
			method = "GET",
			body?: unknown,
			subject = encodeURIComponent("operator")
		) =>
			app.fetch(
				new Request(
					"https://fixture.invalid/admin/data-policies" +
						(method === "PUT" ? "/r" : ""),
					{
						method,
						headers: {
							"X-CinaToken-Expected-Console-Subject": subject,
							...(body === undefined
								? {}
								: { "Content-Type": "application/json" }),
						},
						...(body === undefined ? {} : { body: JSON.stringify(body) }),
					}
				),
				bindings
			),
	};
}
async function condition(prior: RouteDataPolicyRow | null = policy) {
	return {
		expected_subject_fingerprint:
			await computeRouteDataPolicySubjectFingerprintFromRows(route, provider),
		expected_policy_fingerprint: await currentPolicyFingerprint(prior),
	};
}
test("policy fingerprint covers every stored field and normalizes driver flags without hashing unrelated data", async () => {
	assert.equal(await currentPolicyFingerprint(null), null);
	const hash = await currentPolicyFingerprint(policy);
	assert.match(hash ?? "", /^[0-9a-f]{64}$/);
	assert.equal(
		await currentPolicyFingerprint({
			...policy,
			training_allowed: true,
			zdr_supported: false,
		}),
		hash
	);
	assert.equal(
		await currentPolicyFingerprint({
			...policy,
			untrusted: "PRIVATE",
		} as RouteDataPolicyRow),
		hash
	);
	for (const [key, value] of Object.entries(policy)) {
		const changed =
			typeof value === "number" ? value + 1 : String(value ?? "") + "x";
		assert.notEqual(
			await currentPolicyFingerprint({
				...policy,
				[key]: changed,
			} as RouteDataPolicyRow),
			hash,
			key
		);
	}
	assert.equal(parseDataPolicyClientPrecondition({}), null);
	for (const value of [
		{ expected_subject_fingerprint: "a".repeat(64) },
		{ expected_policy_fingerprint: null },
		{
			expected_subject_fingerprint: "A".repeat(64),
			expected_policy_fingerprint: null,
		},
		{
			expected_subject_fingerprint: "a".repeat(64),
			expected_policy_fingerprint: {},
		},
	])
		assert.equal(parseDataPolicyClientPrecondition(value), "invalid");
});
test("real Hono list projects current hashes and coherent absent-policy values without raw subject/credential data", async () => {
	const f = fixture({ prior: null });
	const response = await f.request();
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	const body = (await response.json()) as {
		canWrite: boolean;
		data: Array<{
			current_subject_fingerprint: string;
			current_policy_fingerprint: null;
			subject_fingerprint: null;
			status: string;
		}>;
	};
	assert.equal(body.canWrite, true);
	assert.match(body.data[0]!.current_subject_fingerprint, /^[0-9a-f]{64}$/);
	assert.equal(body.data[0]!.current_policy_fingerprint, null);
	assert.equal(body.data[0]!.subject_fingerprint, null);
	assert.equal(body.data[0]!.status, "unknown");
	assert.equal(JSON.stringify(body).includes("PRIVATE_SYNTHETIC"), false);
});
test("real Hono list binds displayed route/provider labels to the same authoritative subject snapshot", async () => {
	const f = fixture({ staleJoined: true });
	const response = await f.request();
	assert.equal(response.status, 200);
	const body = (await response.json()) as {
		data: Array<Record<string, unknown>>;
	};
	const row = body.data[0]!;
	assert.deepEqual(
		[
			row.model_id,
			row.provider_id,
			row.provider_name,
			row.provider_model_name,
			row.upstream_protocol,
			row.upstream_operation,
			row.route_group,
		],
		["m", "p", "P", "model", "openai", "chat", null]
	);
	assert.equal(
		row.current_subject_fingerprint,
		(await condition()).expected_subject_fingerprint
	);
	assert.equal(
		row.current_policy_fingerprint,
		await currentPolicyFingerprint(policy)
	);
	assert.equal(JSON.stringify(body).includes("PRIVATE_SYNTHETIC"), false);
	assert.equal(JSON.stringify(body).includes("old-upstream"), false);
});

test("real Hono pair reaches the atomic repository with trusted raw read-set and exact public ACK", async () => {
	for (const prior of [policy, null]) {
		const f = fixture({ prior });
		const response = await f.request("PUT", {
			...input,
			...(await condition(prior)),
		});
		assert.equal(response.status, 200);
		const body = (await response.json()) as { acknowledgement: unknown };
		assert.deepEqual(body.acknowledgement, {
			domain: "data-policies",
			operation: "update",
			id: "r",
		});
		assert.equal(f.attempts.length, 1);
		assert.equal(f.commits.length, 1);
		assert.deepEqual(f.attempts[0]!.precondition?.priorPolicy, prior);
		assert.equal(
			f.attempts[0]!.precondition?.subjectReadSet.provider.api_key,
			"PRIVATE_SYNTHETIC"
		);
		assert.equal(f.attempts[0]!.actorId, principal.id);
		assert.equal(JSON.stringify(body).includes("PRIVATE_SYNTHETIC"), false);
	}
});
test("real Hono stale/partial hashes and post-read transaction drift never produce a success ACK", async () => {
	const expected = await condition();
	for (const change of [
		{ expected_subject_fingerprint: "b".repeat(64) },
		{ expected_policy_fingerprint: "b".repeat(64) },
	]) {
		const f = fixture();
		const response = await f.request("PUT", {
			...input,
			...expected,
			...change,
		});
		assert.equal(response.status, 409);
		assert.equal(f.attempts.length, 0);
		assert.equal(
			((await response.json()) as { acknowledgement?: unknown })
				.acknowledgement,
			undefined
		);
	}
	const partial = fixture();
	assert.equal(
		(
			await partial.request("PUT", {
				...input,
				expected_subject_fingerprint: expected.expected_subject_fingerprint,
			})
		).status,
		400
	);
	assert.equal(partial.attempts.length, 0);
	const drift = fixture({ concurrent: true });
	const response = await drift.request("PUT", { ...input, ...expected });
	assert.equal(response.status, 409);
	assert.equal(drift.attempts.length, 1);
	assert.equal(drift.commits.length, 0);
	assert.equal(
		((await response.json()) as { code: string }).code,
		"route_data_policy_write_conflict"
	);
});
test("real Hono strict guard defaults off and only exact true requires conditions; stale Console blocks all writes", async () => {
	for (const required of [undefined, "false", "TRUE", "true"]) {
		const f = fixture({ required });
		const response = await f.request("PUT", input);
		assert.equal(response.status, required === "true" ? 428 : 200);
		assert.equal(f.commits.length, required === "true" ? 0 : 1);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
	}
	const stale = fixture();
	assert.equal(
		(await stale.request("PUT", { ...input, ...(await condition()) }, "other"))
			.status,
		403
	);
	assert.equal(stale.attempts.length, 0);
});
test("outer Next cache protection covers all three policy domains including failures before Hono", () => {
	for (const domain of ["presets", "guardrails", "data-policies"])
		for (const status of [401, 403, 413, 500, 503]) {
			const response = protectAdminConfigResponse(
				new Request("https://fixture.invalid/api/admin/" + domain + "/nested"),
				Response.json({ success: false }, { status })
			);
			assert.equal(response.headers.get("cache-control"), "private, no-store");
		}
});
