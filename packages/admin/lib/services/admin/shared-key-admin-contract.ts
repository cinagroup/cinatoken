import {
	isSharedKeyChannelType,
	type AdminSharedKeyAuditCursor,
	type AdminSharedKeyGovernancePatch,
	type AdminSharedKeyListOptions,
	type SharedKeyStatus,
} from "@octafuse/core";
import { hasAdminPermission, type AdminPrincipal } from "@/lib/admin-principal";

const controls = /[\p{Cc}\p{Cf}]/u;
const statuses = [
	"active",
	"paused",
	"disabled",
	"invalid",
	"validating",
] as const;
export const SHARED_KEY_ADMIN_REVISION = /^sha256:[0-9a-f]{64}$/u;
export const SHARED_KEY_ADMIN_UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
// A verified 600-character subject retains both trusted Console identity prefixes.
export const SHARED_KEY_ADMIN_ACTOR_MAX_LENGTH = {
	console: 617,
	api_key: 600,
} as const;

export class SharedKeyAdminError extends Error {
	constructor(
		public readonly status: 400 | 403 | 404 | 409 | 428 | 503,
		public readonly code: string,
		message: string
	) {
		super(message);
	}
}
function invalid(message: string): never {
	throw new SharedKeyAdminError(400, "invalid_shared_key_input", message);
}
export function sharedKeyAdminId(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > 255 ||
		/[\s/?#\\\p{Cc}\p{Cf}]/u.test(value)
	)
		invalid("Invalid shared key or seller ID");
	try {
		encodeURIComponent(value);
	} catch {
		invalid("Invalid shared key or seller ID");
	}
	return value;
}
export function sharedKeyAdminQuery(
	url: string,
	allowed: readonly string[]
): URLSearchParams {
	const query = new URL(url).searchParams;
	for (const name of query.keys())
		if (!allowed.includes(name) || query.getAll(name).length !== 1)
			invalid("Unknown or duplicate query parameter");
	return query;
}
function pageNumber(raw: string | null, fallback: number, max: number): number {
	if (raw === null) return fallback;
	if (
		!/^[1-9]\d*$/u.test(raw) ||
		!Number.isSafeInteger(Number(raw)) ||
		Number(raw) > max
	)
		invalid("Invalid pagination value");
	return Number(raw);
}
export function sharedKeyAdminListQuery(
	url: string,
	legacy = false
): AdminSharedKeyListOptions {
	const query = sharedKeyAdminQuery(
		url,
		legacy
			? ["status", "channelType"]
			: [
					"page",
					"page_size",
					"status",
					"channelType",
					"seller_user_id",
					"search",
			  ]
	);
	const options: AdminSharedKeyListOptions = {
		page: legacy ? 1 : pageNumber(query.get("page"), 1, 1_000_000),
		pageSize: legacy ? 100 : pageNumber(query.get("page_size"), 20, 100),
	};
	const status = query.get("status");
	if (status !== null) {
		if (!(statuses as readonly string[]).includes(status))
			invalid("Invalid status");
		options.status = status as SharedKeyStatus;
	}
	const channelType = query.get("channelType");
	if (channelType !== null) {
		if (!isSharedKeyChannelType(channelType)) invalid("Invalid channelType");
		options.channelType = channelType;
	}
	const seller = query.get("seller_user_id");
	if (seller !== null) options.sellerUserId = sharedKeyAdminId(seller);
	const search = query.get("search");
	if (search !== null) {
		if (
			!search ||
			search !== search.trim() ||
			search.length > 200 ||
			controls.test(search)
		)
			invalid("Invalid search");
		options.search = search;
	}
	return options;
}

/** JSON.parse alone silently discards duplicate members, including escaped names. */
export function sharedKeyAdminJson(raw: string): Record<string, unknown> {
	if (new TextEncoder().encode(raw).length > 64 * 1024)
		invalid("JSON body is too large");
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		invalid("Invalid JSON body");
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		invalid("JSON body must be an object");
	const stack: Array<{
		object: boolean;
		expectingKey: boolean;
		keys: Set<string>;
	}> = [];
	for (const token of raw.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/gu) ?? []) {
		if (token === "{" || token === "[") {
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
			if (top.keys.has(name)) invalid("Duplicate JSON member");
			top.keys.add(name);
		}
	}
	return value as Record<string, unknown>;
}

