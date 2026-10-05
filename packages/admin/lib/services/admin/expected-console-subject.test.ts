import assert from "node:assert/strict";
import test from "node:test";
import {
	sharedKeyAdminRevision,
	sharedKeyStateExpectation,
	type AdminSharedKeyDelete,
	type AdminSharedKeyUpdate,
	type GatewayRepositories,
	type SharedKeyRow,
} from "@octafuse/core";
import { createAdminApp } from "@/lib/admin-app";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPrincipal } from "@/lib/admin-principal";
import { cinaAuthSessionUsername } from "@/lib/cinaauth/principal";
import {
	assertExpectedConsoleSubject,
	EXPECTED_CONSOLE_SUBJECT_HEADER,
	ExpectedConsoleSubjectError,
} from "./expected-console-subject";

function consolePrincipal(subject: string): AdminPrincipal {
	const username = cinaAuthSessionUsername(subject);
	return { type: "console", id: `console:${username}`, username };
}
const namedPrincipal: AdminPrincipal = {
	type: "api_key",
	id: "admin_key:named-operator",
	keyId: "named-operator",
	permissions: ["providers.write", "users.write"],
};
const key: SharedKeyRow = {
	id: "key-1",
	sellerUserId: "seller-1",
	channelType: "openai",
	apiKey: "never-reflect-credential",
	keyFingerprint: "f".repeat(64),
	label: "Reviewed key",
	status: "disabled",
	sellerPriority: 0,
	weight: 1,
	inputPrice: 1,
	outputPrice: 2,
	cacheReadPrice: null,
	cacheWritePrice: null,
	validatedAt: null,
	lastUsedAt: null,
	lastFailureAt: null,
	failureReason: null,
	servedInputTokens: 0,
	servedOutputTokens: 0,
	earnedTotal: 0,
	earnedTotalExact: "0.000000",
	createdAt: "2026-09-30T00:00:00.000Z",
	updatedAt: "2026-09-30T00:00:00.000Z",
};
const endpoints = [
	{ path: "/admin/shared-keys/key-1", method: "PATCH", body: { weight: 2 } },
	{ path: "/admin/shared-keys/key-1", method: "DELETE", body: undefined },
	{ path: "/admin/earnings/rederive?apply=0", method: "POST", body: undefined },
	{ path: "/admin/earnings/rederive?apply=1", method: "POST", body: undefined },
] as const;

function fixture(
	principal: AdminPrincipal | undefined = consolePrincipal("subject-current"),
	strict = false
) {
	const calls = {
		details: 0,
		logs: 0,
		mutations: [] as Array<AdminSharedKeyUpdate | AdminSharedKeyDelete>,
	};
	const repositories = {
		sharedKeys: {
			getAdminSharedKeyById: async () => {
				calls.details++;
				return key;
			},
			updateSharedKeyAdminWithAudit: async (input: AdminSharedKeyUpdate) => {
				calls.mutations.push(input);
				return "applied";
			},
			deleteSharedKeyAdminWithAudit: async (input: AdminSharedKeyDelete) => {
				calls.mutations.push(input);
				return "applied";
			},
		},
		requestLogs: {
			getRequestLogs: async () => {
				calls.logs++;
				return { logs: [], total: 0 };
			},
		},
	} as unknown as GatewayRepositories;
	const bindings = {
		STORAGE_CONTEXT: { repositories },
		ADMIN_PRINCIPAL: principal,
		CINATOKEN_ADMIN_SHARED_KEYS_REQUIRE_REVISION: strict ? "true" : "false",
	} as unknown as AdminBindings;
	const app = createAdminApp();
	return {
		calls,
		setPrincipal: (next: AdminPrincipal | undefined) => {
			bindings.ADMIN_PRINCIPAL = next;
		},
		request: (
			path: string,
			method: string,
			body?: unknown,
			headers: HeadersInit = {}
		) => {
			const requestHeaders = new Headers(headers);
			if (body !== undefined)
				requestHeaders.set("Content-Type", "application/json");
			return app.request(
				path,
				{
					method,
					headers: requestHeaders,
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				},
				bindings
			);
		},
	};
}
function assertUntouched(subject: ReturnType<typeof fixture>) {
	assert.deepEqual(subject.calls, { details: 0, logs: 0, mutations: [] });
}
async function assertFailure(response: Response, status: number, code: string) {
	assert.equal(response.status, status);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	const payload = (await response.json()) as {
		success: boolean;
		code: string;
		message: string;
	};
	assert.equal(payload.success, false);
	assert.equal(payload.code, code);
	assert.ok(!JSON.stringify(payload).includes("subject-current"));
	assert.ok(!JSON.stringify(payload).includes("subject-stale"));
	assert.ok(!JSON.stringify(payload).includes("never-reflect-credential"));
}
function assertSubjectError(
	principal: AdminPrincipal,
	header: string | undefined,
	status: number,
	code: string,
	required = false
) {
	assert.throws(
		() => assertExpectedConsoleSubject(principal, header, required),
		(error) =>
			error instanceof ExpectedConsoleSubjectError &&
			error.status === status &&
			error.code === code
	);
}

