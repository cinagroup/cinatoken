/**
 * 管理路由：`/admin/keys` — API 密钥列表（分页、邮箱、`user_id`）、
 * 创建、查询、更新（仅 name/metadata/status）、吊销墓碑及单 key 请求日志。全程要求 Admin principal。
 */
import { Hono } from "hono";
import { parseApiKeyListSortQuery } from "@octafuse/core/db/api-keys-list-sort";
import type { AdminEnv } from "@/lib/admin-env";
import { requireAdminPrincipal } from "@/lib/middleware/admin-auth";
import { hasAdminPermission } from "@/lib/admin-principal";
import { filterAllowedRequestLogStatuses } from "@octafuse/core/db/request-log-status-filter";
import {
	keyBody,
	keyId,
	keyPage,
	keyQuery,
} from "@/lib/services/admin/gateway-key-contract";
import { badRequest } from "@/lib/services/admin/errors";
import {
	createAdminKey,
	deleteAdminKey,
	getAdminKeyById,
	getAdminKeyLogs,
	listAdminKeys,
	scrubLegacyGatewayKeySecrets,
	updateAdminKey,
} from "@/lib/services/admin/keys-service";
import type {
	AdminKeyCreateInput,
	AdminKeyUpdateInput,
} from "@/lib/services/admin/types";
import { handleAdminRouteError, jsonErr } from "./error-response";
import { normalizeApiTimeFields } from "@octafuse/core/lib/time-format";
import {
	SimulatorKeyVerificationError,
	verifySimulatorKeyBinding,
} from "@/lib/services/admin/simulator-key-verification";
import {
	assertExpectedConsoleSubject,
	ExpectedConsoleSubjectError,
	EXPECTED_CONSOLE_SUBJECT_HEADER,
} from "@/lib/services/admin/expected-console-subject";
export const adminKeysRoutes = new Hono<AdminEnv>();

adminKeysRoutes.use("*", requireAdminPrincipal);

/** Compare a locally supplied secret with the selected immutable Key; never reveal or mint one. */
adminKeysRoutes.post("/:id/verify-secret", async (c) => {
	c.header("Cache-Control", "private, no-store");
	const principal = c.get("principal");
	if (!hasAdminPermission(principal, "user_keys.read"))
		return c.json(
			{
				success: false,
				message: "Forbidden",
				required_permission: "user_keys.read",
			},
			403
		);
	try {
		assertExpectedConsoleSubject(
			principal,
			c.req.header(EXPECTED_CONSOLE_SUBJECT_HEADER),
			true
		);
		if (new URL(c.req.url).search)
			throw new SimulatorKeyVerificationError(
				400,
				"invalid_simulator_key_binding"
			);
		let input: unknown;
		try {
			input = await c.req.json();
		} catch {
			throw new SimulatorKeyVerificationError(
				400,
				"invalid_simulator_key_binding"
			);
		}
		const data = await verifySimulatorKeyBinding(
			c.get("repositories"),
			c.req.param("id"),
			input
		);
		return c.json({ success: true, data });
	} catch (error) {
		if (
			error instanceof SimulatorKeyVerificationError ||
			error instanceof ExpectedConsoleSubjectError
		)
			return c.json(
				{ success: false, code: error.code, message: error.message },
				error.status
			);
		// Storage errors can contain bind values. Never log or return this secret-bearing request.
		return c.json(
			{
				success: false,
				code: "simulator_key_binding_unavailable",
				message: "Gateway Key binding could not be verified",
			},
			503
		);
	}
});

function pageQuery(url: string, fields: readonly string[]) {
	const query = keyQuery(url, fields);
	return {
		query,
		page: keyPage(query.get("page") ?? undefined, "page", 1, 1_000_000),
		page_size: keyPage(
			query.get("page_size") ?? undefined,
			"page_size",
			20,
			100
		),
	};
}

/** 查询：page、page_size、email、user_id、sort、order。 */
adminKeysRoutes.get("/", async (c) => {
	try {
		const { query, page, page_size } = pageQuery(c.req.url, [
			"page",
			"page_size",
			"email",
			"user_id",
			"sort",
			"order",
		]);
		for (const name of ["sort", "order"])
			if (
				(query.has(name) && query.get(name)?.trim() !== query.get(name)) ||
				query.get(name) === ""
			)
				throw badRequest(`Invalid ${name}`);
		const sortParsed = parseApiKeyListSortQuery(
			query.get("sort") ?? undefined,
			query.get("order") ?? undefined
		);
		if (!sortParsed.ok) {
			return jsonErr(c, 400, sortParsed.message);
		}
		const repos = c.get("repositories");
		const result = await listAdminKeys(repos, {
			page,
			page_size,
			email: query.get("email") ?? undefined,
			user_id: query.get("user_id") ?? undefined,
			sort: sortParsed.value.sort,
			order: sortParsed.value.order,
		});
		const principal = c.get("principal");
		return c.json(
			normalizeApiTimeFields({
				success: true as const,
				...result,
				capabilities: {
					user_detail: hasAdminPermission(principal, "users.read"),
					request_logs: hasAdminPermission(principal, "logs.read"),
					budget_audit: hasAdminPermission(principal, "logs.read"),
					effective_guardrails: hasAdminPermission(
						principal,
						"guardrails.read"
					),
					can_write: hasAdminPermission(principal, "user_keys.write"),
				},
			})
		);
	} catch (error) {
		return handleAdminRouteError(c, error, "Failed to list keys");
	}
});

