import type {
	GatewayRepositories,
	GlobalUserAuditLogFilters,
	UserAuditLogCursor,
	UserAuditLogExportData,
} from "@octafuse/core";
import { normalizeApiTimeString } from "@octafuse/core/lib/time-format";
import { AdminServiceError } from "./errors";

interface ExportLimits {
	maxRows: number;
	maxBytes: number;
	maxMs: number;
	batchSize: number;
}
export const BUDGET_AUDIT_EXPORT_LIMITS: Readonly<ExportLimits> = Object.freeze(
	{ maxRows: 5_000, maxBytes: 8 * 1024 * 1024, maxMs: 20_000, batchSize: 100 }
);

const headers = [
	"audit_id",
	"created_at_utc",
	"request_log_id",
	"correlation_id",
	"event_type",
	"source",
	"reason_code",
	"reason_text",
	"actor_type",
	"actor_id",
	"user_id",
	"user_email",
	"api_key_id",
	"before_snapshot_state",
	"after_snapshot_state",
	"before_budget_max_state",
	"before_budget_max_currency_unknown",
	"after_budget_max_state",
	"after_budget_max_currency_unknown",
	"before_spent_currency_unknown",
	"after_spent_currency_unknown",
	"delta_spent_currency_unknown",
	"before_budget_base_currency_unknown",
	"after_budget_base_currency_unknown",
	"before_budget_period",
	"after_budget_period",
	"before_budget_reset_at_utc",
	"after_budget_reset_at_utc",
	"historical_currency",
] as const;

type Snapshot = {
	state: "present" | "missing" | "invalid";
	fields: Record<string, unknown> | null;
};

function snapshot(raw: string | null): Snapshot {
	if (raw === null || raw.trim() === "")
		return { state: "missing", fields: null };
	try {
		const value: unknown = JSON.parse(raw);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return { state: "present", fields: value as Record<string, unknown> };
		}
	} catch {
		/* malformed historical snapshot */
	}
	return { state: "invalid", fields: null };
}

function amount(fields: Record<string, unknown> | null, key: string): string {
	if (!fields || !Object.hasOwn(fields, key)) return "";
	const value = fields[key];
	if (typeof value === "number")
		return Number.isFinite(value) && Number.isSafeInteger(Math.trunc(value))
			? String(value)
			: "";
	if (
		typeof value === "string" &&
		/^-?\d+(?:\.\d+)?$/u.test(value) &&
		Number.isFinite(Number(value))
	)
		return value;
	return "";
}

function subtractMoney(after: string, before: string): string {
	const micros = (value: string): bigint | null => {
		const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/u.exec(value);
		if (!match) return null;
		const amount =
			BigInt(match[2]!) * 1_000_000n + BigInt((match[3] ?? "").padEnd(6, "0"));
		return match[1] === "-" ? -amount : amount;
	};
	const afterMicros = micros(after);
	const beforeMicros = micros(before);
	if (afterMicros === null || beforeMicros === null) return "";
	const difference = afterMicros - beforeMicros;
	const absolute = difference < 0n ? -difference : difference;
	const whole = absolute / 1_000_000n;
	const fractional = (absolute % 1_000_000n)
		.toString()
		.padStart(6, "0")
		.replace(/0+$/u, "");
	return `${difference < 0n ? "-" : ""}${whole}${
		fractional ? `.${fractional}` : ""
	}`;
}

function budgetMax(
	fields: Record<string, unknown> | null,
	snapshotState: Snapshot["state"]
): [string, string] {
	if (snapshotState !== "present")
		return [
			snapshotState === "missing" ? "missing_snapshot" : "invalid_snapshot",
			"",
		];
	if (!fields || !Object.hasOwn(fields, "budget_max"))
		return ["missing_field", ""];
	if (fields.budget_max === null || fields.budget_max === "null")
		return ["unlimited", ""];
	const value = amount(fields, "budget_max");
	return value ? ["known", value] : ["invalid_field", ""];
}

function resetAtUtc(fields: Record<string, unknown> | null): string {
	const value = fields?.budget_reset_at;
	if (typeof value !== "string" || value === "") return "";
	if (
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
			value
		) &&
		!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)
	)
		return "";
	const normalized = normalizeApiTimeString(value);
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(normalized)
		? normalized
		: "";
}

function utcCreatedAt(value: string): string {
	// MySQL DATETIME(6) and D1 SQL timestamps are UTC wall time without a
	// zone suffix. The shared formatter handles SQL seconds, but fractional SQL
	// text would otherwise be parsed in the host's local time zone.
	const sqlUtc =
		/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/u.exec(value);
	let normalized: string;
	if (sqlUtc) {
		const instant = new Date(
			`${sqlUtc[1]}T${sqlUtc[2]}.${(sqlUtc[3] ?? "").padEnd(3, "0")}Z`
		);
		if (
			Number.isNaN(instant.getTime()) ||
			instant.toISOString().slice(0, 19) !== `${sqlUtc[1]}T${sqlUtc[2]}`
		) {
			throw new AdminServiceError(422, "Invalid audit timestamp in export");
		}
		normalized = instant.toISOString();
	} else {
		normalized = normalizeApiTimeString(value);
	}
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(normalized)) {
		throw new AdminServiceError(422, "Invalid audit timestamp in export");
	}
	return normalized;
}

