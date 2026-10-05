import type { GlobalUserAuditLogFilters } from "@octafuse/core";
import {
	USER_AUDIT_ACTOR_KINDS,
	USER_AUDIT_ACTOR_TYPES,
} from "@octafuse/core/db/user-audit-catalog";
import { badRequest } from "./errors";

const multiKeys = [
	"event_type",
	"actor_type",
	"actor_kind",
	"reason_code",
	"source",
] as const;
const textKeys = [
	"user_id",
	"api_key_id",
	"user_email",
	"actor_id",
	"correlation_id",
] as const;
const allowed = new Set([
	...multiKeys,
	...textKeys,
	"start_date",
	"end_date",
	"page",
	"page_size",
]);
const sqlUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/u;
const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const dateOnly = /^\d{4}-\d{2}-\d{2}$/u;
const forbiddenText = /[\p{Cc}\p{Cf}]/u;

export interface BudgetAuditLogQuery {
	filters: GlobalUserAuditLogFilters;
	page: number;
	pageSize: number;
}

function one(
	params: URLSearchParams,
	key: string,
	maxLength: number
): string | undefined {
	const values = params.getAll(key);
	if (!values.length) return undefined;
	if (values.length !== 1) throw badRequest(`Duplicate ${key} filter`);
	const raw = values[0]!;
	const value = raw.trim();
	if (
		!value ||
		raw !== value ||
		value.length > maxLength ||
		forbiddenText.test(value)
	)
		throw badRequest(`Invalid ${key} filter`);
	return value;
}

function multi(
	params: URLSearchParams,
	key: (typeof multiKeys)[number]
): string[] | undefined {
	const raw = params.getAll(key);
	if (!raw.length) return undefined;
	if (raw.length > 100) throw badRequest(`Too many ${key} filters`);
	const values = raw.flatMap((part) =>
		part.split(",").map((value) => value.trim())
	);
	if (
		values.length > 100 ||
		values.some(
			(value) => !value || value.length > 160 || forbiddenText.test(value)
		)
	) {
		throw badRequest(`Invalid ${key} filter`);
	}
	const distinct = [...new Set(values)];
	if (
		key === "actor_kind" &&
		distinct.some((value) => !USER_AUDIT_ACTOR_KINDS.includes(value as never))
	) {
		throw badRequest("Invalid actor_kind filter");
	}
	if (
		key === "actor_type" &&
		distinct.some((value) => !USER_AUDIT_ACTOR_TYPES.includes(value as never))
	) {
		throw badRequest("Invalid actor_type filter");
	}
	return distinct;
}

function utcDate(
	params: URLSearchParams,
	key: "start_date" | "end_date"
): string | undefined {
	const value = one(params, key, 32);
	if (!value) return undefined;
	if (dateOnly.test(value)) {
		const instant = new Date(`${value}T00:00:00Z`);
		if (
			Number.isNaN(instant.getTime()) ||
			instant.toISOString().slice(0, 10) !== value
		)
			throw badRequest(`Invalid ${key}`);
		if (key === "start_date") return `${value} 00:00:00`;
		const next = new Date(instant.getTime() + 86_400_000).toISOString();
		if (!/^\d{4}-/u.test(next)) throw badRequest(`Invalid ${key}`);
		return next.slice(0, 19).replace("T", " ");
	}
	if (!sqlUtc.test(value) && !isoUtc.test(value))
		throw badRequest(`Invalid ${key}`);
	const normalized = isoUtc.test(value) ? value : `${value.replace(" ", "T")}Z`;
	const instant = new Date(normalized);
	if (
		Number.isNaN(instant.getTime()) ||
		instant.toISOString().slice(0, 19) !== normalized.slice(0, 19)
	) {
		throw badRequest(`Invalid ${key}`);
	}
	return instant
		.toISOString()
		.replace("T", " ")
		.replace(/\.000Z$/u, "")
		.replace(/Z$/u, "");
}

function positiveInt(
	params: URLSearchParams,
	key: "page" | "page_size",
	fallback: number,
	max: number
): number {
	const value = one(params, key, 12);
	if (!value) return fallback;
	if (!/^[1-9]\d*$/u.test(value)) throw badRequest(`Invalid ${key}`);
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number > max)
		throw badRequest(`Invalid ${key}`);
	return number;
}

/** The list and CSV endpoint share one fail-closed interpretation of all filters. */
export function parseBudgetAuditLogQuery(
	params: URLSearchParams,
	mode: "list" | "export"
): BudgetAuditLogQuery {
	if ([...params].length > 200) throw badRequest("Too many audit filters");
	for (const key of params.keys()) {
		if (
			!allowed.has(key) ||
			(mode === "export" && (key === "page" || key === "page_size"))
		) {
			throw badRequest(`Unsupported audit filter: ${key}`);
		}
	}
	const eventTypes = multi(params, "event_type");
	const actorTypes = multi(params, "actor_type");
	const actorKinds = multi(params, "actor_kind");
	const reasonCodes = multi(params, "reason_code");
	const sources = multi(params, "source");
	const startDate = utcDate(params, "start_date");
	const endDate = utcDate(params, "end_date");
	if (startDate && endDate && startDate > endDate)
		throw badRequest("start_date must not exceed end_date");
	return {
		filters: {
			userId: one(params, "user_id", 600),
			apiKeyId: one(params, "api_key_id", 600),
			userEmail: one(params, "user_email", 320),
			actorId: one(params, "actor_id", 600),
			correlationId: one(params, "correlation_id", 600),
			eventTypes,
			actorTypes,
			actorKinds,
			reasonCodes,
			sources,
			startDate,
			endDate,
			endDateExclusive:
				dateOnly.test(params.get("end_date") ?? "") || undefined,
		},
		page: mode === "list" ? positiveInt(params, "page", 1, 1_000_000) : 1,
		pageSize: mode === "list" ? positiveInt(params, "page_size", 20, 100) : 100,
	};
}
