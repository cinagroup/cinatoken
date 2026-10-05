/** Browser-only validation; server DTO imports must remain type-only. */
import type {
	AdminSharedKeyDetail,
	AdminSharedKeysOverview,
	SafeAdminSharedKeyRow,
} from "./shared-key-admin-dto";

export type LegacySharedKeyOperation =
	| "update"
	| "disable"
	| "restore"
	| "delete";
export type LegacySharedKeyMarker = {
	v: 1;
	keyId: string;
	operation: LegacySharedKeyOperation;
};
export type LegacySharedKeyFilters = {
	page: number;
	pageSize: number;
	status: string;
	channelType: string;
	sellerUserId: string;
	search: string;
};
export type LegacySharedKeyStorage = Pick<
	Storage,
	"getItem" | "setItem" | "removeItem"
>;
export type LegacySharedKeyAuditSummary = {
	id: string;
	createdAt: string;
	action: "updated" | "disabled" | "restored" | "deleted";
	before: {
		status: SafeAdminSharedKeyRow["status"];
		sellerPriority: number;
		weight: number;
		validated: boolean;
	};
	after: LegacySharedKeyAuditSummary["before"] | null;
};
const statuses = [
	"active",
	"paused",
	"disabled",
	"invalid",
	"validating",
] as const;
const channels = ["openai", "anthropic", "zhipu", "deepseek"] as const;
const failures = [
	"credential_rejected",
	"validation_timeout",
	"validation_unavailable",
	"validation_failed",
	"unsupported_channel",
	"empty_credential",
	"unknown_failure",
] as const;
const revision = /^sha256:[0-9a-f]{64}$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const controls = /[\p{Cc}\p{Cf}]/u;
function invalid(): never {
	throw new Error("Invalid Shared Key browser contract");
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}
function id(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > 255 ||
		/[\s/?#\\\p{Cc}\p{Cf}]/u.test(value)
	)
		invalid();
	try {
		encodeURIComponent(value);
	} catch {
		invalid();
	}
	return value;
}
function number(
	value: unknown,
	min = 0,
	max = Number.MAX_SAFE_INTEGER,
	integer = true
): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < min ||
		value > max ||
		(integer && !Number.isSafeInteger(value))
	)
		invalid();
	return value;
}
function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") invalid();
	return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
	if (typeof value !== "string" || !choices.includes(value as T)) invalid();
	return value as T;
}
function instant(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/u.test(value)
	)
		invalid();
	const parsed = new Date(value);
	if (
		!Number.isFinite(parsed.getTime()) ||
		parsed.toISOString().slice(0, 19) !== value.slice(0, 19)
	)
		invalid();
	return value;
}
function text(value: unknown, max: number): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || value.length > max || controls.test(value))
		invalid();
	return value
		.replace(
			/\b(?:enc:v[12]:\S+|Bearer\s+\S+|(?:sk-|sk_|rk_|pk_|AIza|ghp_|gho_|xox[baprs]-)[A-Za-z0-9_./+\-=]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:sha256:)?[a-f0-9]{64})\b/giu,
			"[redacted]"
		)
		.replace(
			/\b(api[_ -]?key|access[_ -]?token|secret|password|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/giu,
			"$1=[redacted]"
		);
}
function capabilities(value: unknown): AdminSharedKeysOverview["capabilities"] {
	const data = record(value);
	return {
		can_write: boolean(data.can_write),
		user_detail: boolean(data.user_detail),
		request_logs: boolean(data.request_logs),
		can_review_earnings: boolean(data.can_review_earnings),
	};
}
function currency(value: Record<string, unknown>) {
	const source = choice(value.currentBillingCurrencySource, [
		"configured",
		"missing",
		"invalid",
	]);
	if (value.currentBillingCurrencyReferenceOnly !== true) invalid();
	const current = value.currentBillingCurrency;
	if (
		source === "configured"
			? typeof current !== "string" || !/^[A-Z]{3}$/u.test(current)
			: current !== null
	)
		invalid();
	return {
		currentBillingCurrency: current as string | null,
		currentBillingCurrencySource: source,
		currentBillingCurrencyReferenceOnly: true as const,
	};
}
/** Reconstruct a whitelist instead of retaining a response object or its raw extras. */
export function legacySharedKeyRow(value: unknown): SafeAdminSharedKeyRow {
	const data = record(value);
	if (
		!revision.test(String(data.profile_revision)) ||
		data.apiKeyMasked !== "••••••••" ||
		data.quoteCurrency !== null ||
		data.quoteCurrencyAvailability !== "legacy_unrecorded" ||
		data.quoteUnit !== "per_million_tokens" ||
		data.earningsCurrency !== "USD" ||
		data.earningsAmountUnit !== "major"
	)
		invalid();
	return {
		id: id(data.id),
		sellerUserId: id(data.sellerUserId),
		sellerEmail: text(data.sellerEmail, 320),
		label: text(data.label, 255),
		channelType: choice(data.channelType, channels),
		status: choice(data.status, statuses),
		sellerPriority: number(data.sellerPriority, -2147483648, 2147483647),
		weight: number(data.weight, 1, 100),
		inputPrice: number(data.inputPrice, 0, Number.MAX_VALUE, false),
		outputPrice: number(data.outputPrice, 0, Number.MAX_VALUE, false),
		cacheReadPrice:
			data.cacheReadPrice === null
				? null
				: number(data.cacheReadPrice, 0, Number.MAX_VALUE, false),
		cacheWritePrice:
			data.cacheWritePrice === null
				? null
				: number(data.cacheWritePrice, 0, Number.MAX_VALUE, false),
		validatedAt: data.validatedAt === null ? null : instant(data.validatedAt),
		lastUsedAt: data.lastUsedAt === null ? null : instant(data.lastUsedAt),
		lastFailureAt:
			data.lastFailureAt === null ? null : instant(data.lastFailureAt),
		createdAt: instant(data.createdAt),
		updatedAt: instant(data.updatedAt),
		servedInputTokens: number(data.servedInputTokens),
		servedOutputTokens: number(data.servedOutputTokens),
		earnedTotal: number(data.earnedTotal, 0, Number.MAX_VALUE, false),
		apiKeyMasked: "••••••••",
		failureCode:
			data.failureCode === null ? null : choice(data.failureCode, failures),
		profile_revision: data.profile_revision as string,
		quoteCurrency: null,
		quoteCurrencyAvailability: "legacy_unrecorded",
		quoteUnit: "per_million_tokens",
		earningsCurrency: "USD",
		earningsAmountUnit: "major",
		statisticsBasis: choice(data.statisticsBasis, [
			"legacy_cached_projection",
			"reviewed_credited_usage",
		]),
	};
}
export function legacySharedKeyOverview(
	value: unknown,
	filters: LegacySharedKeyFilters
): AdminSharedKeysOverview {
	const data = record(value);
	const page = number(data.page, 1, 1_000_000);
	const pageSize = number(data.page_size, 1, 100);
	const total = number(data.total);
	if (
		page !== filters.page ||
		pageSize !== filters.pageSize ||
		!Array.isArray(data.items) ||
		data.items.length > pageSize ||
		total < data.items.length ||
		boolean(data.hasMore) !== page * pageSize < total
	)
		invalid();
	const items = data.items.map(legacySharedKeyRow);
	if (
		new Set(items.map((row) => row.id)).size !== items.length ||
		items.some(
			(row) =>
				(filters.status && row.status !== filters.status) ||
				(filters.channelType && row.channelType !== filters.channelType) ||
				(filters.sellerUserId && row.sellerUserId !== filters.sellerUserId)
		)
	)
		invalid();
	return {
		items,
		total,
		page,
		page_size: pageSize,
		hasMore: data.hasMore as boolean,
		...currency(data),
		capabilities: capabilities(data.capabilities),
	};
}
export function legacySharedKeyDetail(
	value: unknown,
	expected: Pick<SafeAdminSharedKeyRow, "id" | "sellerUserId" | "channelType">
): AdminSharedKeyDetail {
	const data = record(value);
	const row = legacySharedKeyRow(data);
	if (
		row.id !== expected.id ||
		row.sellerUserId !== expected.sellerUserId ||
		row.channelType !== expected.channelType
	)
		invalid();
	return {
		...row,
		...currency(data),
		capabilities: capabilities(data.capabilities),
	};
}
export function legacySharedKeyQuery(filters: LegacySharedKeyFilters): string {
	const query = new URLSearchParams({
		page: String(number(filters.page, 1, 1_000_000)),
		page_size: String(number(filters.pageSize, 1, 100)),
	});
	if (filters.status) query.set("status", choice(filters.status, statuses));
	if (filters.channelType)
		query.set("channelType", choice(filters.channelType, channels));
	if (filters.sellerUserId)
		query.set("seller_user_id", id(filters.sellerUserId));
	if (filters.search) {
		if (
			filters.search.length > 200 ||
			filters.search !== filters.search.trim() ||
			controls.test(filters.search)
		)
			invalid();
		query.set("search", filters.search);
	}
	return `/api/admin/shared-keys/overview?${query}`;
}
export function legacySharedKeySubject(value: unknown): string | null {
	const data = record(value);
	if (
		data.authenticated !== true ||
		data.principalType !== "console" ||
		data.verification !== "verified"
	)
		return null;
	if (
		typeof data.subject !== "string" ||
		!data.subject ||
		data.subject.trim() !== data.subject ||
		data.subject.length > 600 ||
		controls.test(data.subject)
	)
		return null;
	try {
		encodeURIComponent(data.subject);
	} catch {
		return null;
	}
	return data.subject;
}
/** A transport precondition, never an actor field or persistent marker value. */
export function legacySharedKeyHeaders(
	subject: string
): Record<string, string> {
	if (
		legacySharedKeySubject({
			authenticated: true,
			principalType: "console",
			verification: "verified",
			subject,
		}) !== subject
	)
		invalid();
	return {
		"content-type": "application/json",
		"X-CinaToken-Expected-Console-Subject": encodeURIComponent(subject),
	};
}
export async function legacySharedKeyScope(subject: string): Promise<string> {
	if (
		legacySharedKeySubject({
			authenticated: true,
			principalType: "console",
			verification: "verified",
			subject,
		}) !== subject
	)
		invalid();
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(subject)
	);
	return `cinatoken:legacy-shared-governance:v1:${Array.from(
		new Uint8Array(digest),
		(value) => value.toString(16).padStart(2, "0")
	).join("")}`;
}
function marker(value: unknown): LegacySharedKeyMarker {
	const data = record(value);
	if (
		data.v !== 1 ||
		Object.keys(data).length !== 3 ||
		!["v", "keyId", "operation"].every((key) => Object.hasOwn(data, key))
	)
		invalid();
	return {
		v: 1,
		keyId: id(data.keyId),
		operation: choice(data.operation, [
			"update",
			"disable",
			"restore",
			"delete",
		]),
	};
}
export function legacySharedKeyReadMarker(
	storage: LegacySharedKeyStorage,
	scope: string
): LegacySharedKeyMarker | null {
	const raw = storage.getItem(scope);
	if (raw === null) return null;
	if (raw.length > 1024) invalid();
	return marker(JSON.parse(raw) as unknown);
}
export function legacySharedKeyMark(
	storage: LegacySharedKeyStorage,
	scope: string,
	pending: LegacySharedKeyMarker
): void {
	const safe = marker(pending);
	if (legacySharedKeyReadMarker(storage, scope)) invalid();
	storage.setItem(scope, JSON.stringify(safe));
	if (
		JSON.stringify(legacySharedKeyReadMarker(storage, scope)) !==
		JSON.stringify(safe)
	)
		invalid();
}
export function legacySharedKeyClearMarker(
	storage: LegacySharedKeyStorage,
	scope: string,
	pending: LegacySharedKeyMarker
): void {
	if (
		JSON.stringify(legacySharedKeyReadMarker(storage, scope)) !==
		JSON.stringify(marker(pending))
	)
		invalid();
	storage.removeItem(scope);
	if (storage.getItem(scope) !== null) invalid();
}
export function legacySharedKeyWriteBody(
	detail: AdminSharedKeyDetail,
	operation: LegacySharedKeyOperation,
	reason: string,
	priority: string,
	weight: string
): Record<string, string | number> {
	if (
		!detail.capabilities.can_write ||
		!revision.test(detail.profile_revision) ||
		!reason.trim() ||
		reason.length > 600 ||
		controls.test(reason)
	)
		invalid();
	const body: Record<string, string | number> = {
		expected_revision: detail.profile_revision,
		reason: reason.trim(),
	};
	if (operation === "delete") return body;
	if (operation === "disable") {
		if (detail.status === "disabled") invalid();
		body.status = "disabled";
	} else if (operation === "restore") {
		if (detail.status !== "disabled") invalid();
		body.status = "paused";
	} else {
		if (!/^-?(?:0|[1-9]\d*)$/u.test(priority) || !/^[1-9]\d*$/u.test(weight))
			invalid();
		body.sellerPriority = number(Number(priority), -2147483648, 2147483647);
		body.weight = number(Number(weight), 1, 100);
		if (
			body.sellerPriority === detail.sellerPriority &&
			body.weight === detail.weight
		)
			invalid();
	}
	return body;
}
/** Only an authoritative, shape-checked response can automatically clear a marker. */
export function legacySharedKeyWriteResult(
	status: number,
	value: unknown,
	pending: LegacySharedKeyMarker
): "applied" | "unchanged" | "rejected" | "unknown" {
	try {
		const body = record(value);
		if (
			[400, 401, 403, 404, 409, 428].includes(status) &&
			body.success === false
		)
			return "rejected";
		if (status !== 200 || body.success !== true) return "unknown";
		const data = record(body.data);
		if (data.id !== pending.keyId) return "unknown";
		if (pending.operation === "delete")
			return data.deleted === true &&
				typeof data.auditId === "string" &&
				uuid.test(data.auditId)
				? "applied"
				: "unknown";
		if (data.outcome === "unchanged" && data.auditId === null)
			return "unchanged";
		return data.outcome === "applied" &&
			typeof data.auditId === "string" &&
			uuid.test(data.auditId)
			? "applied"
			: "unknown";
	} catch {
		return "unknown";
	}
}
function snapshot(value: unknown): LegacySharedKeyAuditSummary["before"] {
	const data = record(value);
	return {
		status: choice(data.status, statuses),
		sellerPriority: number(data.sellerPriority, -2147483648, 2147483647),
		weight: number(data.weight, 1, 100),
		validated: boolean(data.validated),
	};
}
export function legacySharedKeyAudit(
	value: unknown,
	keyId: string,
	cursor?: string
) {
	const data = record(value);
	if (
		data.page_size !== 20 ||
		!Array.isArray(data.entries) ||
		data.entries.length > 20
	)
		invalid();
	const entries = data.entries.map((value) => {
		const row = record(value);
		const action = choice(row.action, [
			"updated",
			"disabled",
			"restored",
			"deleted",
		]);
		if (
			row.keyId !== keyId ||
			typeof row.id !== "string" ||
			!uuid.test(row.id) ||
			!revision.test(String(row.beforeRevision))
		)
			invalid();
		const before = snapshot(row.before);
		const after = action === "deleted" ? null : snapshot(row.after);
		if (
			action === "deleted"
				? row.after !== null ||
				  row.afterRevision !== null ||
				  row.changeMask !== 8
				: !revision.test(String(row.afterRevision)) ||
				  row.beforeRevision === row.afterRevision ||
				  !after ||
				  row.changeMask !==
						((before.status !== after.status ? 1 : 0) |
							(before.sellerPriority !== after.sellerPriority ? 2 : 0) |
							(before.weight !== after.weight ? 4 : 0)) ||
				  !number(row.changeMask, 1, 7) ||
				  before.validated !== after.validated
		)
			invalid();
		if (
			action === "disabled" &&
			(before.status === "disabled" || after?.status !== "disabled")
		)
			invalid();
		if (
			action === "restored" &&
			(before.status !== "disabled" || after?.status !== "paused")
		)
			invalid();
		if (action === "updated" && before.status !== after?.status) invalid();
		return {
			id: row.id,
			createdAt: instant(row.createdAt),
			action,
			before,
			after,
		};
	});
	if (new Set(entries.map((row) => row.id)).size !== entries.length) invalid();
	const order = (row: { createdAt: string; id: string }) =>
		`${row.createdAt.replace(
			/\.(\d{3,6})Z$/u,
			(_, fraction: string) => `.${fraction.padEnd(6, "0")}Z`
		)}|${row.id}`;
	let boundary: { createdAt: string; id: string } | null = null;
	function decode(raw: unknown): { createdAt: string; id: string } {
		if (
			typeof raw !== "string" ||
			!raw ||
			raw.length > 2048 ||
			!/^[A-Za-z0-9_-]+$/u.test(raw)
		)
			invalid();
		const parsed = record(
			JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(
					Uint8Array.from(
						atob(raw.replaceAll("-", "+").replaceAll("_", "/")),
						(char) => char.charCodeAt(0)
					)
				)
			)
		);
		if (
			parsed.v !== 1 ||
			parsed.key_id !== keyId ||
			Object.keys(parsed).length !== 4 ||
			typeof parsed.id !== "string" ||
			!uuid.test(parsed.id)
		)
			invalid();
		const result = { createdAt: instant(parsed.created_at), id: parsed.id };
		const canonical = btoa(
			String.fromCharCode(
				...new TextEncoder().encode(
					JSON.stringify({
						v: 1,
						key_id: keyId,
						created_at: result.createdAt,
						id: result.id,
					})
				)
			)
		)
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/u, "");
		if (canonical !== raw) invalid();
		return result;
	}
	if (cursor) boundary = decode(cursor);
	for (let index = 0; index < entries.length; index++) {
		if (
			(boundary && order(entries[index]) >= order(boundary)) ||
			(index && order(entries[index - 1]) <= order(entries[index]))
		)
			invalid();
	}
	let nextCursor: string | null = null;
	if (data.next_cursor !== null) {
		const next = decode(data.next_cursor);
		if (entries.length !== 20 || order(next) !== order(entries.at(-1)!))
			invalid();
		nextCursor = data.next_cursor as string;
	}
	return { entries, nextCursor };
}
export function legacySharedKeyCanRecover(
	pending: LegacySharedKeyMarker,
	detail: SafeAdminSharedKeyRow | null,
	auditRead: boolean,
	acknowledged: boolean
): boolean {
	return (
		auditRead &&
		acknowledged &&
		(detail ? detail.id === pending.keyId : pending.operation === "delete")
	);
}
