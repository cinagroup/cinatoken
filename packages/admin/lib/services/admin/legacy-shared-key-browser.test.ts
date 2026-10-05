import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AdminSharedKeyDetail } from "./shared-key-admin-dto";
import {
	legacySharedKeyAudit,
	legacySharedKeyCanRecover,
	legacySharedKeyClearMarker,
	legacySharedKeyDetail,
	legacySharedKeyHeaders,
	legacySharedKeyMark,
	legacySharedKeyOverview,
	legacySharedKeyQuery,
	legacySharedKeyReadMarker,
	legacySharedKeyRow,
	legacySharedKeyScope,
	legacySharedKeySubject,
	legacySharedKeyWriteBody,
	legacySharedKeyWriteResult,
	type LegacySharedKeyFilters,
	type LegacySharedKeyMarker,
	type LegacySharedKeyStorage,
} from "./legacy-shared-key-browser";

const revision = `sha256:${"a".repeat(64)}`;
const otherRevision = `sha256:${"b".repeat(64)}`;
const stamp = "2026-09-30T00:00:00.000123Z";
const auditId = "00000000-0000-4000-8000-000000000001";
const filters: LegacySharedKeyFilters = {
	page: 1,
	pageSize: 20,
	status: "",
	channelType: "",
	sellerUserId: "",
	search: "",
};
const detail: AdminSharedKeyDetail = {
	id: "shared-1",
	sellerUserId: "seller-1",
	sellerEmail: "seller@example.test",
	channelType: "openai",
	label: "Public label",
	status: "active",
	sellerPriority: 0,
	weight: 10,
	inputPrice: 1,
	outputPrice: 2,
	cacheReadPrice: null,
	cacheWritePrice: 0.5,
	validatedAt: stamp,
	lastUsedAt: null,
	lastFailureAt: null,
	createdAt: stamp,
	updatedAt: stamp,
	servedInputTokens: 20,
	servedOutputTokens: 30,
	earnedTotal: 0.012345,
	apiKeyMasked: "••••••••",
	failureCode: null,
	profile_revision: revision,
	quoteCurrency: null,
	quoteCurrencyAvailability: "legacy_unrecorded",
	quoteUnit: "per_million_tokens",
	earningsCurrency: "USD",
	earningsAmountUnit: "major",
	statisticsBasis: "legacy_cached_projection",
	currentBillingCurrency: "CNY",
	currentBillingCurrencySource: "configured",
	currentBillingCurrencyReferenceOnly: true,
	capabilities: {
		can_write: true,
		user_detail: true,
		request_logs: true,
		can_review_earnings: true,
	},
};
const overview = {
	...detail,
	items: [detail],
	total: 21,
	page: 1,
	page_size: 20,
	hasMore: true,
};
const pending: LegacySharedKeyMarker = {
	v: 1,
	keyId: detail.id,
	operation: "update",
};
function storage() {
	const values = new Map<string, string>();
	const object: LegacySharedKeyStorage = {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value);
		},
		removeItem: (key) => {
			values.delete(key);
		},
	};
	return { object, values };
}
const audit = {
	id: auditId,
	keyId: detail.id,
	createdAt: stamp,
	action: "disabled",
	changeMask: 1,
	actorKind: "console",
	actorId: "operator",
	source: "admin_api",
	reason: "Reason that must not enter recovery summaries",
	before: { status: "active", sellerPriority: 0, weight: 10, validated: true },
	after: { status: "disabled", sellerPriority: 0, weight: 10, validated: true },
	beforeRevision: revision,
	afterRevision: otherRevision,
};
function cursor(keyId: string, id: string, createdAt = stamp) {
	return Buffer.from(
		JSON.stringify({ v: 1, key_id: keyId, created_at: createdAt, id })
	).toString("base64url");
}