test("canonical opaque subjects preserve Unicode, internal spaces, slash and literal percent sequences", () => {
	for (const subject of [
		"plain-subject",
		"用户/관리자",
		"team member",
		"issuer/user",
		"literal%2Fsubject",
		"literal%252Fsubject",
		"comma,subject",
	])
		assert.doesNotThrow(() =>
			assertExpectedConsoleSubject(
				consolePrincipal(subject),
				encodeURIComponent(subject),
				true
			)
		);
	assert.doesNotThrow(() =>
		assertExpectedConsoleSubject(
			consolePrincipal("x".repeat(600)),
			"x".repeat(600),
			true
		)
	);
});

test("invalid and noncanonical encodings, controls, edge whitespace and bounds are rejected", () => {
	for (const header of [
		"",
		"%",
		"%2",
		"%GG",
		"%ED%A0%80",
		"%FF",
		"%61",
		"%2f",
		"a/b",
		"team member",
		"a+b",
		encodeURIComponent(" leading"),
		encodeURIComponent("trailing "),
		encodeURIComponent("x\u0000y"),
		encodeURIComponent("x\u007fy"),
		encodeURIComponent("x\u200dy"),
		encodeURIComponent("x\u202ey"),
		"x".repeat(601),
		"x".repeat(5401),
	])
		assertSubjectError(
			consolePrincipal("subject-current"),
			header,
			400,
			"invalid_console_subject_precondition"
		);
});

test("one decoding layer never aliases a different opaque subject or a legacy Console identity", () => {
	assertSubjectError(
		consolePrincipal("issuer/user"),
		encodeURIComponent(encodeURIComponent("issuer/user")),
		403,
		"console_subject_mismatch"
	);
	assertSubjectError(
		consolePrincipal("subject-current"),
		"subject-stale",
		403,
		"console_subject_mismatch"
	);
	assertSubjectError(
		{ type: "console", id: "console:operator", username: "operator" },
		"operator",
		403,
		"console_subject_mismatch"
	);
	assertSubjectError(
		{
			type: "console",
			id: "console:other",
			username: cinaAuthSessionUsername("subject-current"),
		},
		"subject-current",
		403,
		"console_subject_mismatch"
	);
});

test("missing headers preserve legacy compatibility and named Bearer behavior, strict Console requires 428", () => {
	assert.doesNotThrow(() =>
		assertExpectedConsoleSubject(consolePrincipal("subject-current"), undefined)
	);
	assert.doesNotThrow(() =>
		assertExpectedConsoleSubject(namedPrincipal, undefined, true)
	);
	assertSubjectError(
		consolePrincipal("subject-current"),
		undefined,
		428,
		"console_subject_required",
		true
	);
	assertSubjectError(
		namedPrincipal,
		"subject-current",
		400,
		"invalid_console_subject_precondition"
	);
});

test("all Shared governance and earnings review routes reject a stale subject before storage", async () => {
	for (const endpoint of endpoints) {
		const subject = fixture();
		const response = await subject.request(
			endpoint.path,
			endpoint.method,
			endpoint.body,
			{
				[EXPECTED_CONSOLE_SUBJECT_HEADER]: "subject-stale",
			}
		);
		await assertFailure(response, 403, "console_subject_mismatch");
		assertUntouched(subject);
	}
});

test("malformed, noncanonical and duplicate headers fail closed before any repository call", async () => {
	for (const header of [
		"%GG",
		"%73ubject-current",
		"%2f",
		encodeURIComponent("x\u200dy"),
		"x".repeat(601),
	]) {
		for (const endpoint of endpoints) {
			const subject = fixture();
			await assertFailure(
				await subject.request(endpoint.path, endpoint.method, endpoint.body, {
					[EXPECTED_CONSOLE_SUBJECT_HEADER]: header,
				}),
				400,
				"invalid_console_subject_precondition"
			);
			assertUntouched(subject);
		}
	}
	for (const endpoint of endpoints) {
		const subject = fixture();
		const headers = new Headers();
		headers.append(EXPECTED_CONSOLE_SUBJECT_HEADER, "subject-current");
		headers.append(EXPECTED_CONSOLE_SUBJECT_HEADER, "subject-current");
		await assertFailure(
			await subject.request(
				endpoint.path,
				endpoint.method,
				endpoint.body,
				headers
			),
			400,
			"invalid_console_subject_precondition"
		);
		assertUntouched(subject);
	}
});