export type SharedKeyAdminWrite = {
	expectedRevision?: string;
	reason: string;
	source: "admin_api" | "legacy_admin";
	patch: AdminSharedKeyGovernancePatch;
	rejectedActive: boolean;
};
export function sharedKeyAdminWriteBody(
	raw: string,
	operation: "update" | "delete",
	requireRevision: boolean
): SharedKeyAdminWrite {
	// Existing DELETE clients have no JSON body. Their server snapshot is still audited.
	const body =
		raw === "" && operation === "delete" ? {} : sharedKeyAdminJson(raw);
	const allowed =
		operation === "update"
			? ["expected_revision", "reason", "sellerPriority", "weight", "status"]
			: ["expected_revision", "reason"];
	if (Object.keys(body).some((key) => !allowed.includes(key)))
		invalid("Unknown JSON field");
	const explicit = Object.hasOwn(body, "expected_revision");
	if (
		explicit &&
		(typeof body.expected_revision !== "string" ||
			!SHARED_KEY_ADMIN_REVISION.test(body.expected_revision))
	)
		invalid("Invalid expected_revision");
	if (!explicit && requireRevision)
		throw new SharedKeyAdminError(
			428,
			"shared_key_revision_required",
			"expected_revision and operator reason are required"
		);
	let reason: string;
	if (Object.hasOwn(body, "reason")) {
		if (
			typeof body.reason !== "string" ||
			!body.reason.trim() ||
			body.reason.length > 600 ||
			controls.test(body.reason)
		)
			invalid(
				"A nonempty operator reason of at most 600 characters is required"
			);
		reason = body.reason.trim();
	} else if (explicit || requireRevision)
		invalid("Operator reason is required");
	else
		reason = `legacy-admin-shared-key-${operation}: server snapshot compatibility`;
	const patch: AdminSharedKeyGovernancePatch = {};
	if (Object.hasOwn(body, "sellerPriority")) {
		if (
			typeof body.sellerPriority !== "number" ||
			!Number.isInteger(body.sellerPriority) ||
			body.sellerPriority < -2147483648 ||
			body.sellerPriority > 2147483647
		)
			invalid("sellerPriority must be an int32");
		patch.sellerPriority = body.sellerPriority;
	}
	if (Object.hasOwn(body, "weight")) {
		if (
			typeof body.weight !== "number" ||
			!Number.isInteger(body.weight) ||
			body.weight < 1 ||
			body.weight > 100
		)
			invalid("weight must be 1-100");
		patch.weight = body.weight;
	}
	let rejectedActive = false;
	if (Object.hasOwn(body, "status")) {
		if (body.status === "active") rejectedActive = true;
		else if (body.status === "disabled" || body.status === "paused")
			patch.status = body.status;
		else invalid("status must be disabled or paused");
	}
	if (
		operation === "update" &&
		!rejectedActive &&
		Object.keys(patch).length === 0
	)
		invalid("Nothing to update");
	return {
		expectedRevision: explicit ? (body.expected_revision as string) : undefined,
		reason,
		source: explicit ? "admin_api" : "legacy_admin",
		patch,
		rejectedActive,
	};
}

export function sharedKeyAdminActor(principal: AdminPrincipal, write: boolean) {
	if (
		!principal ||
		typeof principal.id !== "string" ||
		!principal.id ||
		principal.id.length > SHARED_KEY_ADMIN_ACTOR_MAX_LENGTH[principal.type] ||
		controls.test(principal.id) ||
		(principal.type === "console"
			? !principal.id.startsWith("console:") || principal.id === "console:"
			: principal.type !== "api_key" ||
			  typeof principal.keyId !== "string" ||
			  !principal.keyId ||
			  principal.id !== `admin_key:${principal.keyId}`)
	) {
		throw new SharedKeyAdminError(
			403,
			"shared_key_trusted_actor_required",
			"A trusted named Admin principal is required"
		);
	}
	if (
		!hasAdminPermission(principal, write ? "providers.write" : "providers.read")
	)
		throw new SharedKeyAdminError(
			403,
			"shared_key_permission_required",
			"Forbidden"
		);
	return { actorKind: principal.type, actorId: principal.id } as const;
}
export function sharedKeyAdminCapabilities(principal: AdminPrincipal) {
	return {
		can_write: hasAdminPermission(principal, "providers.write"),
		user_detail: hasAdminPermission(principal, "users.read"),
		request_logs: hasAdminPermission(principal, "logs.read"),
		can_review_earnings: hasAdminPermission(principal, "users.write"),
	};
}

/** Preserve microseconds for SQL keyset pagination, rejecting normalized invalid days. */
export function sharedKeyAdminCursorInstant(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/u.test(value)
	)
		invalid("Invalid audit cursor time");
	const date = new Date(value);
	if (
		!Number.isFinite(date.getTime()) ||
		date.toISOString().slice(0, 19) !== value.slice(0, 19)
	)
		invalid("Invalid audit cursor time");
	return value;
}
export function encodeSharedKeyAdminCursor(
	keyId: string,
	before: AdminSharedKeyAuditCursor
): string {
	const json = JSON.stringify({
		v: 1,
		key_id: keyId,
		created_at: sharedKeyAdminCursorInstant(before.createdAt),
		id: before.id,
	});
	return btoa(String.fromCharCode(...new TextEncoder().encode(json)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}
export function sharedKeyAdminAuditQuery(
	url: string,
	keyId: string
): { pageSize: number; before?: AdminSharedKeyAuditCursor } {
	const query = sharedKeyAdminQuery(url, ["page_size", "cursor"]);
	const pageSize = pageNumber(query.get("page_size"), 20, 100);
	const raw = query.get("cursor");
	if (raw === null) return { pageSize };
	if (!raw || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(raw))
		invalid("Invalid audit cursor");
	try {
		const bytes = Uint8Array.from(
			atob(raw.replaceAll("-", "+").replaceAll("_", "/")),
			(char) => char.charCodeAt(0)
		);
		const parsed: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes)
		);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			invalid("Invalid audit cursor");
		const value = parsed as Record<string, unknown>;
		if (
			Object.keys(value).length !== 4 ||
			!["v", "key_id", "created_at", "id"].every((key) =>
				Object.hasOwn(value, key)
			) ||
			value.v !== 1 ||
			value.key_id !== keyId ||
			typeof value.id !== "string" ||
			!SHARED_KEY_ADMIN_UUID.test(value.id)
		)
			invalid("Invalid audit cursor");
		const before = {
			createdAt: sharedKeyAdminCursorInstant(value.created_at),
			id: value.id,
		};
		if (encodeSharedKeyAdminCursor(keyId, before) !== raw)
			invalid("Invalid audit cursor");
		return { pageSize, before };
	} catch {
		invalid("Invalid audit cursor");
	}
}
