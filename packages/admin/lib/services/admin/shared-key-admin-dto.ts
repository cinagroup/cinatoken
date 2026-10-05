import {
	isSharedKeyChannelType,
	sharedKeyAdminRevision,
	sharedKeyStateExpectation,
	type AdminSharedKeyAuditRow,
	type AdminSharedKeyAuditSnapshot,
	type SharedKeyChannelType,
	type SharedKeyRow,
	type SharedKeyStatus,
} from "@octafuse/core";
import type { AdminPrincipal } from "@/lib/admin-principal";
import {
	SHARED_KEY_ADMIN_ACTOR_MAX_LENGTH,
	SHARED_KEY_ADMIN_REVISION,
	SHARED_KEY_ADMIN_UUID,
	sharedKeyAdminCapabilities,
} from "./shared-key-admin-contract";

export type SharedKeyAdminFailureCode =
	| "credential_rejected"
	| "validation_timeout"
	| "validation_unavailable"
	| "validation_failed"
	| "unsupported_channel"
	| "empty_credential"
	| "unknown_failure";
export type SharedKeyAdminStatisticsBasis =
	| "legacy_cached_projection"
	| "reviewed_credited_usage";
export type AdminSharedKeyCapabilities = ReturnType<
	typeof sharedKeyAdminCapabilities
>;
export type AdminSharedKeyCurrencyReference = {
	currentBillingCurrency: string | null;
	currentBillingCurrencySource: "configured" | "missing" | "invalid";
	currentBillingCurrencyReferenceOnly: true;
};
export type SafeAdminSharedKeyRow = {
	id: string;
	sellerUserId: string;
	sellerEmail: string | null;
	channelType: SharedKeyChannelType;
	label: string | null;
	status: SharedKeyStatus;
	sellerPriority: number;
	weight: number;
	inputPrice: number;
	outputPrice: number;
	cacheReadPrice: number | null;
	cacheWritePrice: number | null;
	validatedAt: string | null;
	lastUsedAt: string | null;
	lastFailureAt: string | null;
	createdAt: string;
	updatedAt: string;
	servedInputTokens: number;
	servedOutputTokens: number;
	earnedTotal: number;
	apiKeyMasked: "••••••••";
	failureCode: SharedKeyAdminFailureCode | null;
	profile_revision: string;
	quoteCurrency: null;
	quoteCurrencyAvailability: "legacy_unrecorded";
	quoteUnit: "per_million_tokens";
	earningsCurrency: "USD";
	earningsAmountUnit: "major";
	statisticsBasis: SharedKeyAdminStatisticsBasis;
};
export type AdminSharedKeysOverview = AdminSharedKeyCurrencyReference & {
	items: SafeAdminSharedKeyRow[];
	total: number;
	page: number;
	page_size: number;
	hasMore: boolean;
	capabilities: AdminSharedKeyCapabilities;
};
export type AdminSharedKeyDetail = SafeAdminSharedKeyRow &
	AdminSharedKeyCurrencyReference & {
		capabilities: AdminSharedKeyCapabilities;
	};

function corrupt(): never {
	throw new Error("Invalid stored Shared Key governance data");
}
function safeId(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > 255 ||
		/[\s/?#\\\p{Cc}\p{Cf}]/u.test(value)
	)
		corrupt();
	try {
		encodeURIComponent(value);
	} catch {
		corrupt();
	}
	return value;
}
function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		corrupt();
	return value;
}
function money(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
		corrupt();
	return value;
}
function optionalMoney(value: unknown): number | null {
	return value === null ? null : money(value);
}
function status(value: unknown): SharedKeyStatus {
	if (
		typeof value !== "string" ||
		!["active", "paused", "disabled", "invalid", "validating"].includes(value)
	)
		corrupt();
	return value as SharedKeyStatus;
}
function priority(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < -2147483648 ||
		value > 2147483647
	)
		corrupt();
	return value;
}
function weight(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > 100
	)
		corrupt();
	return value;
}
/** Database adapters may return UTC SQL timestamps; never interpret them in the host timezone. */
function instant(value: unknown): string {
	if (typeof value !== "string") corrupt();
	const utc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/u.test(value)
		? `${value.replace(" ", "T")}Z`
		: value;
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(utc))
		corrupt();
	const date = new Date(utc);
	if (
		!Number.isFinite(date.getTime()) ||
		date.toISOString().slice(0, 19) !== utc.slice(0, 19)
	)
		corrupt();
	const fraction = utc.match(/\.(\d{1,6})Z$/u)?.[1] ?? "";
	return `${utc.slice(0, 19)}.${fraction.padEnd(
		fraction.length > 3 ? 6 : 3,
		"0"
	)}Z`;
}
function optionalInstant(value: unknown): string | null {
	return value === null ? null : instant(value);
}

