import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type {
	GatewayRepositories,
	SystemConfigAuditWrite,
} from "@octafuse/core";
import type { AdminEnv } from "@/lib/admin-env";
import { getAdminAuthorizationDecision } from "@/lib/admin-permissions";
import {
	hasAdminPermission,
	type AdminPermission,
	type AdminPrincipal,
} from "@/lib/admin-principal";
import { protectAdminConfigResponse } from "@/lib/admin-config-cache";
import { adminConfigRoutes } from "@/lib/routes/admin/config";
import { parseConfigRevisionPrecondition } from "@/lib/routes/admin/config-revision";

const apiKey = (permissions: AdminPermission[]): AdminPrincipal => ({
	type: "api_key",
	id: "admin_key:fixture",
	keyId: "fixture",
	permissions,
});
const url =
	"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=private-token-123";
const otherUrl =
	"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=other-private-token";
const firstRevision = "11111111-1111-4111-8111-111111111111";
const secondRevision = "22222222-2222-4222-8222-222222222222";
const thirdRevision = "33333333-3333-4333-8333-333333333333";

function fixture(
	options: {
		principal?: AdminPrincipal | null;
		initial?: Record<string, string>;
		failWrite?: boolean;
		failRead?: boolean;
		requireRevision?: string;
	} = {}
) {
	const values = new Map(Object.entries(options.initial ?? {}));
	const revisions = new Map([...values.keys()].map((key) => [key, "legacy"]));
	const reads: string[] = [];
	const writes: Array<{ key: string; value: string }> = [];
	const auditWrites: SystemConfigAuditWrite[] = [];
	const repositories = {
		systemConfig: {
			async getConfigSnapshot(key: string) {
				reads.push(key);
				if (options.failRead) throw new Error(`private storage error: ${url}`);
				return {
					value: values.get(key) ?? null,
					revision: revisions.get(key) ?? null,
				};
			},
			async getConfig(key: string) {
				reads.push(key);
				if (options.failRead) throw new Error(`private storage error: ${url}`);
				return values.get(key) ?? null;
			},
			async upsertSystemConfigValueWithAudit(input: SystemConfigAuditWrite) {
				if (options.failWrite) throw new Error(`private storage error: ${url}`);
				const revision =
					[firstRevision, secondRevision, thirdRevision][writes.length] ??
					crypto.randomUUID();
				auditWrites.push(input);
				writes.push({ key: input.key, value: input.value });
				values.set(input.key, input.value);
				revisions.set(input.key, revision);
			},
			async upsertSystemConfigValueWithAuditIfRevision(
				input: SystemConfigAuditWrite & { expectedRevision: string | null }
			) {
				if (options.failWrite) throw new Error(`private storage error: ${url}`);
				if ((revisions.get(input.key) ?? null) !== input.expectedRevision) {
					return { committed: false, revision: null };
				}
				const revision =
					[firstRevision, secondRevision, thirdRevision][writes.length] ??
					crypto.randomUUID();
				auditWrites.push(input);
				writes.push({ key: input.key, value: input.value });
				values.set(input.key, input.value);
				revisions.set(input.key, revision);
				return { committed: true, revision };
			},
			listSystemConfigRows: () =>
				assert.fail("Managed endpoints must never enumerate config rows"),
		},
	} as unknown as GatewayRepositories;
	const principal =
		options.principal === undefined
			? apiKey(["config.read", "config.write", "config.secrets.read"])
			: options.principal;
	const app = new Hono<AdminEnv>();
	app.use("*", async (c, next) => {
		c.set("repositories", repositories);
		if (!principal)
			return c.json({ success: false, message: "Unauthorized" }, 401);
		const decision = getAdminAuthorizationDecision(c.req.method, c.req.path);
		if (
			decision.kind !== "permission" ||
			!hasAdminPermission(principal, decision.permission)
		) {
			return c.json({ success: false, message: "Forbidden" }, 403);
		}
		c.set("principal", principal);
		await next();
	});
	app.route("/admin/config", adminConfigRoutes);
	const request = async (path: string, init?: RequestInit) => {
		const result = await app.request(path, init, {
			CINATOKEN_ADMIN_CONFIG_REQUIRE_REVISION: options.requireRevision,
		});
		return protectAdminConfigResponse(
			new Request(`https://test.example/api${path}`),
			result
		);
	};
	return { request, reads, writes, auditWrites, values, revisions };
}