test("ordinary rows reconstruct the safe whitelist and omit credentials, raw failures, actor and detail context", () => {
	const safe = legacySharedKeyRow({
		...detail,
		apiKey: "private-secret",
		keyFingerprint: "private-fingerprint",
		failureReason: "private-error",
		raw: { private: true },
	});
	for (const field of [
		"apiKey",
		"keyFingerprint",
		"failureReason",
		"raw",
		"capabilities",
		"currentBillingCurrency",
	])
		assert.ok(!Object.hasOwn(safe, field));
	assert.ok(!JSON.stringify(safe).includes("private-"));
	assert.equal(safe.apiKeyMasked, "••••••••");
	assert.equal(safe.cacheReadPrice, null);
	assert.equal(safe.cacheWritePrice, 0.5);
	assert.equal(safe.earningsCurrency, "USD");
});
test("browser display text redacts token patterns without retaining raw response objects", () => {
	const safe = legacySharedKeyRow({
		...detail,
		label: "Bearer private-token",
		sellerEmail: "sk-private-token-1234567890",
	});
	assert.equal(safe.label, "[redacted]");
	assert.equal(safe.sellerEmail, "[redacted]");
});
test("row rejects unsafe mask/failure/currency/profile/count/timestamp contracts", () => {
	for (const patch of [
		{ apiKeyMasked: "sk-rawsecret" },
		{ failureCode: "raw upstream failure" },
		{ quoteCurrency: "USD" },
		{ quoteCurrencyAvailability: "recorded" },
		{ earningsCurrency: "CNY" },
		{ quoteUnit: "per_token" },
		{ profile_revision: "a".repeat(64) },
		{ sellerPriority: 1.5 },
		{ weight: 101 },
		{ inputPrice: Infinity },
		{ servedInputTokens: -1 },
		{ createdAt: "2026-02-30T00:00:00.000Z" },
		{ id: "bad/id" },
		{ sellerUserId: "\uD800" },
	])
		assert.throws(
			() => legacySharedKeyRow({ ...detail, ...patch }),
			JSON.stringify(patch)
		);
});
test("overview binds exact page, size and filters while preserving total/hasMore for every page", () => {
	const safe = legacySharedKeyOverview(overview, filters);
	assert.equal(safe.total, 21);
	assert.equal(safe.hasMore, true);
	assert.equal(safe.items.length, 1);
	const second = legacySharedKeyOverview(
		{ ...overview, page: 2, total: 21, hasMore: false },
		{ ...filters, page: 2 }
	);
	assert.equal(second.page, 2);
	for (const value of [
		{ ...overview, page: 2 },
		{ ...overview, page_size: 100 },
		{ ...overview, hasMore: false },
		{ ...overview, items: [detail, detail] },
		{ ...overview, currentBillingCurrencyReferenceOnly: false },
	])
		assert.throws(() => legacySharedKeyOverview(value, filters));
	assert.throws(() =>
		legacySharedKeyOverview(overview, { ...filters, sellerUserId: "other" })
	);
	assert.throws(() =>
		legacySharedKeyOverview(overview, { ...filters, status: "disabled" })
	);
});
test("query uses only overview with strict bounded pagination and encoded search/ownership filters", () => {
	const query = legacySharedKeyQuery({
		...filters,
		page: 3,
		pageSize: 100,
		status: "disabled",
		channelType: "anthropic",
		sellerUserId: "seller-1",
		search: "%_&literal",
	});
	const parsed = new URL(query, "https://console.example");
	assert.equal(parsed.pathname, "/api/admin/shared-keys/overview");
	assert.equal(parsed.searchParams.get("search"), "%_&literal");
	assert.equal(parsed.searchParams.get("seller_user_id"), "seller-1");
	assert.equal(parsed.searchParams.get("page_size"), "100");
	for (const patch of [
		{ page: 1_000_001 },
		{ page: 1.5 },
		{ pageSize: 101 },
		{ status: "all" },
		{ channelType: "unknown" },
		{ sellerUserId: "seller/id" },
		{ search: " padded " },
		{ search: "x\n" },
	])
		assert.throws(() => legacySharedKeyQuery({ ...filters, ...patch }));
});
test("detail must match the reviewed immutable ID, seller and channel; extras remain omitted", () => {
	assert.equal(
		legacySharedKeyDetail(detail, detail).profile_revision,
		revision
	);
	for (const patch of [
		{ id: "other" },
		{ sellerUserId: "other" },
		{ channelType: "deepseek" },
	])
		assert.throws(() => legacySharedKeyDetail({ ...detail, ...patch }, detail));
});
test("verified subject requires exact live Console proof; legacy, degraded, api_key and malformed subjects stay read-only", () => {
	assert.equal(
		legacySharedKeySubject({
			authenticated: true,
			principalType: "console",
			verification: "verified",
			subject: "console-user",
		}),
		"console-user"
	);
	for (const value of [
		{ authenticated: true },
		{ authenticated: false, subject: "console-user" },
		{
			authenticated: true,
			principalType: "api_key",
			verification: "verified",
			subject: "console-user",
		},
		{
			authenticated: true,
			principalType: "console",
			verification: "degraded",
			subject: "console-user",
		},
		{
			authenticated: true,
			principalType: "console",
			verification: "verified",
			subject: "bad\n",
		},
	])
		assert.equal(legacySharedKeySubject(value), null);
});
test("subject scopes are opaque and isolate unknown operations between principals", async () => {
	const a = await legacySharedKeyScope("subject-A");
	const b = await legacySharedKeyScope("subject-B");
	assert.notEqual(a, b);
	assert.ok(!a.includes("subject-A"));
	assert.match(a, /^cinatoken:legacy-shared-governance:v1:[0-9a-f]{64}$/u);
	const f = storage();
	legacySharedKeyMark(f.object, a, pending);
	assert.deepEqual(legacySharedKeyReadMarker(f.object, a), pending);
	assert.equal(legacySharedKeyReadMarker(f.object, b), null);
});
test("subject validation matches server boundary trimming while preserving internal spaces, slashes and literal percent text", () => {
	for (const subject of [" leading", "trailing ", "\uD800"]) {
		assert.equal(
			legacySharedKeySubject({
				authenticated: true,
				principalType: "console",
				verification: "verified",
				subject,
			}),
			null
		);
	}
	assert.equal(
		legacySharedKeySubject({
			authenticated: true,
			principalType: "console",
			verification: "verified",
			subject: "console / internal %20 subject",
		}),
		"console / internal %20 subject"
	);
});
test("mutation header binds the verified subject as a transport precondition, with no body actor or marker subject", () => {
	const headers = legacySharedKeyHeaders("console:user / 雪");
	assert.deepEqual(headers, {
		"content-type": "application/json",
		"X-CinaToken-Expected-Console-Subject":
			encodeURIComponent("console:user / 雪"),
	});
	assert.throws(() => legacySharedKeyHeaders("bad\nsubject"));
	assert.throws(() => legacySharedKeyHeaders("\uD800"));
	const body = legacySharedKeyWriteBody(detail, "disable", "reason", "", "");
	assert.ok(!Object.hasOwn(body, "subject"));
	assert.ok(!Object.hasOwn(body, "actorId"));
	const f = storage();
	assert.throws(() =>
		legacySharedKeyMark(f.object, "scope", {
			...pending,
			subject: "console:user",
		} as LegacySharedKeyMarker)
	);
});
test("marker survives refresh/read/remount and contains only bounded nonsecret key ID and operation", () => {
	const f = storage();
	legacySharedKeyMark(f.object, "scope", pending);
	assert.equal(
		f.values.get("scope"),
		'{"v":1,"keyId":"shared-1","operation":"update"}'
	);
	assert.deepEqual(legacySharedKeyReadMarker(f.object, "scope"), pending);
	assert.deepEqual(legacySharedKeyReadMarker(f.object, "scope"), pending);
	assert.throws(() => legacySharedKeyMark(f.object, "scope", pending));
	assert.throws(() =>
		legacySharedKeyMark(storage().object, "scope", {
			...pending,
			reason: "private reason",
		} as LegacySharedKeyMarker)
	);
});
test("storage denial, ignored writes, malformed markers and failed removal all fail closed", () => {
	const denied: LegacySharedKeyStorage = {
		getItem() {
			throw Error("denied");
		},
		setItem() {
			throw Error("denied");
		},
		removeItem() {
			throw Error("denied");
		},
	};
	assert.throws(() => legacySharedKeyMark(denied, "scope", pending));
	const ignored: LegacySharedKeyStorage = {
		getItem: () => null,
		setItem() {},
		removeItem() {},
	};
	assert.throws(() => legacySharedKeyMark(ignored, "scope", pending));
	const f = storage();
	f.values.set("scope", "{bad");
	assert.throws(() => legacySharedKeyReadMarker(f.object, "scope"));
	f.values.set("scope", JSON.stringify(pending));
	assert.throws(() =>
		legacySharedKeyClearMarker(
			{ ...f.object, removeItem() {} },
			"scope",
			pending
		)
	);
	assert.deepEqual(legacySharedKeyReadMarker(f.object, "scope"), pending);
});
test("clearing requires the matching marker and checked removal; unrelated pending operations cannot be cleared", () => {
	const f = storage();
	legacySharedKeyMark(f.object, "scope", pending);
	assert.throws(() =>
		legacySharedKeyClearMarker(f.object, "scope", {
			...pending,
			keyId: "other",
		})
	);
	legacySharedKeyClearMarker(f.object, "scope", pending);
	assert.equal(legacySharedKeyReadMarker(f.object, "scope"), null);
});
test("edit submits an explicit reason and reviewed revision with bounded integer priority/weight", () => {
	assert.deepEqual(
		legacySharedKeyWriteBody(detail, "update", " operator review ", "-4", "20"),
		{
			expected_revision: revision,
			reason: "operator review",
			sellerPriority: -4,
			weight: 20,
		}
	);
	for (const [priority, weight] of [
		["0", "10"],
		["1.5", "20"],
		["2147483648", "20"],
		["1", "101"],
		["1", "0"],
		["1e2", "20"],
		["", "20"],
	])
		assert.throws(() =>
			legacySharedKeyWriteBody(detail, "update", "reason", priority, weight)
		);
	for (const reason of ["", " ", "bad\nreason", "x".repeat(601)])
		assert.throws(() =>
			legacySharedKeyWriteBody(detail, "disable", reason, "", "")
		);
	assert.throws(() =>
		legacySharedKeyWriteBody(
			{ ...detail, capabilities: { ...detail.capabilities, can_write: false } },
			"disable",
			"reason",
			"",
			""
		)
	);
});
test("disable/restore/delete never send active; only disabled may restore to paused", () => {
	assert.equal(
		legacySharedKeyWriteBody(detail, "disable", "reason", "", "").status,
		"disabled"
	);
	assert.equal(
		legacySharedKeyWriteBody(
			{ ...detail, status: "disabled" },
			"restore",
			"reason",
			"",
			""
		).status,
		"paused"
	);
	for (const status of ["active", "paused", "invalid", "validating"] as const)
		assert.throws(() =>
			legacySharedKeyWriteBody(
				{ ...detail, status },
				"restore",
				"reason",
				"",
				""
			)
		);
	assert.deepEqual(
		legacySharedKeyWriteBody(detail, "delete", "reason", "", ""),
		{
			expected_revision: revision,
			reason: "reason",
		}
	);
});
test("only matching authoritative mutation success or definite rejection clears automatically; uncertain results remain unknown", () => {
	assert.equal(
		legacySharedKeyWriteResult(
			200,
			{ success: true, data: { id: detail.id, outcome: "applied", auditId } },
			pending
		),
		"applied"
	);
	assert.equal(
		legacySharedKeyWriteResult(
			200,
			{
				success: true,
				data: { id: detail.id, outcome: "unchanged", auditId: null },
			},
			pending
		),
		"unchanged"
	);
	for (const status of [400, 401, 403, 404, 409, 428])
		assert.equal(
			legacySharedKeyWriteResult(status, { success: false }, pending),
			"rejected"
		);
	for (const [status, value] of [
		[500, { success: false }],
		[503, { success: false }],
		[200, null],
		[
			200,
			{ success: true, data: { id: "other", outcome: "applied", auditId } },
		],
		[
			200,
			{
				success: true,
				data: { id: detail.id, outcome: "applied", auditId: null },
			},
		],
		[409, "<html>"],
	] as const)
		assert.equal(legacySharedKeyWriteResult(status, value, pending), "unknown");
	assert.equal(
		legacySharedKeyWriteResult(
			200,
			{ success: true, data: { id: detail.id, deleted: true, auditId } },
			{ ...pending, operation: "delete" }
		),
		"applied"
	);
});
test("recovery needs readable audit, explicit acknowledgment and exact current ID; only delete allows absent detail", () => {
	assert.equal(legacySharedKeyCanRecover(pending, detail, true, true), true);
	assert.equal(legacySharedKeyCanRecover(pending, detail, false, true), false);
	assert.equal(legacySharedKeyCanRecover(pending, detail, true, false), false);
	assert.equal(legacySharedKeyCanRecover(pending, null, true, true), false);
	assert.equal(
		legacySharedKeyCanRecover(
			{ ...pending, operation: "delete" },
			null,
			true,
			true
		),
		true
	);
	assert.equal(
		legacySharedKeyCanRecover(pending, { ...detail, id: "other" }, true, true),
		false
	);
});
test("recovery audit uses a strict safe summary and never retains reason/actor/revision/raw material", () => {
	const result = legacySharedKeyAudit(
		{
			entries: [{ ...audit, apiKey: "private-secret" }],
			next_cursor: null,
			page_size: 20,
		},
		detail.id
	);
	assert.equal(result.entries.length, 1);
	assert.equal(result.entries[0].action, "disabled");
	for (const key of [
		"reason",
		"actorId",
		"beforeRevision",
		"afterRevision",
		"apiKey",
	])
		assert.ok(!Object.hasOwn(result.entries[0], key));
	assert.ok(!JSON.stringify(result).includes("private-secret"));
	assert.ok(!JSON.stringify(result).includes("Reason that"));
	assert.throws(() =>
		legacySharedKeyAudit(
			{
				entries: [{ ...audit, keyId: "other" }],
				next_cursor: null,
				page_size: 20,
			},
			detail.id
		)
	);
	assert.throws(() =>
		legacySharedKeyAudit(
			{
				entries: [{ ...audit, after: { ...audit.after, validated: false } }],
				next_cursor: null,
				page_size: 20,
			},
			detail.id
		)
	);
});
test("audit pagination binds cursor to key and final row, preserves microseconds, and rejects duplicate/stale ordering", () => {
	const entries = Array.from({ length: 20 }, (_, index) => ({
		...audit,
		id: `00000000-0000-4000-8000-${(20 - index).toString().padStart(12, "0")}`,
	}));
	const next = cursor(detail.id, entries.at(-1)!.id);
	assert.equal(
		legacySharedKeyAudit(
			{ entries, next_cursor: next, page_size: 20 },
			detail.id
		).nextCursor,
		next
	);
	assert.throws(() =>
		legacySharedKeyAudit(
			{
				entries,
				next_cursor: cursor("other", entries.at(-1)!.id),
				page_size: 20,
			},
			detail.id
		)
	);
	assert.throws(() =>
		legacySharedKeyAudit(
			{ entries, next_cursor: cursor(detail.id, entries[0].id), page_size: 20 },
			detail.id
		)
	);
	assert.throws(() =>
		legacySharedKeyAudit(
			{ entries: [audit, audit], next_cursor: null, page_size: 20 },
			detail.id
		)
	);
	assert.throws(() =>
		legacySharedKeyAudit(
			{ entries: [audit], next_cursor: null, page_size: 20 },
			detail.id,
			cursor(detail.id, auditId, "2026-09-30T00:00:00.000122Z")
		)
	);
});
test("four locale namespaces have identical nested keys and ICU placeholders; quotes do not claim dollars", () => {
	const values = ["en", "zh", "ja", "ko"].map(
		(locale) =>
			JSON.parse(
				readFileSync(
					new URL(`../../../messages/${locale}.json`, import.meta.url),
					"utf8"
				)
			).sharedKeysPage as Record<string, unknown>
	);
	function leaves(
		value: Record<string, unknown>,
		prefix = ""
	): Record<string, string> {
		return Object.fromEntries(
			Object.entries(value).flatMap(([key, item]) =>
				typeof item === "string"
					? [[prefix + key, item]]
					: Object.entries(
							leaves(item as Record<string, unknown>, prefix + key + ".")
					  )
			)
		);
	}
	const baseline = leaves(values[0]);
	for (const value of values) {
		const actual = leaves(value);
		assert.deepEqual(Object.keys(actual).sort(), Object.keys(baseline).sort());
		for (const [key, copy] of Object.entries(actual))
			assert.deepEqual(
				(copy.match(/\{[a-zA-Z]+\}/gu) ?? []).sort(),
				(baseline[key].match(/\{[a-zA-Z]+\}/gu) ?? []).sort(),
				key
			);
		assert.ok(!(value.pricing as string).includes("$"));
		assert.ok(!(value.priceCell as string).includes("$"));
	}
});
