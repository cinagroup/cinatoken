import type { ConfigSnapshot, ConfigRevisionVector } from "@octafuse/core";
import { hasAdminPermission, type AdminPrincipal } from "@/lib/admin-principal";
import {
	TOOL_CONFIG_BOUNDS,
	TOOL_CONFIG_PROVIDERS,
	type ToolConfigFamily,
	type ToolConfigProvider,
	type ToolConfigPrices,
	type ToolConfigProviderSummary,
	type ToolConfigFamilyState,
	type ToolConfigCurrency,
	type ToolConfigDetail,
	type ToolConfigSetting,
} from "./tool-config-contract";
import {
	TOOL_CONFIG_KEYS,
	TOOL_CONFIG_CONTROLS,
	toolConfigFields,
	toolConfigJson,
	toolConfigMoney,
	toolConfigUnit,
	toolConfigVersion,
} from "./tool-config-input";

export const TOOL_CONFIG_DEFAULTS = {
	"web-search": { provider: "bocha", price: 0.001 },
	"web-fetch": { provider: "firecrawl", price: 0.002 },
	"web-deep-search": { provider: "firecrawl", price: 0.01 },
	"ai-detection": { provider: "tencent_tms", price: 0.01 },
} as const;
const credentialFields = ["apiKey", "secretId", "secretKey", "email"] as const;
export type ToolConfigEntry = Record<string, unknown>;
export type ToolConfigPrepared = {
	family: ToolConfigFamily;
	snapshots: ConfigSnapshot[];
	vector: ConfigRevisionVector;
	catalog: Record<string, ToolConfigEntry>;
	entryKeys: Partial<Record<ToolConfigProvider, string>>;
	state: ToolConfigFamilyState;
	currency: ToolConfigCurrency;
	secrets: string[];
	legacyProvider: ToolConfigProvider | null;
	legacyPrice: ToolConfigPrices | null;
	legacyKey: string;
};
export function toolConfigCapabilities(principal: AdminPrincipal) {
	return {
		can_write: hasAdminPermission(principal, "config.write"),
		can_reveal:
			hasAdminPermission(principal, "config.read") &&
			hasAdminPermission(principal, "config.secrets.read"),
		can_playground: hasAdminPermission(principal, "playground.execute"),
		can_invocations: hasAdminPermission(principal, "logs.read"),
	};
}
export function toolConfigCurrency(raw: string | null): ToolConfigCurrency {
	if (raw === null || !raw.trim()) return { value: "USD", source: "missing" };
	const normalized = raw.trim().toUpperCase();
	if (!/^[A-Z]{3}$/u.test(normalized))
		return { value: null, source: "invalid" };
	return normalized === "USD" || normalized === "CNY"
		? { value: normalized, source: "configured" }
		: { value: null, source: "unsupported" };
}
export function toolConfigSecrets(value: unknown): string[] {
	const result: string[] = [];
	function visit(item: unknown, depth: number): void {
		if (depth > 16 || !item || typeof item !== "object") return;
		for (const [key, child] of Object.entries(item)) {
			if (
				(credentialFields as readonly string[]).includes(key) &&
				typeof child === "string" &&
				child.trim()
			) {
				result.push(child, child.trim());
			} else if (child && typeof child === "object") visit(child, depth + 1);
		}
	}
	visit(value, 0);
	return [...new Set(result)].sort((a, b) => b.length - a.length);
}
/** Capture every credential occurrence, including duplicate members in a blocked catalog. */
export function toolConfigSnapshotSecrets(
	rows: readonly ConfigSnapshot[]
): string[] {
	const secrets: string[] = [];
	for (const row of rows) {
		if (row.key.endsWith("_API_KEY") && row.value?.trim())
			secrets.push(row.value, row.value.trim());
		if (!row.key.endsWith("_CATALOG") || !row.value) continue;
		for (const match of row.value.matchAll(
			/("(?:\\.|[^"\\])*")\s*:\s*("(?:\\.|[^"\\])*")/gu
		)) {
			try {
				const key: unknown = JSON.parse(match[1]);
				const value: unknown = JSON.parse(match[2]);
				if (
					typeof key === "string" &&
					(credentialFields as readonly string[]).includes(key) &&
					typeof value === "string" &&
					value.trim()
				)
					secrets.push(value, value.trim());
			} catch {
				/* An invalid source remains blocked; never include it in a DTO. */
			}
		}
	}
	return [...new Set(secrets)].sort((a, b) => b.length - a.length);
}
export function redactToolConfigText(
	value: string,
	secrets: readonly string[],
	max = 600
): string {
	let safe = value;
	for (const secret of [...secrets].sort((a, b) => b.length - a.length))
		if (secret) safe = safe.split(secret).join("[redacted]");
	safe = safe
		.replace(/(?:sk-|tvly-|fc-|jina_|AKID)[A-Za-z0-9_\-]{4,}/gu, "[redacted]")
		.replace(/Bearer\s+\S+/giu, "[redacted]")
		.replace(
			/(?:api[_-]?key|secret[_-]?(?:key|id)|password)\s*[:=]\s*[^\s,;]+/giu,
			"[redacted]"
		);
	return [...safe].slice(0, max).join("");
}
export function toolConfigCatalogKey(family: ToolConfigFamily): string {
	return TOOL_CONFIG_KEYS[family].find((key) => key.endsWith("_CATALOG"))!;
}
export function toolConfigActiveKey(family: ToolConfigFamily): string {
	return TOOL_CONFIG_KEYS[family].find((key) => key.endsWith("_ACTIVE"))!;
}
export function toolConfigRaw(
	prepared: ToolConfigPrepared,
	key: string
): string | null {
	return prepared.snapshots.find((row) => row.key === key)?.value ?? null;
}
export function toolConfigEntryPrices(
	entry: ToolConfigEntry,
	family: ToolConfigFamily
): ToolConfigPrices {
	const parsed: Partial<ToolConfigPrices & { cost: number }> = {};
	for (const field of ["metered", "standard", "charged", "cost"] as const) {
		if (
			entry[field] !== undefined &&
			entry[field] !== null &&
			entry[field] !== ""
		)
			parsed[field] = toolConfigMoney(entry[field], true);
	}
	const fallback =
		parsed.charged ??
		parsed.cost ??
		parsed.standard ??
		parsed.metered ??
		TOOL_CONFIG_DEFAULTS[family].price;
	return {
		metered: parsed.metered ?? fallback,
		standard: parsed.standard ?? fallback,
		charged: parsed.charged ?? parsed.cost ?? fallback,
	};
}
function validateEntry(
	entry: ToolConfigEntry,
	family: ToolConfigFamily
): "valid" | "unsupported_fields" {
	const allowed =
		family === "ai-detection"
			? [
					"apiKey",
					"secretId",
					"secretKey",
					"email",
					"region",
					"bizType",
					"billingUnitChars",
					"metered",
					"standard",
					"charged",
					"cost",
			  ]
			: ["apiKey", "metered", "standard", "charged", "cost"];
	if (Object.keys(entry).some((key) => !allowed.includes(key)))
		return "unsupported_fields";
	for (const field of credentialFields)
		if (Object.hasOwn(entry, field)) {
			if (
				typeof entry[field] !== "string" ||
				(entry[field] as string).length > TOOL_CONFIG_BOUNDS.credential ||
				TOOL_CONFIG_CONTROLS.test(entry[field] as string)
			)
				throw new TypeError("Invalid Tools source");
		}
	if (family !== "ai-detection" && typeof entry.apiKey !== "string")
		throw new TypeError("Invalid Tools source");
	for (const field of ["region", "bizType"] as const)
		if (Object.hasOwn(entry, field)) {
			if (
				typeof entry[field] !== "string" ||
				(entry[field] as string).length > TOOL_CONFIG_BOUNDS[field] ||
				TOOL_CONFIG_CONTROLS.test(entry[field] as string)
			)
				throw new TypeError("Invalid Tools source");
		}
	if (
		Object.hasOwn(entry, "billingUnitChars") &&
		entry.billingUnitChars !== null &&
		entry.billingUnitChars !== ""
	)
		toolConfigUnit(
			typeof entry.billingUnitChars === "string"
				? Number(entry.billingUnitChars.trim())
				: entry.billingUnitChars
		);
	toolConfigEntryPrices(entry, family);
	return "valid";
}
export function prepareToolConfigFamily(
	family: ToolConfigFamily,
	all: readonly ConfigSnapshot[]
): ToolConfigPrepared {
	const keys = TOOL_CONFIG_KEYS[family];
	const snapshots = keys.map((key) => {
		const found = all.filter((row) => row.key === key);
		if (
			found.length !== 1 ||
			(found[0].value !== null && typeof found[0].value !== "string")
		)
			throw new TypeError("Invalid Tools snapshot");
		return found[0];
	});
	const vector = snapshots.map(({ key, revision }) => ({ key, revision }));
	const version = toolConfigVersion(family, vector);
	const raw = (key: string) =>
		snapshots.find((row) => row.key === key)?.value ?? null;
	const currency = toolConfigCurrency(raw("BILLING_CURRENCY"));
	const catalog: Record<string, ToolConfigEntry> = {};
	const entryKeys: ToolConfigPrepared["entryKeys"] = {};
	let catalogState: ToolConfigFamilyState["catalogState"] = "missing";
	let secrets: string[] = [];
	const catalogRaw = raw(toolConfigCatalogKey(family));
	if (catalogRaw?.trim()) {
		try {
			const parsed = toolConfigJson(
				catalogRaw,
				TOOL_CONFIG_BOUNDS.catalogBytes
			);
			secrets = toolConfigSecrets(parsed);
			catalogState = Object.keys(parsed).length ? "valid" : "empty";
			for (const [key, value] of Object.entries(parsed)) {
				const provider = key.trim().toLowerCase() as ToolConfigProvider;
				if (
					!(TOOL_CONFIG_PROVIDERS[family] as readonly string[]).includes(
						provider
					) ||
					entryKeys[provider]
				) {
					catalogState = "unsupported_fields";
					continue;
				}
				if (!value || typeof value !== "object" || Array.isArray(value))
					throw new TypeError("Invalid Tools source");
				const entry = value as ToolConfigEntry;
				if (validateEntry(entry, family) === "unsupported_fields")
					catalogState = "unsupported_fields";
				catalog[key] = entry;
				entryKeys[provider] = key;
			}
		} catch {
			catalogState = "invalid";
		}
	}
	const legacyFamily = family === "web-search" || family === "web-fetch";
	const prefix = family === "web-search" ? "WEB_SEARCH" : "WEB_FETCH";
	const legacyRaw = legacyFamily
		? raw(prefix + "_PROVIDER")
				?.trim()
				.toLowerCase() ?? ""
		: "";
	const legacyCandidate = legacyRaw || TOOL_CONFIG_DEFAULTS[family].provider;
	const legacyProvider =
		legacyFamily &&
		(TOOL_CONFIG_PROVIDERS[family] as readonly string[]).includes(
			legacyCandidate
		)
			? (legacyCandidate as ToolConfigProvider)
			: null;
	const legacyKey = legacyFamily ? raw(prefix + "_API_KEY")?.trim() ?? "" : "";
	if (legacyKey) secrets.push(legacyKey);
	let legacyPrice: ToolConfigPrices | null = null;
	let legacyValid = true;
	if (legacyFamily && catalogState === "missing") {
		try {
			if (
				!(TOOL_CONFIG_PROVIDERS[family] as readonly string[]).includes(
					legacyProvider!
				) ||
				legacyKey.length > TOOL_CONFIG_BOUNDS.credential ||
				TOOL_CONFIG_CONTROLS.test(legacyKey)
			)
				throw new TypeError("Invalid Tools source");
			const cost = raw(prefix + "_COST");
			const price = cost?.trim()
				? toolConfigMoney(cost, true)
				: TOOL_CONFIG_DEFAULTS[family].price;
			legacyPrice = { metered: price, standard: price, charged: price };
		} catch {
			legacyValid = false;
		}
	}
	const activeRaw =
		raw(toolConfigActiveKey(family))?.trim().toLowerCase() ?? "";
	const activeValid =
		!activeRaw ||
		(TOOL_CONFIG_PROVIDERS[family] as readonly string[]).includes(activeRaw);
	const source: ToolConfigFamilyState["source"] =
		catalogState === "missing"
			? legacyFamily
				? "legacy"
				: "missing"
			: catalogState === "invalid"
			? "invalid"
			: "catalog";
	const effectiveProvider =
		catalogState === "missing"
			? legacyFamily
				? legacyProvider
				: TOOL_CONFIG_DEFAULTS[family].provider
			: activeValid
			? ((activeRaw ||
					TOOL_CONFIG_DEFAULTS[family].provider) as ToolConfigProvider)
			: null;
	let issue: ToolConfigFamilyState["configurationIssue"] = "none";
	if (legacyFamily && catalogState === "missing" && legacyProvider === null)
		issue = "invalid_provider";
	else if (
		catalogState === "invalid" ||
		catalogState === "unsupported_fields" ||
		!legacyValid
	)
		issue = "invalid_catalog";
	else if (!activeValid && catalogState !== "missing")
		issue = "invalid_provider";
	else {
		const entry = effectiveProvider
			? catalog[entryKeys[effectiveProvider] ?? ""]
			: undefined;
		const configured =
			catalogState === "missing" && legacyFamily
				? !!legacyKey
				: toolConfigFields(family).every(
						(field) =>
							typeof entry?.[field] === "string" &&
							!!(entry[field] as string).trim()
				  );
		if (!configured) issue = "missing_credentials";
	}
	const sourceBlocked =
		catalogState === "invalid" ||
		catalogState === "unsupported_fields" ||
		!legacyValid;
	const state: ToolConfigFamilyState = {
		family,
		version,
		source,
		catalogState,
		savedActive:
			activeValid && activeRaw ? (activeRaw as ToolConfigProvider) : null,
		activeState:
			catalogState === "missing" && activeRaw
				? "ignored_without_catalog"
				: !activeRaw
				? "missing"
				: activeValid
				? "configured"
				: "invalid",
		effectiveProvider,
		configurationReady: issue === "none",
		configurationIssue: issue,
		editable: !sourceBlocked && currency.value !== null,
		editBlockedCode: sourceBlocked
			? catalogState === "unsupported_fields"
				? "unsupported_source"
				: "invalid_source"
			: currency.value === null
			? "invalid_currency"
			: null,
	};
	return {
		family,
		snapshots,
		vector,
		catalog,
		entryKeys,
		state,
		currency,
		secrets: [...new Set(secrets)],
		legacyProvider,
		legacyPrice,
		legacyKey,
	};
}
export function toolConfigProviderSummary(
	prepared: ToolConfigPrepared,
	provider: ToolConfigProvider
): ToolConfigProviderSummary {
	const { family, state } = prepared;
	const entry = prepared.catalog[prepared.entryKeys[provider] ?? ""];
	const legacy =
		state.catalogState === "missing" && prepared.legacyProvider === provider;
	const available =
		state.editBlockedCode !== "invalid_source" &&
		state.editBlockedCode !== "unsupported_source";
	const credentials = toolConfigFields(family).map((field) => ({
		field,
		required: true,
		configured:
			available &&
			(legacy
				? !!prepared.legacyKey
				: typeof entry?.[field] === "string" &&
				  !!(entry[field] as string).trim()),
	}));
	let prices: ToolConfigPrices | null = null;
	if (available)
		prices = legacy
			? prepared.legacyPrice
			: toolConfigEntryPrices(entry ?? {}, family);
	return {
		provider,
		implemented: true,
		entrySource: !available
			? "unavailable"
			: entry
			? "catalog"
			: legacy
			? "legacy"
			: "default",
		configured: credentials.every((credential) => credential.configured),
		credentials,
		prices,
		priceSource: !available
			? "unavailable"
			: entry
			? "configured"
			: legacy
			? "legacy"
			: "default",
		unit: family === "ai-detection" ? "chars" : "request",
		billingUnitChars:
			family === "ai-detection" && available
				? entry?.billingUnitChars !== undefined &&
				  entry.billingUnitChars !== null &&
				  entry.billingUnitChars !== ""
					? Number(entry.billingUnitChars)
					: 2000
				: null,
		isLossPricing: prices ? prices.charged < prices.metered : null,
	};
}
function setting(
	prepared: ToolConfigPrepared,
	entry: ToolConfigEntry | undefined,
	field: "region" | "bizType"
): ToolConfigSetting {
	if (
		prepared.state.editBlockedCode === "invalid_source" ||
		prepared.state.editBlockedCode === "unsupported_source"
	)
		return { value: null, availability: "invalid", source: "missing" };
	const raw = entry?.[field];
	const value =
		typeof raw === "string"
			? raw.trim()
			: field === "region"
			? "ap-guangzhou"
			: "";
	const safe = redactToolConfigText(
		value,
		prepared.secrets,
		TOOL_CONFIG_BOUNDS[field]
	);
	return {
		value: safe === value ? value : null,
		availability: safe === value ? "available" : "redacted",
		source:
			typeof raw === "string"
				? "configured"
				: field === "region"
				? "default"
				: "missing",
	};
}
export function toolConfigDetail(
	prepared: ToolConfigPrepared,
	provider: ToolConfigProvider,
	principal: AdminPrincipal
): ToolConfigDetail {
	const entry = prepared.catalog[prepared.entryKeys[provider] ?? ""];
	return {
		family: prepared.family,
		provider,
		version: prepared.state.version,
		billingCurrency: prepared.currency,
		familyState: prepared.state,
		configuration: toolConfigProviderSummary(prepared, provider),
		settings:
			prepared.family === "ai-detection"
				? {
						region: setting(prepared, entry, "region"),
						bizType: setting(prepared, entry, "bizType"),
				  }
				: null,
		capabilities: toolConfigCapabilities(principal),
	};
}