const jsonPut = (value: unknown, revision: string | null = null) => ({
	method: "PUT",
	headers: {
		"content-type": "application/json",
		...(revision === null
			? { "If-None-Match": "*" }
			: { "If-Match": `"${revision}"` }),
	},
	body: JSON.stringify({ value }),
});

test("outer cache policy covers new config routes even on early errors without covering unknown paths", () => {
	for (const path of [
		"/api/admin/config/billing-currency",
		"/api/admin/config/route-strategy/",
		"/api/admin/config/webhooks/wecom",
		"/api/admin/config/webhooks/feishu/",
		"/api/admin/config/webhooks/wecom/reveal",
		"/api/admin/config/webhooks/feishu/verify/",
	]) {
		for (const status of [401, 403, 500]) {
			const response = protectAdminConfigResponse(
				new Request(`https://test.example${path}`),
				Response.json({ success: false }, { status })
			);
			assert.equal(
				response.headers.get("cache-control"),
				"private, no-store",
				path
			);
		}
	}
	for (const path of [
		"/api/admin/configuration",
		"/api/admin/configure/webhooks/wecom",
		"/api/admin/business-timezone-extra",
	]) {
		const response = protectAdminConfigResponse(
			new Request(`https://test.example${path}`),
			Response.json({ success: false }, { status: 403 })
		);
		assert.equal(response.headers.get("cache-control"), null, path);
	}
});

test("revision preconditions accept only quoted opaque revisions or missing-row star", () => {
	assert.deepEqual(parseConfigRevisionPrecondition({}), { kind: "absent" });
	assert.deepEqual(parseConfigRevisionPrecondition({ ifNoneMatch: "*" }), {
		kind: "missing-row",
	});
	assert.deepEqual(parseConfigRevisionPrecondition({ ifMatch: '"legacy"' }), {
		kind: "match",
		revision: "legacy",
	});
	assert.deepEqual(
		parseConfigRevisionPrecondition({ ifMatch: `"${firstRevision}"` }),
		{ kind: "match", revision: firstRevision }
	);
	for (const headers of [
		{ ifMatch: "*" },
		{ ifMatch: "legacy" },
		{ ifMatch: '"secret"' },
		{ ifNoneMatch: '"legacy"' },
		{ ifMatch: '"legacy"', ifNoneMatch: "*" },
	])
		assert.deepEqual(parseConfigRevisionPrecondition(headers), {
			kind: "invalid",
		});
});

