import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOL_CONFIG_BOUNDS, ToolConfigError } from "./tool-config-contract";
import {
	toolConfigVersion,
	parseToolConfigVersion,
	TOOL_CONFIG_KEYS,
	toolConfigJson,
	toolConfigMoney,
	toolConfigAuditQuery,
	toolConfigCursor,
	toolConfigInstant,
	toolConfigOp,
} from "./tool-config-input";
import {
	redactToolConfigText,
	toolConfigSnapshotSecrets,
} from "./tool-config-dto";

const vector = TOOL_CONFIG_KEYS["web-search"].map((key) => ({
	key,
	revision: null,
}));
test("complete canonical version contains only fixed key/revision metadata and binds the family", () => {
	const version = toolConfigVersion("web-search", vector);
	assert.deepEqual(parseToolConfigVersion("web-search", version), vector);
	assert.ok(version.length <= 2048);
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	for (const input of [
		version + "=",
		encode({ family: "web-search", v: 1, readSet: vector }),
		encode({ v: 1, family: "web-search", readSet: vector.slice(1) }),
		encode({ v: 1, family: "web-search", readSet: [...vector].reverse() }),
		encode({
			v: 1,
			family: "web-search",
			readSet: vector.map((row) => ({ ...row, value: "secret" })),
		}),
		encode({
			v: 1,
			family: "web-search",
			readSet: vector.map((row) => ({ ...row, revision: "raw-secret" })),
		}),
	])
		assert.throws(
			() => parseToolConfigVersion("web-search", input),
			ToolConfigError
		);
	assert.throws(
		() => parseToolConfigVersion("web-fetch", version),
		ToolConfigError
	);
});
test("JSON duplicate/prototype/depth/byte defenses preserve escaped-member distinctions", () => {
	for (const raw of [
		'{"x":1,"x":2}',
		'{"x":1,"\\u0078":2}',
		'{"__proto__":{}}',
		'{"value":{"constructor":1}}',
		'{"x":' + "[".repeat(16) + "0" + "]".repeat(16) + "}",
		'{"x":"' + "a".repeat(TOOL_CONFIG_BOUNDS.bodyBytes) + '"}',
	])
		assert.throws(() => toolConfigJson(raw), ToolConfigError);
	assert.deepEqual(toolConfigJson('{"x":{"y":"value"}}'), {
		x: { y: "value" },
	});
});
test("scaled-money rejects overflow/nonfinite/negative/tiny positive sources rather than silently becoming zero", () => {
	for (const value of [
		NaN,
		Infinity,
		-1,
		1e308,
		Number.MAX_SAFE_INTEGER,
		1e-10,
		{},
		"1",
	])
		assert.throws(() => toolConfigMoney(value), ToolConfigError);
	assert.equal(toolConfigMoney(0), 0);
	assert.equal(toolConfigMoney(0.000001), 0.000001);
	assert.equal(toolConfigMoney(1.1234567), 1.123457);
	assert.equal(toolConfigMoney("0.001", true), 0.001);
});
test("audit cursor preserves microseconds, canonical encoding and exact family/ID binding", () => {
	const value = {
		createdAt: "2026-10-01T01:01:01.123456Z",
		id: "00000000-0000-0000-0000-000000000001",
	};
	const cursor = toolConfigCursor("web-search", value);
	assert.deepEqual(
		toolConfigAuditQuery("web-search", "https://test/audit?before=" + cursor),
		{
			limit: 20,
			before: value,
		}
	);
	assert.throws(
		() =>
			toolConfigAuditQuery("web-fetch", "https://test/audit?before=" + cursor),
		ToolConfigError
	);
	for (const time of [
		"2026-02-30T01:01:01.123456Z",
		"2026-10-01T01:01:01.123Z",
		"2026-10-01T01:01:01.123456+00:00",
	])
		assert.throws(() => toolConfigInstant(time), ToolConfigError);
	for (const query of [
		"?limit=0",
		"?limit=01",
		"?limit=101",
		"?before=",
		"?limit=1&limit=2",
		"?offset=1",
	])
		assert.throws(
			() => toolConfigAuditQuery("web-search", "https://test/audit" + query),
			ToolConfigError
		);
});
test("keep/set/clear retain exact semantics and reject masked/control/oversize/unknown fields", () => {
	assert.deepEqual(toolConfigOp({ op: "keep" }, 4096), { op: "keep" });
	assert.deepEqual(toolConfigOp({ op: "clear" }, 4096), { op: "clear" });
	assert.deepEqual(toolConfigOp({ op: "set", value: " actual " }, 4096), {
		op: "set",
		value: "actual",
	});
	for (const value of [
		{ op: "keep", value: "secret" },
		{ op: "clear", value: "" },
		{ op: "set", value: "••••••••" },
		{ op: "set", value: "bad\n" },
		{ op: "set", value: "x".repeat(4097) },
		{ op: "unknown" },
		{ op: "set", value: "actual", actor: "forged" },
	])
		assert.throws(() => toolConfigOp(value, 4096), ToolConfigError);
});
test("redaction recognizes all duplicate/escaped known credentials before code-point truncation", () => {
	const rows = [
		{
			key: "WEB_SEARCH_CATALOG",
			value:
				'{"tavily":{"apiKey":"first-secret","api\\u004bey":"second-secret"}}',
			revision: "legacy",
		},
		{
			key: "AI_DETECTION_CATALOG",
			value:
				'{"tencent_tms":{"secretId":"third-secret","secretKey":"fourth-secret","email":"fifth-secret"}}',
			revision: "legacy",
		},
		{ key: "WEB_FETCH_API_KEY", value: " sixth-secret ", revision: "legacy" },
	];
	const secrets = toolConfigSnapshotSecrets(rows);
	for (const value of [
		"first-secret",
		"second-secret",
		"third-secret",
		"fourth-secret",
		"fifth-secret",
		"sixth-secret",
	])
		assert.ok(secrets.includes(value));
	assert.equal(
		redactToolConfigText(
			"first-secret/second-secret/" + "😀".repeat(10),
			secrets,
			24
		),
		"[redacted]/[redacted]/😀😀"
	);
	assert.equal(
		redactToolConfigText("😀".repeat(601), [], 600),
		"😀".repeat(600)
	);
	assert.equal(
		redactToolConfigText("a".repeat(599) + "😀next", [], 600),
		"a".repeat(599) + "😀"
	);
	assert.equal(
		redactToolConfigText("before " + "x".repeat(5000), ["x".repeat(5000)], 600),
		"before [redacted]"
	);
});
