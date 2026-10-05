/** Tools wire contract. Ordinary responses contain no credential values or catalogs. */
export const TOOL_CONFIG_FAMILIES = [
	"web-search",
	"web-fetch",
	"web-deep-search",
	"ai-detection",
] as const;
export type ToolConfigFamily = (typeof TOOL_CONFIG_FAMILIES)[number];
export const TOOL_CONFIG_PROVIDERS = {
	"web-search": ["bocha", "tavily", "cleversee", "tencent_wsa"],
	"web-fetch": ["firecrawl", "tavily", "jina"],
	"web-deep-search": ["firecrawl", "jina"],
	"ai-detection": ["tencent_tms"],
} as const;
export type ToolConfigProvider =
	(typeof TOOL_CONFIG_PROVIDERS)[ToolConfigFamily][number];
export type ToolCredentialField = "apiKey" | "secretId" | "secretKey";
export type ToolStoredCredentialField = ToolCredentialField | "email";
export type ToolConfigField =
	| ToolStoredCredentialField
	| "metered"
	| "standard"
	| "charged"
	| "region"
	| "bizType"
	| "billingUnitChars"
	| "active"
	| "catalog"
	| "legacy_migration";
export type ToolConfigOp =
	| { op: "keep" }
	| { op: "set"; value: string }
	| { op: "clear" };
export type ToolConfigPrices = {
	metered: number;
	standard: number;
	charged: number;
};
export const TOOL_CONFIG_BOUNDS = {
	version: 2048,
	reason: 600,
	credential: 4096,
	region: 64,
	bizType: 255,
	bodyBytes: 65536,
	catalogBytes: 65535,
	money: Number.MAX_SAFE_INTEGER / 1_000_000,
	billingUnitChars: Number.MAX_SAFE_INTEGER,
} as const;
export type ToolConfigCurrency = {
	value: "USD" | "CNY" | null;
	source: "configured" | "missing" | "invalid" | "unsupported";
};
export type ToolConfigCapabilities = {
	can_write: boolean;
	can_reveal: boolean;
	can_playground: boolean;
	can_invocations: boolean;
};
export type ToolConfigProviderSummary = {
	provider: ToolConfigProvider;
	implemented: boolean;
	entrySource: "catalog" | "legacy" | "default" | "unavailable";
	configured: boolean;
	credentials: Array<{
		field: ToolCredentialField;
		required: boolean;
		configured: boolean;
	}>;
	prices: ToolConfigPrices | null;
	priceSource: "configured" | "legacy" | "default" | "unavailable";
	unit: "request" | "chars";
	billingUnitChars: number | null;
	isLossPricing: boolean | null;
};
export type ToolConfigFamilyState = {
	family: ToolConfigFamily;
	version: string;
	source: "catalog" | "legacy" | "missing" | "invalid";
	catalogState:
		| "missing"
		| "empty"
		| "valid"
		| "invalid"
		| "unsupported_fields";
	savedActive: ToolConfigProvider | null;
	activeState: "configured" | "missing" | "invalid" | "ignored_without_catalog";
	effectiveProvider: ToolConfigProvider | null;
	configurationReady: boolean;
	configurationIssue:
		| "none"
		| "missing_credentials"
		| "invalid_provider"
		| "invalid_catalog"
		| "not_implemented"
		| "invalid_prices"
		| "invalid_billing_unit";
	editable: boolean;
	editBlockedCode:
		| null
		| "invalid_source"
		| "unsupported_source"
		| "invalid_currency";
};
export type ToolConfigFamilySummary = ToolConfigFamilyState & {
	providers: ToolConfigProviderSummary[];
};
export type ToolConfigOverview = {
	billingCurrency: ToolConfigCurrency;
	families: ToolConfigFamilySummary[];
	capabilities: ToolConfigCapabilities;
};
export type ToolConfigSetting = {
	value: string | null;
	availability: "available" | "redacted" | "invalid";
	source: "configured" | "default" | "missing";
};
export type ToolConfigDetail = {
	family: ToolConfigFamily;
	provider: ToolConfigProvider;
	version: string;
	billingCurrency: ToolConfigCurrency;
	familyState: ToolConfigFamilyState;
	configuration: ToolConfigProviderSummary;
	settings: null | { region: ToolConfigSetting; bizType: ToolConfigSetting };
	capabilities: ToolConfigCapabilities;
};
export type ToolConfigSaveBody = {
	operation: "save" | "save_activate";
	expected_version: string;
	reason: string;
	prices: ToolConfigPrices;
	credentials: Partial<Record<ToolCredentialField, ToolConfigOp>>;
	settings?: {
		billingUnitChars?: number;
		region?: ToolConfigOp;
		bizType?: ToolConfigOp;
	};
	accept_loss_pricing: boolean;
};
export type ToolConfigSaveResult = {
	outcome: "applied" | "unchanged";
	auditId: string | null;
	detail: ToolConfigDetail;
};
export type ToolConfigRevealBody = {
	field: ToolCredentialField;
	expected_version: string;
	reason: string;
};
export type ToolConfigRevealResult = {
	family: ToolConfigFamily;
	provider: ToolConfigProvider;
	field: ToolCredentialField;
	value: string;
	version: string;
	auditId: string;
	expiresInSeconds: 60;
};
export type ToolConfigAuditEntry = {
	id: string;
	family: ToolConfigFamily;
	provider: ToolConfigProvider | null;
	action: "save" | "save_activate" | "activate" | "legacy_save" | "reveal";
	actorKind: "console" | "admin_key";
	actorId: string;
	source: "admin_api" | "legacy_admin";
	reason: string;
	changedFields: Array<{
		provider: ToolConfigProvider | null;
		field: ToolConfigField;
	}>;
	activeBefore: ToolConfigProvider | null;
	activeAfter: ToolConfigProvider | null;
	credentials: Array<{
		provider: ToolConfigProvider;
		field: ToolStoredCredentialField;
		operation: "keep" | "set" | "clear" | "reveal";
		configuredBefore: boolean;
		configuredAfter: boolean;
	}>;
	beforeVersion: string;
	afterVersion: string;
	createdAt: string;
};
export type ToolConfigAuditResult = {
	entries: ToolConfigAuditEntry[];
	next_cursor: string | null;
};
export class ToolConfigError extends Error {
	constructor(
		public readonly status: 400 | 403 | 404 | 409 | 428 | 503,
		public readonly code: string,
		message: string
	) {
		super(message);
	}
}
export function invalidToolConfig(
	message = "Invalid Tools configuration input"
): never {
	throw new ToolConfigError(400, "invalid_tool_config_input", message);
}
export function toolConfigFamily(value: unknown): ToolConfigFamily {
	if (
		typeof value !== "string" ||
		!(TOOL_CONFIG_FAMILIES as readonly string[]).includes(value)
	)
		invalidToolConfig("Invalid Tools family");
	return value as ToolConfigFamily;
}
export function toolConfigProvider(
	family: ToolConfigFamily,
	value: unknown
): ToolConfigProvider {
	if (
		typeof value !== "string" ||
		!(TOOL_CONFIG_PROVIDERS[family] as readonly string[]).includes(value)
	)
		invalidToolConfig("Invalid Tools provider");
	return value as ToolConfigProvider;
}