test("managed routes enforce exact methods and independent write/reveal permissions", async () => {
	for (const [method, path, permission] of [
		["PUT", "/admin/config/billing-currency", "config.write"],
		["PUT", "/admin/config/route-strategy", "config.write"],
		["PUT", "/admin/config/webhooks/wecom", "config.write"],
		["DELETE", "/admin/config/webhooks/feishu", "config.write"],
		["GET", "/admin/config/webhooks/wecom/reveal", "config.secrets.read"],
		["POST", "/admin/config/webhooks/feishu/verify", "config.secrets.read"],
	] as const) {
		assert.deepEqual(getAdminAuthorizationDecision(method, path), {
			kind: "permission",
			permission,
		});
	}
	for (const [method, path] of [
		["GET", "/admin/config/billing-currency"],
		["POST", "/admin/config/webhooks/wecom"],
		["GET", "/admin/config/webhooks/wecom/verify"],
		["POST", "/admin/config/webhooks/wecom/reveal"],
		["PUT", "/admin/config/webhooks/slack"],
		["GET", "/admin/config/webhooks/wecom/anything"],
	] as const) {
		assert.deepEqual(getAdminAuthorizationDecision(method, path), {
			kind: "deny",
		});
	}
	const reader = fixture({ principal: apiKey(["config.read"]) });
	assert.equal(
		(await reader.request("/admin/config/billing-currency", jsonPut("USD")))
			.status,
		403
	);
	assert.equal(
		(await reader.request("/admin/config/webhooks/wecom/reveal")).status,
		403
	);
	assert.deepEqual(reader.writes, []);
	assert.deepEqual(reader.reads, []);
	const secretOnly = fixture({ principal: apiKey(["config.secrets.read"]) });
	const revealDenied = await secretOnly.request(
		"/admin/config/webhooks/wecom/reveal"
	);
	assert.equal(revealDenied.status, 403);
	assert.equal(revealDenied.headers.get("cache-control"), "private, no-store");
	assert.deepEqual(secretOnly.reads, []);
	const writer = fixture({ principal: apiKey(["config.write"]) });
	const writerRevealDenied = await writer.request(
		"/admin/config/webhooks/wecom/reveal"
	);
	assert.equal(writerRevealDenied.status, 403);
	assert.deepEqual(writer.reads, []);
	const anonymous = fixture({ principal: null });
	const anonymousResponse = await anonymous.request(
		"/admin/config/webhooks/wecom/reveal"
	);
	assert.equal(anonymousResponse.status, 401);
	assert.equal(
		anonymousResponse.headers.get("cache-control"),
		"private, no-store"
	);
});

test("legacy generic and fixed-key writes require and carry the actual Admin principal into audited storage", async () => {
	const keyPrincipal = apiKey(["config.write"]);
	const keyFixture = fixture({ principal: keyPrincipal });
	const generic = await keyFixture.request("/admin/config", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			key: "CUSTOM_SETTING",
			value: "private legacy value",
		}),
	});
	assert.equal(generic.status, 200);
	assert.equal(keyFixture.revisions.get("CUSTOM_SETTING"), firstRevision);
	assert.equal(
		(await keyFixture.request("/admin/config/billing-currency", jsonPut("CNY")))
			.status,
		200
	);
	assert.deepEqual(
		keyFixture.auditWrites.map(({ key, actorKind, actorId }) => ({
			key,
			actorKind,
			actorId,
		})),
		[
			{
				key: "CUSTOM_SETTING",
				actorKind: "admin_key",
				actorId: keyPrincipal.id,
			},
			{
				key: "BILLING_CURRENCY",
				actorKind: "admin_key",
				actorId: keyPrincipal.id,
			},
		]
	);
	for (const write of keyFixture.auditWrites) {
		assert.match(write.auditId, /^[0-9a-f-]{36}$/u);
		assert.ok(Number.isFinite(Date.parse(write.nowIso)));
	}
	const consolePrincipal: AdminPrincipal = {
		type: "console",
		id: "console:operator",
		username: "operator",
	};
	const consoleFixture = fixture({ principal: consolePrincipal });
	assert.equal(
		(await consoleFixture.request("/admin/config/webhooks/wecom", jsonPut(url)))
			.status,
		200
	);
	assert.deepEqual(
		consoleFixture.auditWrites.map(({ actorKind, actorId }) => ({
			actorKind,
			actorId,
		})),
		[{ actorKind: "console", actorId: consolePrincipal.id }]
	);
});

