import assert from "node:assert/strict";
import test from "node:test";
import type { AdminSharedKeyAuditRow } from "@octafuse/core";
import type { AdminPrincipal } from "@/lib/admin-principal";
import { cinaAuthSessionUsername } from "@/lib/cinaauth/principal";
import {
	encodeSharedKeyAdminCursor,
	sharedKeyAdminActor,
	sharedKeyAdminAuditQuery,
	sharedKeyAdminJson,
	sharedKeyAdminListQuery,
	sharedKeyAdminWriteBody,
} from "./shared-key-admin-contract";
import {
	projectAdminSharedKeyAudit,
	redactSharedKeyAdminText,
	sharedKeyAdminCurrencyReference,
	sharedKeyAdminFailureCode,
} from "./shared-key-admin-dto";

const base = "https://admin.example.test/admin/shared-keys/overview";
const revision = `sha256:${"a".repeat(64)}`;
const audit = {
	createdAt: "2026-09-30T01:02:03.123456Z",
	id: "00000000-0000-4000-8000-000000000001",
};

test("strict bounded pagination retains exact allowed filters and legacy array bounds", () => {
	assert.deepEqual(
		sharedKeyAdminListQuery(
			`${base}?page=2&page_size=100&status=disabled&channelType=deepseek&seller_user_id=seller-1&search=label%20%25_%5C`
		),
		{
			page: 2,
			pageSize: 100,
			status: "disabled",
			channelType: "deepseek",
			sellerUserId: "seller-1",
			search: "label %_\\",
		}
	);
	assert.deepEqual(sharedKeyAdminListQuery(base, true), {
		page: 1,
		pageSize: 100,
	});
	for (const query of [
		"page=0",
		"page=01",
		"page=1000001",
		"page=1e2",
		"page_size=101",
		"page_size=",
		"page=1&page=1",
		"status=",
		"status=unknown",
		"channelType=gemini",
		"seller_user_id=",
		"seller_user_id=owner%2Fother",
		"search=%20",
		"search=%20x",
		"search=x%0A",
		"sort=weight",
		"order=asc",
		"email=x",
		`search=${"x".repeat(201)}`,
	]) {
		assert.throws(
			() => sharedKeyAdminListQuery(`${base}?${query}`),
			{ status: 400 },
			query
		);
	}
	assert.throws(() => sharedKeyAdminListQuery(`${base}?page=2`, true), {
		status: 400,
	});
});

test("JSON duplicate names including escaped names and nested objects are rejected", () => {
	assert.deepEqual(
		sharedKeyAdminJson('{"reason":"colon: comma, brace{ quote\\"","weight":2}'),
		{
			reason: 'colon: comma, brace{ quote"',
			weight: 2,
		}
	);
	for (const raw of [
		'{"weight":1,"weight":2}',
		'{"weight":1,"we\\u0069ght":2}',
		'{"nested":{"x":1,"x":2}}',
		'{"nested":[{"x":1,"x":2}]}',
		"[]",
		"null",
		"{bad}",
		'{"reason":"' + "x".repeat(65536) + '"}',
	])
		assert.throws(
			() => sharedKeyAdminJson(raw),
			{ status: 400 },
			raw.slice(0, 80)
		);
});

test("governance numbers, fields, reason and revision are strict without coercion", () => {
	const valid = sharedKeyAdminWriteBody(
		JSON.stringify({
			expected_revision: revision,
			reason: "  operator review  ",
			sellerPriority: -2147483648,
			weight: 100,
			status: "paused",
		}),
		"update",
		true
	);
	assert.deepEqual(valid, {
		expectedRevision: revision,
		reason: "operator review",
		source: "admin_api",
		patch: { sellerPriority: -2147483648, weight: 100, status: "paused" },
		rejectedActive: false,
	});
	for (const body of [
		{ weight: "2" },
		{ weight: 0 },
		{ weight: 101 },
		{ weight: 1.1 },
		{ sellerPriority: 2147483648 },
		{ sellerPriority: -2147483649 },
		{ status: "invalid" },
		{ status: null },
		{ actor: "console:forged", weight: 2 },
		{ source: "web", weight: 2 },
		{ expected_revision: revision, weight: 2 },
		{ expected_revision: revision, reason: "", weight: 2 },
		{ expected_revision: revision, reason: "x\n", weight: 2 },
		{ expected_revision: revision, reason: "x".repeat(601), weight: 2 },
		{ expected_revision: "sha256:X", reason: "x", weight: 2 },
		{ expected_revision: revision, reason: "x" },
	])
		assert.throws(
			() => sharedKeyAdminWriteBody(JSON.stringify(body), "update", false),
			{ status: 400 }
		);
	assert.throws(() => sharedKeyAdminWriteBody('{"weight":2}', "update", true), {
		status: 428,
	});
	assert.throws(
		() => sharedKeyAdminWriteBody('{"weight":2}', "delete", false),
		{ status: 400 }
	);
});

