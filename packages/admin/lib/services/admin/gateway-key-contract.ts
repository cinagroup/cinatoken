import { hashLookupKey } from "@octafuse/core";
import { AdminServiceError, badRequest, conflict } from "./errors";

export const GATEWAY_KEY_METADATA_LIMIT = 64 * 1024;
const encoder = new TextEncoder();
const has = (value: object, key: string) =>
	Object.prototype.hasOwnProperty.call(value, key);

export function keyBody(
	value: unknown,
	fields: readonly string[]
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw badRequest("Body must be a JSON object");
	for (const key of Object.keys(value)) {
		if (!fields.includes(key))
			throw badRequest(
				`Field ${key} is not allowed on keys${
					[
						"budget_max",
						"budget_base",
						"budget_spent",
						"budget_period",
						"reset_budget",
						"budget_reset_at",
						"user_email",
					].includes(key)
						? "; use PATCH /admin/users/:id"
						: ""
				}`
			);
	}
	return value as Record<string, unknown>;
}

export function keyText(value: unknown, field: string, max = 600): string {
	if (
		typeof value !== "string" ||
		value.trim() !== value ||
		!value ||
		value.length > max ||
		/[\u0000-\u0020\u007f]/u.test(value)
	) {
		throw badRequest(`Invalid ${field}`);
	}
	return value;
}

/** Keep historical sk- lookup and opaque owner IDs, but reject whitespace/control/path delimiters. */
export function keyId(value: unknown, field = "id"): string {
	const text = keyText(
		value,
		field,
		field === "id"
			? typeof value === "string" && value.startsWith("sk-")
				? 4096
				: 255
			: 600
	);
	if (/[/?#\\]/u.test(text)) throw badRequest(`Invalid ${field}`);
	return text;
}

export function keyName(value: unknown): string | null {
	if (value === null) return null;
	if (
		typeof value !== "string" ||
		value.length > 255 ||
		/[\u0000-\u001f\u007f]/u.test(value)
	)
		throw badRequest("Invalid name");
	return value.trim();
}

export function keyReason(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "string" ||
		value.length > 1000 ||
		/[\u0000-\u001f\u007f]/u.test(value)
	)
		throw badRequest("Invalid reason");
	return value.trim() || undefined;
}

export function keyStatus(value: unknown): string {
	if (
		typeof value !== "string" ||
		!["active", "disabled", "revoked"].includes(value)
	)
		throw badRequest("Invalid status; allowed: active, disabled, revoked");
	return value;
}

export function keyMetadata(value: unknown): string | null {
	if (value === null || value === "") return null;
	let parsed: unknown = value;
	if (typeof value === "string") {
		if (encoder.encode(value).length > GATEWAY_KEY_METADATA_LIMIT)
			throw badRequest("metadata exceeds 64 KiB");
		try {
			parsed = JSON.parse(value);
		} catch {
			throw badRequest("metadata must be a JSON object");
		}
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw badRequest("metadata must be a JSON object");
	validateMetadataValue(parsed, 0, new Set());
	let serialized: string;
	try {
		serialized = typeof value === "string" ? value : JSON.stringify(parsed);
	} catch {
		throw badRequest("metadata must be JSON-serializable");
	}
	if (encoder.encode(serialized).length > GATEWAY_KEY_METADATA_LIMIT)
		throw badRequest("metadata exceeds 64 KiB");
	return serialized;
}

function validateMetadataValue(
	value: unknown,
	depth: number,
	seen: Set<object>
): void {
	if (depth > 16) throw badRequest("metadata exceeds maximum depth");
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return;
	if (typeof value === "number" && Number.isFinite(value)) return;
	if (!value || typeof value !== "object" || seen.has(value))
		throw badRequest("metadata contains a non-JSON value");
	if (
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) !== Object.prototype &&
		Object.getPrototypeOf(value) !== null
	)
		throw badRequest("metadata contains a non-JSON object");
	const keys = Object.keys(value);
	if (
		keys.length > 1000 ||
		keys.some((key) => ["__proto__", "prototype", "constructor"].includes(key))
	)
		throw badRequest("metadata contains invalid fields");
	seen.add(value);
	for (const key of keys)
		validateMetadataValue(
			(value as Record<string, unknown>)[key],
			depth + 1,
			seen
		);
	seen.delete(value);
}

export function keyMetadataProjection(raw: string | null) {
	if (raw === null || raw === "")
		return {
			metadata_raw: raw,
			metadata_unavailable: false,
			metadata_preview: null,
			metadata: undefined,
		};
	if (encoder.encode(raw).length <= GATEWAY_KEY_METADATA_LIMIT) {
		try {
			const value: unknown = JSON.parse(raw);
			if (value && typeof value === "object" && !Array.isArray(value)) {
				validateMetadataValue(value, 0, new Set());
				return {
					metadata_raw: raw,
					metadata_unavailable: false,
					metadata_preview: JSON.stringify({
						field_count: Object.keys(value).length,
					}),
					metadata: value as Record<string, unknown>,
				};
			}
		} catch {
			/* Legacy malformed/scalar metadata must never be silently overwritten. */
		}
	}
	return {
		metadata_raw: null,
		metadata_unavailable: true,
		metadata_preview: null,
		metadata: undefined,
	};
}

export function safeGatewayKeyPreview(_value: string): string {
	// Repository legacy projections may trust storedPreview. It has no provenance,
	// so even a string shaped like a preview could be a complete historical secret.
	return "sk-…";
}

export async function gatewayKeyRevision(row: {
	id: string;
	user_id: string;
	workspace_id: string;
	name: string | null;
	status: string;
	metadata: string | null;
}): Promise<string> {
	return hashLookupKey(
		JSON.stringify([
			"gateway-key-profile-v1",
			row.id,
			row.user_id,
			row.workspace_id,
			row.name,
			row.status,
			row.metadata,
		])
	);
}

export async function requireGatewayKeyRevision(
	row: Parameters<typeof gatewayKeyRevision>[0],
	expected: unknown,
	required: boolean
): Promise<void> {
	if (expected === undefined) {
		if (required)
			throw new AdminServiceError(428, "expected_revision is required");
		return;
	}
	if (typeof expected !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(expected))
		throw badRequest("Invalid expected_revision");
	if (expected !== (await gatewayKeyRevision(row)))
		throw conflict("Key profile changed; reload before editing");
}

export function keyPage(
	value: unknown,
	field: string,
	fallback: number,
	max: number
): number {
	if (value === undefined) return fallback;
	if (
		(typeof value !== "number" &&
			(typeof value !== "string" || !/^[1-9]\d*$/u.test(value))) ||
		!Number.isSafeInteger(Number(value)) ||
		Number(value) < 1 ||
		Number(value) > max
	)
		throw badRequest(`Invalid ${field}`);
	return Number(value);
}

export function keyQuery(
	url: string,
	fields: readonly string[]
): URLSearchParams {
	const params = new URL(url).searchParams;
	for (const field of params.keys())
		if (!fields.includes(field) || params.getAll(field).length !== 1)
			throw badRequest("Unknown or duplicate query parameter");
	return params;
}

export function assertMetadataEditable(
	raw: string | null,
	input: object
): void {
	if (
		(has(input, "metadata") || has(input, "metadata_replace")) &&
		keyMetadataProjection(raw).metadata_unavailable
	)
		throw badRequest(
			"Existing metadata is unavailable; metadata cannot be edited"
		);
}