/** Replace complete known material before truncation, including short historical credentials. */
export function redactSharedKeyAdminText(
	value: string,
	material: readonly string[],
	max: number
): string {
	let safe = value;
	for (const secret of [...new Set(material.filter(Boolean))].sort(
		(a, b) => b.length - a.length
	))
		safe = safe.replaceAll(secret, "[redacted]");
	safe = safe
		.replace(/\benc:v[12]:[A-Za-z0-9+/=_-]+:[A-Za-z0-9+/=_-]+/gu, "[redacted]")
		.replace(
			/\b(?:Bearer\s+\S+|(?:sk-|sk_|rk_|pk_|AIza|ghp_|gho_|xox[baprs]-)[A-Za-z0-9_./+\-=]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/giu,
			"[redacted]"
		)
		.replace(/\b(?:sha256:)?[a-f0-9]{64}\b/giu, "[redacted]")
		.replace(
			/\b(api[_ -]?key|access[_ -]?token|secret|password|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/giu,
			"$1=[redacted]"
		)
		.replace(/[\p{Cc}\p{Cf}]/gu, " ");
	return safe.slice(0, max);
}
function optionalText(
	value: unknown,
	material: readonly string[],
	max: number
): string | null {
	if (value === null) return null;
	if (typeof value !== "string") corrupt();
	return redactSharedKeyAdminText(value, material, max);
}
export function sharedKeyAdminFailureCode(
	reason: unknown
): SharedKeyAdminFailureCode | null {
	if (reason === null) return null;
	if (typeof reason !== "string") corrupt();
	if (
		/^upstream (?:rejected key|auth rejected) \(HTTP (?:401|403)\)$/u.test(
			reason
		)
	)
		return "credential_rejected";
	if (reason === "validation request timed out") return "validation_timeout";
	if (/^validation endpoint returned HTTP [1-5]\d{2}$/u.test(reason))
		return "validation_unavailable";
	if (reason === "validation request failed") return "validation_failed";
	if (
		/^unsupported channel: (?:openai|anthropic|zhipu|deepseek)$/u.test(reason)
	)
		return "unsupported_channel";
	if (reason === "empty api key") return "empty_credential";
	return "unknown_failure";
}
export function sharedKeyAdminCurrencyReference(
	stored: unknown
): AdminSharedKeyCurrencyReference {
	if (stored === null || stored === undefined)
		return {
			currentBillingCurrency: null,
			currentBillingCurrencySource: "missing",
			currentBillingCurrencyReferenceOnly: true,
		};
	const value = stored;
	return typeof value === "string" && /^[A-Z]{3}$/u.test(value)
		? {
				currentBillingCurrency: value,
				currentBillingCurrencySource: "configured",
				currentBillingCurrencyReferenceOnly: true,
		  }
		: {
				currentBillingCurrency: null,
				currentBillingCurrencySource: "invalid",
				currentBillingCurrencyReferenceOnly: true,
		  };
}

/** Only explicit public fields leave the service. Profile revisions use the unprojected row. */
export async function projectAdminSharedKey(
	row: SharedKeyRow,
	sellerEmail: string | null,
	material: readonly string[],
	statisticsBasis: SharedKeyAdminStatisticsBasis
): Promise<SafeAdminSharedKeyRow> {
	if (!isSharedKeyChannelType(row.channelType)) corrupt();
	const profile_revision = await sharedKeyAdminRevision(
		row.id,
		sharedKeyStateExpectation(row)
	);
	if (!SHARED_KEY_ADMIN_REVISION.test(profile_revision)) corrupt();
	return {
		id: safeId(row.id),
		sellerUserId: safeId(row.sellerUserId),
		sellerEmail: optionalText(sellerEmail, material, 320),
		channelType: row.channelType,
		label: optionalText(row.label, material, 255),
		status: status(row.status),
		sellerPriority: priority(row.sellerPriority),
		weight: weight(row.weight),
		inputPrice: money(row.inputPrice),
		outputPrice: money(row.outputPrice),
		cacheReadPrice: optionalMoney(row.cacheReadPrice),
		cacheWritePrice: optionalMoney(row.cacheWritePrice),
		validatedAt: optionalInstant(row.validatedAt),
		lastUsedAt: optionalInstant(row.lastUsedAt),
		lastFailureAt: optionalInstant(row.lastFailureAt),
		createdAt: instant(row.createdAt),
		updatedAt: instant(row.updatedAt),
		servedInputTokens: count(row.servedInputTokens),
		servedOutputTokens: count(row.servedOutputTokens),
		earnedTotal: money(row.earnedTotal),
		apiKeyMasked: "••••••••",
		failureCode: sharedKeyAdminFailureCode(row.failureReason),
		profile_revision,
		quoteCurrency: null,
		quoteCurrencyAvailability: "legacy_unrecorded",
		quoteUnit: "per_million_tokens",
		earningsCurrency: "USD",
		earningsAmountUnit: "major",
		statisticsBasis,
	};
}
export function sharedKeyAdminContext(
	reference: AdminSharedKeyCurrencyReference,
	principal: AdminPrincipal
) {
	return { ...reference, capabilities: sharedKeyAdminCapabilities(principal) };
}
function auditSnapshot(
	value: AdminSharedKeyAuditSnapshot
): AdminSharedKeyAuditSnapshot {
	if (
		!value ||
		typeof value !== "object" ||
		typeof value.validated !== "boolean"
	)
		corrupt();
	return {
		status: status(value.status),
		sellerPriority: priority(value.sellerPriority),
		weight: weight(value.weight),
		validated: value.validated,
	};
}
export function projectAdminSharedKeyAudit(
	row: AdminSharedKeyAuditRow,
	keyId: string
): AdminSharedKeyAuditRow {
	if (
		!SHARED_KEY_ADMIN_UUID.test(row.id) ||
		row.keyId !== keyId ||
		!SHARED_KEY_ADMIN_REVISION.test(row.beforeRevision) ||
		!["console", "api_key"].includes(row.actorKind) ||
		!["admin_api", "legacy_admin"].includes(row.source) ||
		typeof row.actorId !== "string" ||
		!row.actorId ||
		row.actorId.length > SHARED_KEY_ADMIN_ACTOR_MAX_LENGTH[row.actorKind] ||
		/[\p{Cc}\p{Cf}]/u.test(row.actorId) ||
		typeof row.reason !== "string" ||
		!row.reason.trim() ||
		row.reason.length > 600 ||
		/[\p{Cc}\p{Cf}]/u.test(row.reason)
	)
		corrupt();
	const before = auditSnapshot(row.before);
	let after: AdminSharedKeyAuditSnapshot | null = null;
	if (row.action === "deleted") {
		if (
			row.changeMask !== 8 ||
			row.after !== null ||
			row.afterRevision !== null
		)
			corrupt();
	} else {
		if (
			!["updated", "disabled", "restored"].includes(row.action) ||
			!Number.isInteger(row.changeMask) ||
			row.changeMask < 1 ||
			row.changeMask > 7 ||
			!row.after ||
			typeof row.afterRevision !== "string" ||
			!SHARED_KEY_ADMIN_REVISION.test(row.afterRevision)
		)
			corrupt();
		after = auditSnapshot(row.after);
		const actualMask =
			(before.status !== after.status ? 1 : 0) |
			(before.sellerPriority !== after.sellerPriority ? 2 : 0) |
			(before.weight !== after.weight ? 4 : 0);
		if (
			actualMask !== row.changeMask ||
			before.validated !== after.validated ||
			(before.status !== after.status && row.action === "updated") ||
			row.beforeRevision === row.afterRevision ||
			(row.action === "disabled" &&
				(!(row.changeMask & 1) || after.status !== "disabled")) ||
			(row.action === "restored" &&
				(!(row.changeMask & 1) ||
					before.status !== "disabled" ||
					after.status !== "paused"))
		)
			corrupt();
	}
	return {
		id: row.id,
		createdAt: instant(row.createdAt),
		keyId,
		action: row.action,
		changeMask: row.changeMask,
		actorKind: row.actorKind,
		actorId: redactSharedKeyAdminText(
			row.actorId,
			[],
			SHARED_KEY_ADMIN_ACTOR_MAX_LENGTH[row.actorKind]
		),
		source: row.source,
		reason: redactSharedKeyAdminText(row.reason, [], 600),
		before,
		after,
		beforeRevision: row.beforeRevision,
		afterRevision: row.afterRevision,
	};
}