test("billing currency and route strategy write fixed keys, normalize and verify exact stored values", async () => {
	const f = fixture();
	const currency = await f.request(
		"/admin/config/billing-currency",
		jsonPut(" cny ")
	);
	assert.equal(currency.status, 200);
	assert.equal(currency.headers.get("cache-control"), "private, no-store");
	assert.deepEqual(await currency.json(), {
		success: true,
		data: {
			billingCurrency: {
				value: "CNY",
				source: "configured",
				revision: firstRevision,
			},
		},
	});
	const strategy = await f.request(
		"/admin/config/route-strategy",
		jsonPut(" WEIGHTED_RANDOM ")
	);
	assert.equal(strategy.status, 200);
	assert.deepEqual(await strategy.json(), {
		success: true,
		data: {
			routeStrategy: {
				value: "weighted_random",
				source: "configured",
				revision: secondRevision,
			},
		},
	});
	assert.deepEqual(f.writes, [
		{ key: "BILLING_CURRENCY", value: "CNY" },
		{ key: "ROUTE_STRATEGY", value: "weighted_random" },
	]);
	assert.deepEqual(f.reads, []);
	for (const [path, value] of [
		["/admin/config/billing-currency", "EUR"],
		["/admin/config/billing-currency", null],
		["/admin/config/route-strategy", "unknown"],
		["/admin/config/route-strategy", 1],
	] as const) {
		const response = await f.request(path, jsonPut(value));
		assert.equal(response.status, 400);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
	}
	const extra = await f.request("/admin/config/billing-currency", {
		method: "PUT",
		headers: {
			"content-type": "application/json",
			"If-Match": `"${firstRevision}"`,
		},
		body: JSON.stringify({ value: "USD", key: "ALERT_WEBHOOK_WECOM_URL" }),
	});
	assert.equal(extra.status, 400);
	assert.equal(f.writes.length, 2);
});

test("each webhook replaces or clears independently and ordinary write responses never disclose URLs", async () => {
	const f = fixture({
		initial: {
			ALERT_WEBHOOK_WECOM_URL: otherUrl,
			ALERT_WEBHOOK_FEISHU_URL: otherUrl,
		},
	});
	const replace = await f.request(
		"/admin/config/webhooks/wecom",
		jsonPut(` ${url} `, "legacy")
	);
	assert.equal(replace.status, 200);
	assert.equal(replace.headers.get("cache-control"), "private, no-store");
	const replaceText = await replace.text();
	assert.deepEqual(JSON.parse(replaceText), {
		success: true,
		data: { webhook: { configured: true, revision: firstRevision } },
	});
	assert.equal(replaceText.includes(url), false);
	assert.equal(f.values.get("ALERT_WEBHOOK_WECOM_URL"), url);
	assert.equal(f.values.get("ALERT_WEBHOOK_FEISHU_URL"), otherUrl);
	const clear = await f.request("/admin/config/webhooks/wecom", {
		method: "DELETE",
		headers: { "If-Match": `"${firstRevision}"` },
	});
	assert.equal(clear.status, 200);
	assert.deepEqual(await clear.json(), {
		success: true,
		data: { webhook: { configured: false, revision: secondRevision } },
	});
	assert.equal(f.values.get("ALERT_WEBHOOK_WECOM_URL"), "");
	assert.equal(f.values.get("ALERT_WEBHOOK_FEISHU_URL"), otherUrl);
	const feishuUrl =
		"https://open.feishu.cn/open-apis/bot/v2/hook/private-feishu-token";
	const feishu = await f.request(
		"/admin/config/webhooks/feishu",
		jsonPut(feishuUrl, "legacy")
	);
	assert.equal(feishu.status, 200);
	assert.deepEqual(await feishu.json(), {
		success: true,
		data: { webhook: { configured: true, revision: thirdRevision } },
	});
	assert.equal(f.values.get("ALERT_WEBHOOK_FEISHU_URL"), feishuUrl);
	assert.deepEqual(f.writes, [
		{ key: "ALERT_WEBHOOK_WECOM_URL", value: url },
		{ key: "ALERT_WEBHOOK_WECOM_URL", value: "" },
		{ key: "ALERT_WEBHOOK_FEISHU_URL", value: feishuUrl },
	]);
});

test("webhook replacement rejects insecure, malformed and oversized inputs before storage", async () => {
	const f = fixture();
	for (const candidate of [
		"",
		"  ",
		"http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x",
		"https://u:p@qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x",
		"https://qyapi.weixin.qq.com:8443/cgi-bin/webhook/send?key=x",
		"https://127.0.0.1/cgi-bin/webhook/send?key=x",
		"https://open.feishu.cn/open-apis/bot/v2/hook/x",
		"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x#fragment",
		"https://qyapi.weixin.qq.com/ro\nbot",
		"https://qyapi.weixin.qq.com/robot\u0085",
		"https://qyapi.weixin.qq.com/" + "a".repeat(2050),
		"not a URL",
		null,
	]) {
		const response = await f.request(
			"/admin/config/webhooks/wecom",
			jsonPut(candidate)
		);
		assert.equal(response.status, 400);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		if (candidate)
			assert.equal((await response.text()).includes(String(candidate)), false);
	}
	assert.deepEqual(f.writes, []);
});