test("default-off compatibility uses an explicit legacy source and server reason", () => {
	const body = sharedKeyAdminWriteBody('{"weight":2}', "update", false);
	assert.equal(body.source, "legacy_admin");
	assert.match(body.reason, /^legacy-admin-shared-key-update:/u);
	assert.equal(
		sharedKeyAdminWriteBody("", "delete", false).source,
		"legacy_admin"
	);
	assert.equal(
		sharedKeyAdminWriteBody('{"status":"active"}', "update", false)
			.rejectedActive,
		true
	);
});

test("only trusted Console or named API principal determines audit actor", () => {
	assert.deepEqual(
		sharedKeyAdminActor(
			{
				type: "api_key",
				id: "admin_key:legacy-master",
				keyId: "legacy-master",
				permissions: ["providers.write"],
			},
			true
		),
		{ actorKind: "api_key", actorId: "admin_key:legacy-master" }
	);
	assert.deepEqual(
		sharedKeyAdminActor(
			{ type: "console", id: "console:reviewer", username: "ignored" },
			true
		),
		{
			actorKind: "console",
			actorId: "console:reviewer",
		}
	);
	assert.throws(
		() =>
			sharedKeyAdminActor(
				{
					type: "api_key",
					id: "admin_key:forged",
					keyId: "real",
					permissions: ["*"],
				},
				true
			),
		{ status: 403 }
	);
	assert.throws(
		() =>
			sharedKeyAdminActor(
				{
					type: "api_key",
					id: "admin_key:reader",
					keyId: "reader",
					permissions: ["providers.read"],
				},
				true
			),
		{ status: 403 }
	);
});

test("Console actor bounds include both trusted prefixes while named API actor bounds remain 600", () => {
	for (const length of [583, 584, 600]) {
		const username = cinaAuthSessionUsername("x".repeat(length));
		const principal: AdminPrincipal = {
			type: "console",
			id: `console:${username}`,
			username,
		};
		for (const write of [false, true])
			assert.deepEqual(sharedKeyAdminActor(principal, write), {
				actorKind: "console",
				actorId: principal.id,
			});
		assert.equal(principal.id.length, length + 17);
	}
	const username = cinaAuthSessionUsername("x".repeat(601));
	assert.throws(
		() =>
			sharedKeyAdminActor(
				{ type: "console", id: `console:${username}`, username },
				true
			),
		{
			status: 403,
			code: "shared_key_trusted_actor_required",
		}
	);
	for (const length of [600, 601]) {
		const keyId = "x".repeat(length - "admin_key:".length);
		const principal: AdminPrincipal = {
			type: "api_key",
			id: `admin_key:${keyId}`,
			keyId,
			permissions: ["providers.read", "providers.write"],
		};
		if (length === 600)
			assert.deepEqual(sharedKeyAdminActor(principal, true), {
				actorKind: "api_key",
				actorId: principal.id,
			});
		else
			assert.throws(() => sharedKeyAdminActor(principal, true), {
				status: 403,
			});
	}
});

