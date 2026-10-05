import type { GatewayRepositories, RequestLogRow } from "@octafuse/core";
import { hasAdminPermission, type AdminPrincipal } from "@/lib/admin-principal";
import { AdminServiceError, badRequest, notFound } from "./errors";
import { redactSharedKeyAdminText } from "./shared-key-admin-dto";

const textFields = [
	"user_id",
	"api_key_id",
	"workspace_id",
	"user_email",
	"model_id",
	"model_name",
	"provider_id",
	"provider_name",
	"provider_model_name",
	"provider_key_id",
	"request_protocol",
	"request_operation",
	"upstream_protocol",
	"upstream_operation",
	"model_surface_id",
	"route_pool_id",
	"route_target_id",
	"adapter",
	"route_group",
	"upstream_request_id",
	"upstream_message_id",
	"billing_kind",
] as const;
const countFields = [
	"reasoning_tokens",
	"total_tokens",
	"input_image_count",
	"output_image_count",
	"upstream_attempt_count",
	"upstream_failover_count",
	"audio_characters",
] as const;
const durationFields = [
	"latency_ms",
	"gateway_overhead_ms",
	"upstream_response_ms",
	"final_upstream_headers_ms",
	"first_reasoning_token_ms",
	"first_token_ms",
	"stream_duration_ms",
	"audio_duration_seconds",
] as const;
export type SafeAdminRequestLogDetail = {
	id: string;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	metered_cost: number;
	charged_cost: number;
	status: string;
	created_at: string;
	standard_cost?: number;
} & Partial<Record<(typeof textFields)[number], string | null>> &
	Partial<
		Record<
			(typeof countFields)[number] | (typeof durationFields)[number],
			number | null
		>
	>;

export function adminRequestLogId(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > 255 ||
		/[\s/?#\\\p{Cc}\p{Cf}]/u.test(value) ||
		/^(?:sk-|enc:v[12]:|sha256:)/u.test(value)
	)
		throw badRequest("Invalid request log ID");
	try {
		encodeURIComponent(value);
	} catch {
		throw badRequest("Invalid request log ID");
	}
	return value;
}
function malformed(): never {
	throw new Error("Invalid stored request log detail");
}
function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		malformed();
	return value;
}
function numeric(value: unknown): number {
	if (
		typeof value === "string" &&
		value.length <= 40 &&
		/^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(value)
	)
		value = Number(value);
	if (typeof value !== "number" || !Number.isFinite(value)) malformed();
	return value;
}
function createdAt(value: unknown): string {
	if (value instanceof Date) {
		if (!Number.isFinite(value.getTime())) malformed();
		return value.toISOString();
	}
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/u.test(
			value
		)
	)
		malformed();
	const normalized = value.replace(" ", "T");
	const calendar = new Date(`${normalized.slice(0, 19)}.000Z`);
	if (
		!Number.isFinite(calendar.getTime()) ||
		calendar.toISOString().slice(0, 19) !== normalized.slice(0, 19)
	)
		malformed();
	const zoned = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(normalized)
		? normalized.replace(/([+-]\d{2})$/u, "$1:00")
		: `${normalized}Z`;
	const parsed = new Date(zoned);
	if (!Number.isFinite(parsed.getTime())) malformed();
	return parsed.toISOString();
}

/** Explicit projection: body, traces, raw error/usage, pricing, headers and fingerprints never leave this endpoint. */
export function projectAdminRequestLogDetail(
	row: RequestLogRow,
	expectedId: string
): SafeAdminRequestLogDetail {
	if (row.id !== expectedId) malformed();
	const source = row as unknown as Record<string, unknown>;
	const material =
		typeof source.provider_key_fingerprint === "string"
			? [source.provider_key_fingerprint]
			: [];
	if (typeof row.status !== "string" || !row.status || row.status.length > 2000)
		malformed();
	const result: SafeAdminRequestLogDetail = {
		id: expectedId,
		input_tokens: count(row.input_tokens),
		output_tokens: count(row.output_tokens),
		cache_read_tokens: count(row.cache_read_tokens),
		cache_write_tokens: count(row.cache_write_tokens),
		metered_cost: numeric(row.metered_cost),
		charged_cost: numeric(row.charged_cost),
		status: redactSharedKeyAdminText(row.status, material, 2000),
		created_at: createdAt(row.created_at),
	};
	if (source.standard_cost !== undefined)
		result.standard_cost = numeric(source.standard_cost);
	for (const field of textFields) {
		const value = source[field];
		if (value === undefined) continue;
		if (value !== null && typeof value !== "string") malformed();
		result[field] =
			value === null ? null : redactSharedKeyAdminText(value, material, 2000);
	}
	for (const field of countFields) {
		const value = source[field];
		if (value === undefined) continue;
		if (
			value === null &&
			![
				"upstream_attempt_count",
				"upstream_failover_count",
				"audio_characters",
			].includes(field)
		)
			malformed();
		result[field] = value === null ? null : count(value);
	}
	for (const field of durationFields) {
		const value = source[field];
		if (value === undefined) continue;
		if (value === null) result[field] = null;
		else {
			const duration = numeric(value);
			if (duration < 0) malformed();
			result[field] = duration;
		}
	}
	return result;
}
export async function getAdminRequestLogDetailService(
	repos: GatewayRepositories,
	principal: AdminPrincipal,
	rawId: string,
	url: string
): Promise<SafeAdminRequestLogDetail> {
	if (!principal || !hasAdminPermission(principal, "logs.read"))
		throw new AdminServiceError(403, "Forbidden");
	const id = adminRequestLogId(rawId);
	if ([...new URL(url).searchParams.keys()].length !== 0)
		throw badRequest("Request log detail does not accept query parameters");
	const read = repos.requestLogs.getAdminRequestLogById;
	if (typeof read !== "function")
		throw new AdminServiceError(
			503,
			"Exact request log storage is unavailable"
		);
	const row = await read.call(repos.requestLogs, id);
	if (!row) throw notFound("Request log not found");
	return projectAdminRequestLogDetail(row, id);
}