test("explicit reveal and read-only verify require both permissions and never echo candidate on verify", async () => {
	const f = fixture({ initial: { ALERT_WEBHOOK_WECOM_URL: url } });
	const reveal = await f.request("/admin/config/webhooks/wecom/reveal");
	assert.equal(reveal.status, 200);
	assert.equal(reveal.headers.get("cache-control"), "private, no-store");
	assert.deepEqual(await reveal.json(), {
		success: true,
		data: { channel: "wecom", value: url },
	});
	const verify = await f.request("/admin/config/webhooks/wecom/verify", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: url }),
	});
	assert.equal(verify.status, 200);
	const verifiedText = await verify.text();
	assert.deepEqual(JSON.parse(verifiedText), {
		success: true,
		data: { channel: "wecom", matched: true, configured: true },
	});
	assert.equal(verifiedText.includes(url), false);
	const mismatch = await f.request("/admin/config/webhooks/wecom/verify", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: otherUrl }),
	});
	assert.deepEqual(await mismatch.json(), {
		success: true,
		data: { channel: "wecom", matched: false, configured: true },
	});
	const invalidCandidate = await f.request(
		"/admin/config/webhooks/wecom/verify",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ value: "https://127.0.0.1/private" }),
		}
	);
	assert.equal(invalidCandidate.status, 400);
	assert.equal((await invalidCandidate.text()).includes("127.0.0.1"), false);
	assert.deepEqual(f.writes, []);
	const writer = fixture({
		principal: apiKey(["config.write"]),
		initial: { ALERT_WEBHOOK_WECOM_URL: url },
	});
	assert.equal(
		(
			await writer.request("/admin/config/webhooks/wecom/verify", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ value: url }),
			})
		).status,
		403
	);
	assert.deepEqual(writer.reads, []);
});

test("managed writes require a revision and reject stale revisions without an audited write", async () => {
	const f = fixture({ initial: { ALERT_WEBHOOK_WECOM_URL: otherUrl } });
	const missing = await f.request("/admin/config/webhooks/wecom", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: url }),
	});
	assert.equal(missing.status, 428);
	assert.equal(
		((await missing.json()) as { code: string }).code,
		"config_precondition_required"
	);
	const malformed = await f.request("/admin/config/webhooks/wecom", {
		method: "PUT",
		headers: { "content-type": "application/json", "If-Match": url },
		body: JSON.stringify({ value: url }),
	});
	assert.equal(malformed.status, 400);
	assert.equal(
		((await malformed.json()) as { code: string }).code,
		"config_precondition_invalid"
	);
	const first = await f.request(
		"/admin/config/webhooks/wecom",
		jsonPut(url, "legacy")
	);
	assert.equal(first.status, 200);
	const stale = await f.request(
		"/admin/config/webhooks/wecom",
		jsonPut(otherUrl, "legacy")
	);
	assert.equal(stale.status, 412);
	assert.equal(stale.headers.get("cache-control"), "private, no-store");
	const text = await stale.text();
	assert.equal(JSON.parse(text).code, "config_revision_conflict");
	assert.equal(text.includes(url), false);
	assert.equal(text.includes(otherUrl), false);
	assert.deepEqual(f.writes, [{ key: "ALERT_WEBHOOK_WECOM_URL", value: url }]);
	assert.equal(f.auditWrites.length, 1);
	assert.equal(f.revisions.get("ALERT_WEBHOOK_WECOM_URL"), firstRevision);
});