test("audit actor DTO validates the complete raw kind-specific bound before safe display redaction", () => {
	const entry = (
		actorKind: AdminSharedKeyAuditRow["actorKind"],
		actorId: string
	): AdminSharedKeyAuditRow => ({
		id: audit.id,
		createdAt: audit.createdAt,
		keyId: "key-1",
		action: "updated",
		changeMask: 4,
		actorKind,
		actorId,
		source: "admin_api",
		reason: "r".repeat(600),
		before: {
			status: "disabled",
			sellerPriority: 0,
			weight: 1,
			validated: true,
		},
		after: {
			status: "disabled",
			sellerPriority: 0,
			weight: 2,
			validated: true,
		},
		beforeRevision: revision,
		afterRevision: `sha256:${"b".repeat(64)}`,
	});
	for (const [actorKind, length] of [
		["console", 600],
		["console", 601],
		["console", 617],
		["api_key", 600],
	] as const) {
		const original = entry(actorKind, "x".repeat(length));
		const projected = projectAdminSharedKeyAudit(original, "key-1");
		assert.equal(projected.actorId, original.actorId);
		assert.equal(projected.reason.length, 600);
	}
	for (const [actorKind, actorId] of [
		["console", "x".repeat(618)],
		["api_key", "x".repeat(601)],
		["api_key", `sk-${"x".repeat(598)}`],
		["console", "actor\nline"],
		["console", "actor\u202e"],
	] as const)
		assert.throws(
			() => projectAdminSharedKeyAudit(entry(actorKind, actorId), "key-1"),
			{
				message: "Invalid stored Shared Key governance data",
			}
		);
	const original = entry("console", `console:cinaauth:sk-${"x".repeat(597)}`);
	assert.equal(original.actorId.length, 617);
	assert.equal(
		projectAdminSharedKeyAudit(original, "key-1").actorId,
		"console:cinaauth:[redacted]"
	);
	assert.throws(() =>
		projectAdminSharedKeyAudit(
			{ ...entry("console", "operator"), reason: "r".repeat(601) },
			"key-1"
		)
	);
});

test("audit cursors are canonical, key-bound and preserve microseconds including Unicode IDs", () => {
	for (const id of ["key-1", "历史键"]) {
		const cursor = encodeSharedKeyAdminCursor(id, audit);
		assert.deepEqual(
			sharedKeyAdminAuditQuery(`${base}?page_size=100&cursor=${cursor}`, id),
			{
				pageSize: 100,
				before: audit,
			}
		);
		assert.throws(
			() => sharedKeyAdminAuditQuery(`${base}?cursor=${cursor}`, "other-key"),
			{ status: 400 }
		);
		assert.throws(
			() => sharedKeyAdminAuditQuery(`${base}?cursor=${cursor}=`, id),
			{ status: 400 }
		);
	}
	for (const query of [
		"limit=20",
		"before=x",
		"cursor=",
		"cursor=%23",
		"page_size=101",
		"cursor=x&cursor=x",
	])
		assert.throws(() => sharedKeyAdminAuditQuery(`${base}?${query}`, "key-1"), {
			status: 400,
		});
	assert.throws(
		() =>
			encodeSharedKeyAdminCursor("key-1", {
				...audit,
				createdAt: "2026-02-30T00:00:00.000001Z",
			}),
		{
			status: 400,
		}
	);
});

test("complete secret and ciphertext redaction precedes truncation; failure categories never echo errors", () => {
	const secret = `legacy-${"x".repeat(400)}`;
	const cipher = "enc:v2:aGVsbG8=:c2VjcmV0";
	assert.equal(redactSharedKeyAdminText(secret, [secret], 255), "[redacted]");
	const text = redactSharedKeyAdminText(
		`short abc ${cipher} sk-sensitive-key ${"f".repeat(
			64
		)} password="unprefixed"`,
		["abc"],
		600
	);
	for (const raw of [
		"abc",
		cipher,
		"sk-sensitive-key",
		"f".repeat(64),
		"unprefixed",
	])
		assert.ok(!text.includes(raw), raw);
	assert.equal(
		sharedKeyAdminFailureCode("upstream auth rejected (HTTP 401)"),
		"credential_rejected"
	);
	assert.equal(
		sharedKeyAdminFailureCode("validation request timed out"),
		"validation_timeout"
	);
	assert.equal(
		sharedKeyAdminFailureCode("failure includes sk-sensitive-key"),
		"unknown_failure"
	);
});

test("current currency reference distinguishes missing/invalid and never relabels old quotes", () => {
	assert.deepEqual(sharedKeyAdminCurrencyReference("CNY"), {
		currentBillingCurrency: "CNY",
		currentBillingCurrencySource: "configured",
		currentBillingCurrencyReferenceOnly: true,
	});
	assert.equal(
		sharedKeyAdminCurrencyReference(null).currentBillingCurrencySource,
		"missing"
	);
	for (const value of ["", "usd", " USD ", "USDT", {}, 1])
		assert.deepEqual(sharedKeyAdminCurrencyReference(value), {
			currentBillingCurrency: null,
			currentBillingCurrencySource: "invalid",
			currentBillingCurrencyReferenceOnly: true,
		});
});