/** Prevent spreadsheet formula execution in every externally sourced text field. */
function cell(value: string): string {
	const safe =
		/^[\s\uFEFF]*[=+\-@]/u.test(value) || /^[\t\r\n]/u.test(value)
			? `'${value}`
			: value;
	return `"${safe.replaceAll('"', '""')}"`;
}

function csvRow(log: UserAuditLogExportData): string {
	const before = snapshot(log.before_user_snapshot);
	const after = snapshot(log.after_user_snapshot);
	const [beforeMaxState, beforeMax] = budgetMax(before.fields, before.state);
	const [afterMaxState, afterMax] = budgetMax(after.fields, after.state);
	const beforeSpent = amount(before.fields, "budget_spent");
	const afterSpent = amount(after.fields, "budget_spent");
	const deltaSpent =
		beforeSpent && afterSpent ? subtractMoney(afterSpent, beforeSpent) : "";
	const values = [
		log.id,
		utcCreatedAt(log.created_at),
		log.request_log_id,
		log.correlation_id,
		log.event_type,
		log.source,
		log.reason_code,
		log.reason_text,
		log.actor_type,
		log.actor_id,
		log.user_id,
		log.user_email,
		log.api_key_id,
		before.state,
		after.state,
		beforeMaxState,
		beforeMax,
		afterMaxState,
		afterMax,
		beforeSpent,
		afterSpent,
		deltaSpent,
		amount(before.fields, "budget_base"),
		amount(after.fields, "budget_base"),
		typeof before.fields?.budget_period === "string"
			? before.fields.budget_period
			: "",
		typeof after.fields?.budget_period === "string"
			? after.fields.budget_period
			: "",
		resetAtUtc(before.fields),
		resetAtUtc(after.fields),
		"unknown",
	];
	return values.map((value) => cell(value ?? "")).join(",") + "\r\n";
}

interface ExportOptions {
	signal?: AbortSignal;
	now?: () => number;
	limits?: Readonly<ExportLimits>;
}

function isServerCancelledExportQuery(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const failure = error as { code?: unknown; errno?: unknown };
	return (
		failure.code === "ER_QUERY_TIMEOUT" ||
		failure.errno === 3024 ||
		failure.code === "57014"
	);
}

/** Builds the complete bounded file before returning, so errors never send a partial CSV. */
export async function exportAdminGlobalBudgetAuditLogsService(
	repos: GatewayRepositories,
	filters: GlobalUserAuditLogFilters,
	options: ExportOptions = {}
): Promise<string> {
	const limits = options.limits ?? BUDGET_AUDIT_EXPORT_LIMITS;
	const now = options.now ?? Date.now;
	const started = now();
	const encoder = new TextEncoder();
	const chunks = [`\uFEFF${headers.join(",")}\r\n`];
	let bytes = encoder.encode(chunks[0]).byteLength;
	if (bytes > limits.maxBytes)
		throw new AdminServiceError(413, "Audit export byte limit exceeded");
	let rows = 0;
	let after: UserAuditLogCursor | undefined;
	let highWater: UserAuditLogCursor | undefined;
	const check = () => {
		if (options.signal?.aborted)
			throw new AdminServiceError(408, "Audit export cancelled");
		if (now() - started > limits.maxMs)
			throw new AdminServiceError(504, "Audit export time limit exceeded");
	};
	for (;;) {
		check();
		const limit = Math.min(limits.batchSize, limits.maxRows - rows + 1);
		let batch;
		try {
			batch = await repos.userAuditLogs.scanGlobalUserAuditLogsForExport({
				filters,
				limit,
				after,
				highWater,
			});
		} catch (error) {
			if (options.signal?.aborted)
				throw new AdminServiceError(408, "Audit export cancelled");
			if (isServerCancelledExportQuery(error)) {
				throw new AdminServiceError(
					504,
					"Audit export query cancelled or timed out"
				);
			}
			throw error;
		}
		check();
		if (!batch.length) break;
		if (batch.some((entry) => entry.oversized)) {
			throw new AdminServiceError(
				413,
				"Audit export source field limit exceeded"
			);
		}
		highWater ??= batch[0]!.cursor;
		for (const entry of batch) {
			check();
			if (rows === limits.maxRows)
				throw new AdminServiceError(413, "Audit export row limit exceeded");
			const line = csvRow(entry.log);
			bytes += encoder.encode(line).byteLength;
			if (bytes > limits.maxBytes)
				throw new AdminServiceError(413, "Audit export byte limit exceeded");
			chunks.push(line);
			rows += 1;
		}
		const last = batch.at(-1)!.cursor;
		if (after?.createdAt === last.createdAt && after.id === last.id)
			throw new Error("Audit export cursor did not advance");
		after = last;
		if (batch.length < limit) break;
	}
	return chunks.join("");
}