test("generic endpoint supports conditional Web writes while legacy writes keep updating revisions", async () => {
	const f = fixture();
	const body = JSON.stringify({
		key: "BUSINESS_TIMEZONE",
		value: "Asia/Singapore",
	});
	const first = await f.request("/admin/config", {
		method: "PUT",
		headers: { "content-type": "application/json", "If-None-Match": "*" },
		body,
	});
	assert.equal(first.status, 200);
	assert.equal(
		((await first.json()) as { revision: string }).revision,
		firstRevision
	);
	const stale = await f.request("/admin/config", {
		method: "PUT",
		headers: { "content-type": "application/json", "If-None-Match": "*" },
		body,
	});
	assert.equal(stale.status, 412);
	const legacy = await f.request("/admin/config", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body,
	});
	assert.equal(legacy.status, 200);
	assert.equal(f.auditWrites.length, 2);
	assert.equal(f.revisions.get("BUSINESS_TIMEZONE"), secondRevision);
});

test("enabled legacy guard rejects unconditional writes to all five Web-managed keys without an audit", async () => {
	const f = fixture({ requireRevision: "true" });
	for (const [key, value] of [
		["BUSINESS_TIMEZONE", "Asia/Singapore"],
		["BILLING_CURRENCY", "CNY"],
		["ROUTE_STRATEGY", "weighted_random"],
		["ALERT_WEBHOOK_WECOM_URL", url],
		[
			"ALERT_WEBHOOK_FEISHU_URL",
			"https://open.feishu.cn/open-apis/bot/v2/hook/private-token",
		],
	] as const) {
		const response = await f.request("/admin/config", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key: ` ${key} `, value }),
		});
		assert.equal(response.status, 428, key);
		assert.equal(
			response.headers.get("cache-control"),
			"private, no-store",
			key
		);
		assert.equal(
			((await response.json()) as { code: string }).code,
			"config_precondition_required",
			key
		);
	}
	assert.deepEqual(f.writes, []);
	assert.deepEqual(f.auditWrites, []);
	assert.deepEqual(f.reads, []);
	const other = await f.request("/admin/config", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: "CUSTOM_SETTING", value: "still-compatible" }),
	});
	assert.equal(other.status, 200);
	assert.deepEqual(f.writes, [
		{ key: "CUSTOM_SETTING", value: "still-compatible" },
	]);
});

test("enabled legacy guard preserves conditional CAS and exact opt-in", async () => {
	const f = fixture({ requireRevision: "true" });
	const body = JSON.stringify({
		key: "BUSINESS_TIMEZONE",
		value: "Asia/Singapore",
	});
	const first = await f.request("/admin/config", {
		method: "PUT",
		headers: { "content-type": "application/json", "If-None-Match": "*" },
		body,
	});
	assert.equal(first.status, 200);
	assert.equal(
		((await first.json()) as { revision: string }).revision,
		firstRevision
	);
	const stale = await f.request("/admin/config", {
		method: "PUT",
		headers: { "content-type": "application/json", "If-None-Match": "*" },
		body,
	});
	assert.equal(stale.status, 412);
	const second = await f.request("/admin/config", {
		method: "PUT",
		headers: {
			"content-type": "application/json",
			"If-Match": `"${firstRevision}"`,
		},
		body,
	});
	assert.equal(second.status, 200);
	assert.equal(
		((await second.json()) as { revision: string }).revision,
		secondRevision
	);
	assert.equal(f.auditWrites.length, 2);
	for (const requireRevision of [undefined, "false", "TRUE", "1"]) {
		const legacy = fixture({ requireRevision });
		assert.equal(
			(
				await legacy.request("/admin/config", {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body,
				})
			).status,
			200,
			String(requireRevision)
		);
		assert.equal(legacy.auditWrites.length, 1);
	}
});

test("storage errors never claim success or leak webhook URLs", async () => {
	const f = fixture({ failWrite: true });
	const response = await f.request(
		"/admin/config/webhooks/wecom",
		jsonPut(url)
	);
	assert.equal(response.status, 500);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	const body = await response.text();
	assert.equal(body.includes(url), false);
	assert.equal(body.includes("private storage error"), false);
	assert.deepEqual(f.writes, []);
});