test("strict Console governance requires both subject and revision, earnings remains missing-header compatible", async () => {
	for (const endpoint of endpoints.slice(0, 2)) {
		const subject = fixture(consolePrincipal("subject-current"), true);
		await assertFailure(
			await subject.request(endpoint.path, endpoint.method, {
				expected_revision: await sharedKeyAdminRevision(
					key.id,
					sharedKeyStateExpectation(key)
				),
				reason: "Reviewed",
				...(endpoint.body ?? {}),
			}),
			428,
			"console_subject_required"
		);
		assertUntouched(subject);
		const missingRevision = await subject.request(
			endpoint.path,
			endpoint.method,
			{ reason: "Reviewed", ...(endpoint.body ?? {}) },
			{ [EXPECTED_CONSOLE_SUBJECT_HEADER]: "subject-current" }
		);
		assert.equal(missingRevision.status, 428);
		assert.equal(
			missingRevision.headers.get("cache-control"),
			"private, no-store"
		);
		assertUntouched(subject);
	}
	for (const endpoint of endpoints.slice(2)) {
		const subject = fixture(consolePrincipal("subject-current"), true);
		const response = await subject.request(endpoint.path, endpoint.method);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.deepEqual(subject.calls, { details: 0, logs: 1, mutations: [] });
	}
});

test("successful explicit governance audits the authenticated actor without deriving identity from the header", async () => {
	for (const subjectId of ["subject-current", "用户/team member%2F"]) {
		const principal = consolePrincipal(subjectId);
		for (const endpoint of endpoints.slice(0, 2)) {
			const subject = fixture(principal, true);
			const response = await subject.request(
				endpoint.path,
				endpoint.method,
				{
					expected_revision: await sharedKeyAdminRevision(
						key.id,
						sharedKeyStateExpectation(key)
					),
					reason: "Reviewed by operator",
					...(endpoint.body ?? {}),
				},
				{ [EXPECTED_CONSOLE_SUBJECT_HEADER]: encodeURIComponent(subjectId) }
			);
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("cache-control"), "private, no-store");
			assert.equal(subject.calls.details, 1);
			assert.equal(subject.calls.mutations.length, 1);
			assert.equal(subject.calls.mutations[0].audit.actorKind, "console");
			assert.equal(subject.calls.mutations[0].audit.actorId, principal.id);
			assert.equal(subject.calls.mutations[0].audit.source, "admin_api");
			assert.equal(
				subject.calls.mutations[0].audit.reason,
				"Reviewed by operator"
			);
		}
	}
});

test("the compatibility path remains atomic and named Bearer permissions and actors are unchanged", async () => {
	for (const principal of [
		consolePrincipal("subject-current"),
		namedPrincipal,
	]) {
		for (const endpoint of endpoints.slice(0, 2)) {
			const subject = fixture(principal);
			assert.equal(
				(await subject.request(endpoint.path, endpoint.method, endpoint.body))
					.status,
				200
			);
			assert.equal(subject.calls.mutations.length, 1);
			assert.equal(subject.calls.mutations[0].audit.actorId, principal.id);
			assert.equal(subject.calls.mutations[0].audit.source, "legacy_admin");
		}
	}
	for (const endpoint of endpoints) {
		const subject = fixture(namedPrincipal, true);
		const body =
			endpoint.method === "POST"
				? undefined
				: {
						expected_revision: await sharedKeyAdminRevision(
							key.id,
							sharedKeyStateExpectation(key)
						),
						reason: "Named operator review",
						...(endpoint.body ?? {}),
				  };
		assert.equal(
			(await subject.request(endpoint.path, endpoint.method, body)).status,
			200
		);
		if (endpoint.method !== "POST")
			assert.equal(subject.calls.mutations[0].audit.actorKind, "api_key");
		const denied = fixture(namedPrincipal, true);
		await assertFailure(
			await denied.request(endpoint.path, endpoint.method, body, {
				[EXPECTED_CONSOLE_SUBJECT_HEADER]: "subject-current",
			}),
			400,
			"invalid_console_subject_precondition"
		);
		assertUntouched(denied);
	}
});

test("a late authentication change after a valid precheck cannot execute the earlier subject draft", async () => {
	const before = consolePrincipal("subject-current");
	const after = consolePrincipal("subject-stale");
	assertExpectedConsoleSubject(before, "subject-current", true);
	for (const endpoint of endpoints) {
		const subject = fixture(before);
		subject.setPrincipal(after);
		const body =
			endpoint.method === "POST"
				? undefined
				: {
						expected_revision: await sharedKeyAdminRevision(
							key.id,
							sharedKeyStateExpectation(key)
						),
						reason: "Earlier subject review",
						...(endpoint.body ?? {}),
				  };
		await assertFailure(
			await subject.request(endpoint.path, endpoint.method, body, {
				[EXPECTED_CONSOLE_SUBJECT_HEADER]: "subject-current",
			}),
			403,
			"console_subject_mismatch"
		);
		assertUntouched(subject);
	}
});

test("outer authentication and permission denials remain private and do not access storage methods", async () => {
	for (const endpoint of endpoints) {
		for (const principal of [
			undefined,
			{ ...namedPrincipal, permissions: ["analytics.read"] } as AdminPrincipal,
		]) {
			const subject = fixture();
			subject.setPrincipal(principal);
			const response = await subject.request(
				endpoint.path,
				endpoint.method,
				endpoint.body,
				{
					[EXPECTED_CONSOLE_SUBJECT_HEADER]: "subject-current",
				}
			);
			assert.equal(response.status, principal ? 403 : 401);
			assert.equal(response.headers.get("cache-control"), "private, no-store");
			assertUntouched(subject);
		}
	}
});