/** 创建：须 `user_id`，或同时 `external_system` + `external_user_id` + `email`（新建用户时邮箱必填）。 */
adminKeysRoutes.post("/", async (c) => {
	let body: AdminKeyCreateInput;
	try {
		body = await c.req.json();
	} catch {
		return jsonErr(c, 400, "Invalid JSON body");
	}
	try {
		keyQuery(c.req.url, []);
		const repos = c.get("repositories");
		const result = await createAdminKey(repos, body, c.get("principal").id);
		return c.json(
			normalizeApiTimeFields({
				success: true as const,
				message: "Key created successfully",
				data: result,
			})
		);
	} catch (error) {
		return handleAdminRouteError(c, error, "Failed to create key");
	}
});

/** 分批清除历史 Gateway Key 明文；幂等，可重复调用直至 remaining=0。 */
adminKeysRoutes.post("/maintenance/scrub-legacy-secrets", async (c) => {
	try {
		keyQuery(c.req.url, []);
		const text = await c.req.text();
		let parsed: unknown = {};
		if (text) {
			try {
				parsed = JSON.parse(text);
			} catch {
				throw badRequest("Invalid JSON body");
			}
		}
		const body = keyBody(parsed, ["limit"]);
		const limit = keyPage(body.limit, "limit", 100, 1000);
		const data = await scrubLegacyGatewayKeySecrets(
			c.get("repositories"),
			limit
		);
		return c.json({ success: true as const, data });
	} catch (error) {
		return handleAdminRouteError(
			c,
			error,
			"Failed to scrub legacy key secrets"
		);
	}
});

/** `:id` 可为 uuid 或 `sk-…`；查询 page、page_size、exclude_status、include_statuses（逗号分隔，优先于 exclude_status）。 */
adminKeysRoutes.get("/:id/logs", async (c) => {
	try {
		keyId(c.req.param("id"));
		const { query, page, page_size } = pageQuery(c.req.url, [
			"page",
			"page_size",
			"exclude_status",
			"include_statuses",
		]);
		const includeRaw = query.get("include_statuses") ?? undefined;
		const exclude = query.get("exclude_status") ?? undefined;
		if (includeRaw !== undefined) {
			const statuses = includeRaw.split(",");
			if (
				!statuses.length ||
				statuses.some(
					(s) => filterAllowedRequestLogStatuses([s]).length !== 1
				) ||
				new Set(statuses).size !== statuses.length
			)
				throw badRequest("Invalid include_statuses");
		}
		if (
			exclude !== undefined &&
			filterAllowedRequestLogStatuses([exclude]).length !== 1
		)
			throw badRequest("Invalid exclude_status");
		const repos = c.get("repositories");
		const result = await getAdminKeyLogs(repos, c.req.param("id"), {
			page,
			page_size,
			exclude_status: exclude,
			include_statuses: includeRaw !== undefined ? includeRaw : undefined,
		});
		return c.json(
			normalizeApiTimeFields({
				success: true as const,
				data: result.logs,
				total: result.total,
				page: result.page,
				page_size: result.page_size,
			})
		);
	} catch (error) {
		return handleAdminRouteError(c, error, "Failed to get key logs");
	}
});

/** 部分更新 name、metadata、status（预算见 `/admin/users`）。 */
adminKeysRoutes.patch("/:id", async (c) => {
	let body: AdminKeyUpdateInput;
	try {
		body = await c.req.json();
	} catch {
		return jsonErr(c, 400, "Invalid JSON body");
	}
	try {
		keyQuery(c.req.url, []);
		const repos = c.get("repositories");
		const data = await updateAdminKey(
			repos,
			c.req.param("id"),
			body,
			c.get("principal").id,
			c.env.CINATOKEN_ADMIN_KEYS_REQUIRE_REVISION === "true"
		);
		return c.json(
			normalizeApiTimeFields({
				success: true as const,
				message: "Key updated successfully",
				data,
			})
		);
	} catch (error) {
		return handleAdminRouteError(c, error, "Failed to update key");
	}
});

adminKeysRoutes.get("/:id", async (c) => {
	try {
		keyQuery(c.req.url, []);
		const repos = c.get("repositories");
		const data = await getAdminKeyById(repos, c.req.param("id"));
		return c.json(normalizeApiTimeFields({ success: true as const, data }));
	} catch (error) {
		return handleAdminRouteError(c, error, "Failed to get key");
	}
});

/** DELETE 语义为吊销并保留审计墓碑。 */
adminKeysRoutes.delete("/:id", async (c) => {
	try {
		keyQuery(c.req.url, []);
		const text = await c.req.text();
		let body: { expected_revision?: string; reason?: string } = {};
		if (text) {
			try {
				body = JSON.parse(text);
			} catch {
				throw badRequest("Invalid JSON body");
			}
		}
		const repos = c.get("repositories");
		const data = await deleteAdminKey(
			repos,
			c.req.param("id"),
			c.get("principal").id,
			body,
			c.env.CINATOKEN_ADMIN_KEYS_REQUIRE_REVISION === "true"
		);
		return c.json(
			normalizeApiTimeFields({
				success: true as const,
				message: "Key revoked and retained as an audit tombstone",
				data,
			})
		);
	} catch (error) {
		return handleAdminRouteError(c, error, "Failed to delete key");
	}
});
