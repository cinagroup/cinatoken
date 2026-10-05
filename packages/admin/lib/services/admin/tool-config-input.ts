import type { ConfigRevisionVector } from "@octafuse/core";
import {
	TOOL_CONFIG_BOUNDS,
	ToolConfigError,
	invalidToolConfig,
	toolConfigProvider,
	type ToolConfigFamily,
	type ToolConfigOp,
	type ToolConfigSaveBody,
	type ToolConfigRevealBody,
	type ToolCredentialField,
} from "./tool-config-contract";

export const TOOL_CONFIG_KEYS = {
	"web-search": [
		"BILLING_CURRENCY",
		"WEB_SEARCH_ACTIVE",
		"WEB_SEARCH_API_KEY",
		"WEB_SEARCH_CATALOG",
		"WEB_SEARCH_COST",
		"WEB_SEARCH_PROVIDER",
	],
	"web-fetch": [
		"BILLING_CURRENCY",
		"WEB_FETCH_ACTIVE",
		"WEB_FETCH_API_KEY",
		"WEB_FETCH_CATALOG",
		"WEB_FETCH_COST",
		"WEB_FETCH_PROVIDER",
	],
	"web-deep-search": [
		"BILLING_CURRENCY",
		"WEB_DEEP_SEARCH_ACTIVE",
		"WEB_DEEP_SEARCH_CATALOG",
	],
	"ai-detection": [
		"AI_DETECTION_ACTIVE",
		"AI_DETECTION_CATALOG",
		"BILLING_CURRENCY",
	],
} as const;
export const TOOL_CONFIG_OVERVIEW_KEYS = [
	...new Set(Object.values(TOOL_CONFIG_KEYS).flat()),
].sort();
export const TOOL_CONFIG_UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const TOOL_CONFIG_CONTROLS = /[\p{Cc}\p{Cf}]/u;
export function exactObject(
	value: unknown,
	allowed: readonly string[],
	required: readonly string[] = []
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		invalidToolConfig();
	const object = value as Record<string, unknown>;
	if (
		Object.keys(object).some((key) => !allowed.includes(key)) ||
		required.some((key) => !Object.hasOwn(object, key))
	)
		invalidToolConfig();
	return object;
}
/** Reject duplicates before JSON.parse can discard them, including escaped member names. */
export function toolConfigJson(
	raw: string,
	maxBytes: number = TOOL_CONFIG_BOUNDS.bodyBytes
): Record<string, unknown> {
	if (new TextEncoder().encode(raw).length > maxBytes)
		invalidToolConfig("Tools JSON is too large");
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		invalidToolConfig("Invalid Tools JSON");
	}
	const object = exactObject(
		value,
		Object.keys(
			value && typeof value === "object" && !Array.isArray(value) ? value : {}
		)
	);
	const stack: Array<{
		object: boolean;
		expectingKey: boolean;
		keys: Set<string>;
	}> = [];
	let containers = 0;
	for (const token of raw.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/gu) ?? []) {
		if (token === "{" || token === "[") {
			if (++containers > 1000 || stack.length >= 16)
				invalidToolConfig("Tools JSON is too complex");
			stack.push({
				object: token === "{",
				expectingKey: token === "{",
				keys: new Set(),
			});
			continue;
		}
		if (token === "}" || token === "]") {
			stack.pop();
			continue;
		}
		const top = stack.at(-1);
		if (!top) continue;
		if (token === ":") top.expectingKey = false;
		else if (token === "," && top.object) top.expectingKey = true;
		else if (token.startsWith('"') && top.object && top.expectingKey) {
			const name: string = JSON.parse(token);
			if (
				top.keys.has(name) ||
				["__proto__", "constructor", "prototype"].includes(name)
			)
				invalidToolConfig("Invalid or duplicate Tools JSON member");
			top.keys.add(name);
		}
	}
	return object;
}
function base64url(value: unknown): string {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}
function decode(raw: unknown): Record<string, unknown> {
	if (
		typeof raw !== "string" ||
		!raw ||
		raw.length > TOOL_CONFIG_BOUNDS.version ||
		!/^[A-Za-z0-9_-]+$/u.test(raw)
	)
		invalidToolConfig("Invalid Tools version or cursor");
	try {
		const binary = atob(
			raw.replaceAll("-", "+").replaceAll("_", "/") +
				"=".repeat((4 - (raw.length % 4)) % 4)
		);
		const object = toolConfigJson(
			new TextDecoder("utf-8", { fatal: true }).decode(
				Uint8Array.from(binary, (value) => value.charCodeAt(0))
			)
		);
		if (base64url(object) !== raw)
			invalidToolConfig("Noncanonical Tools version or cursor");
		return object;
	} catch {
		invalidToolConfig("Invalid Tools version or cursor");
	}
}
export function toolConfigVersion(
	family: ToolConfigFamily,
	readSet: ConfigRevisionVector
): string {
	assertToolConfigVector(family, readSet);
	return base64url({
		v: 1,
		family,
		readSet: readSet.map(({ key, revision }) => ({ key, revision })),
	});
}
export function assertToolConfigVector(
	family: ToolConfigFamily,
	value: unknown
): asserts value is ConfigRevisionVector {
	const keys = TOOL_CONFIG_KEYS[family];
	if (!Array.isArray(value) || value.length !== keys.length)
		invalidToolConfig("Invalid Tools read set");
	value.forEach((row: unknown, index: number) => {
		const object = exactObject(row, ["key", "revision"], ["key", "revision"]);
		if (
			object.key !== keys[index] ||
			!(
				object.revision === null ||
				object.revision === "legacy" ||
				(typeof object.revision === "string" &&
					TOOL_CONFIG_UUID.test(object.revision))
			)
		)
			invalidToolConfig("Invalid Tools read set");
	});
}
export function parseToolConfigVersion(
	family: ToolConfigFamily,
	raw: unknown
): ConfigRevisionVector {
	const object = exactObject(
		decode(raw),
		["v", "family", "readSet"],
		["v", "family", "readSet"]
	);
	if (object.v !== 1 || object.family !== family)
		invalidToolConfig("Tools version belongs to another family");
	assertToolConfigVector(family, object.readSet);
	if (toolConfigVersion(family, object.readSet) !== raw)
		invalidToolConfig("Noncanonical Tools version");
	return object.readSet;
}
export function toolConfigInstant(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value)
	)
		invalidToolConfig("Invalid Tools audit time");
	const date = new Date(value);
	if (
		!Number.isFinite(date.getTime()) ||
		date.toISOString().slice(0, 23) !== value.slice(0, 23)
	)
		invalidToolConfig("Invalid Tools audit time");
	return value;
}
export function toolConfigCursor(
	family: ToolConfigFamily,
	before: { createdAt: string; id: string }
): string {
	if (!TOOL_CONFIG_UUID.test(before.id))
		invalidToolConfig("Invalid Tools audit ID");
	return base64url({
		v: 1,
		family,
		created_at: toolConfigInstant(before.createdAt),
		id: before.id,
	});
}
export function toolConfigQuery(
	url: string,
	allowed: readonly string[] = []
): URLSearchParams {
	const query = new URL(url).searchParams;
	for (const name of query.keys())
		if (!allowed.includes(name) || query.getAll(name).length !== 1)
			invalidToolConfig("Unknown or duplicate Tools query");
	return query;
}
export function toolConfigAuditQuery(family: ToolConfigFamily, url: string) {
	const query = toolConfigQuery(url, ["limit", "before"]);
	const rawLimit = query.get("limit");
	const limit = rawLimit === null ? 20 : Number(rawLimit);
	if (
		(rawLimit !== null && !/^[1-9]\d*$/u.test(rawLimit)) ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 100
	)
		invalidToolConfig("Invalid Tools audit limit");
	const raw = query.get("before");
	if (raw === null) return { limit };
	const object = exactObject(
		decode(raw),
		["v", "family", "created_at", "id"],
		["v", "family", "created_at", "id"]
	);
	if (
		object.v !== 1 ||
		object.family !== family ||
		typeof object.id !== "string" ||
		!TOOL_CONFIG_UUID.test(object.id)
	)
		invalidToolConfig("Invalid Tools audit cursor");
	const before = {
		createdAt: toolConfigInstant(object.created_at),
		id: object.id,
	};
	if (toolConfigCursor(family, before) !== raw)
		invalidToolConfig("Noncanonical Tools audit cursor");
	return { limit, before };
}
export function toolConfigReason(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		Array.from(value).length > TOOL_CONFIG_BOUNDS.reason ||
		TOOL_CONFIG_CONTROLS.test(value)
	)
		invalidToolConfig(
			"A nonempty operator reason of at most 600 characters is required"
		);
	return value.trim();
}
export function toolConfigMoney(value: unknown, allowString = false): number {
	const number =
		typeof value === "number"
			? value
			: allowString && typeof value === "string" && value.trim()
			? Number(value.trim())
			: NaN;
	const scaled = Math.round(number * 1_000_000);
	if (
		!Number.isFinite(number) ||
		number < 0 ||
		number > TOOL_CONFIG_BOUNDS.money ||
		!Number.isSafeInteger(scaled) ||
		(number > 0 && scaled === 0)
	)
		invalidToolConfig("Invalid Tools price");
	return scaled / 1_000_000;
}
export function toolConfigUnit(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		invalidToolConfig("Invalid Tools billing unit");
	return value;
}
export function toolConfigOp(value: unknown, max: number): ToolConfigOp {
	const object = exactObject(value, ["op", "value"], ["op"]);
	if (object.op === "keep" || object.op === "clear") {
		if (Object.hasOwn(object, "value")) invalidToolConfig();
		return { op: object.op };
	}
	if (
		object.op !== "set" ||
		typeof object.value !== "string" ||
		!object.value.trim() ||
		object.value.length > max ||
		TOOL_CONFIG_CONTROLS.test(object.value) ||
		object.value.trim() === "••••••••"
	)
		invalidToolConfig("Invalid Tools field update");
	return { op: "set", value: object.value.trim() };
}
export function toolConfigFields(
	family: ToolConfigFamily
): readonly ToolCredentialField[] {
	return family === "ai-detection" ? ["secretId", "secretKey"] : ["apiKey"];
}
function expectedVersion(
	family: ToolConfigFamily,
	body: Record<string, unknown>
): string {
	if (!Object.hasOwn(body, "expected_version"))
		throw new ToolConfigError(
			428,
			"tools_version_required",
			"A complete Tools version is required"
		);
	parseToolConfigVersion(family, body.expected_version);
	return body.expected_version as string;
}
export function toolConfigSaveInput(
	family: ToolConfigFamily,
	raw: string
): ToolConfigSaveBody {
	const body = exactObject(
		toolConfigJson(raw),
		[
			"operation",
			"expected_version",
			"reason",
			"prices",
			"credentials",
			"settings",
			"accept_loss_pricing",
		],
		["operation", "reason", "prices", "credentials", "accept_loss_pricing"]
	);
	const version = expectedVersion(family, body);
	if (
		(body.operation !== "save" && body.operation !== "save_activate") ||
		typeof body.accept_loss_pricing !== "boolean"
	)
		invalidToolConfig();
	const prices = exactObject(
		body.prices,
		["metered", "standard", "charged"],
		["metered", "standard", "charged"]
	);
	const fields = toolConfigFields(family);
	const credentialInput = exactObject(body.credentials, fields, fields);
	const credentials = Object.fromEntries(
		fields.map((field) => [
			field,
			toolConfigOp(credentialInput[field], TOOL_CONFIG_BOUNDS.credential),
		])
	);
	const settings: NonNullable<ToolConfigSaveBody["settings"]> = {};
	if (Object.hasOwn(body, "settings")) {
		if (family !== "ai-detection")
			invalidToolConfig("Settings are only supported for AI detection");
		const input = exactObject(body.settings, [
			"billingUnitChars",
			"region",
			"bizType",
		]);
		if (Object.hasOwn(input, "billingUnitChars"))
			settings.billingUnitChars = toolConfigUnit(input.billingUnitChars);
		if (Object.hasOwn(input, "region"))
			settings.region = toolConfigOp(input.region, TOOL_CONFIG_BOUNDS.region);
		if (Object.hasOwn(input, "bizType"))
			settings.bizType = toolConfigOp(
				input.bizType,
				TOOL_CONFIG_BOUNDS.bizType
			);
	}
	return {
		operation: body.operation,
		expected_version: version,
		reason: toolConfigReason(body.reason),
		prices: {
			metered: toolConfigMoney(prices.metered),
			standard: toolConfigMoney(prices.standard),
			charged: toolConfigMoney(prices.charged),
		},
		credentials,
		...(family === "ai-detection" ? { settings } : {}),
		accept_loss_pricing: body.accept_loss_pricing,
	};
}
export function toolConfigRevealInput(
	family: ToolConfigFamily,
	provider: string,
	raw: string
): ToolConfigRevealBody {
	toolConfigProvider(family, provider);
	const body = exactObject(
		toolConfigJson(raw),
		["field", "expected_version", "reason"],
		["field", "reason"]
	);
	const version = expectedVersion(family, body);
	if (
		typeof body.field !== "string" ||
		!(toolConfigFields(family) as readonly string[]).includes(body.field)
	)
		invalidToolConfig("Invalid Tools credential field");
	return {
		field: body.field as ToolCredentialField,
		expected_version: version,
		reason: toolConfigReason(body.reason),
	};
}
