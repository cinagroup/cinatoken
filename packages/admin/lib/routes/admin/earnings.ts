/**
 * 管理路由：`/admin/earnings` — 共享密钥收益补偿。
 *
 * 收益结算与请求日志不在同一事务（见 core/services/shared-key-earnings）。
 * 旧日志只有 shared key ID 和 token 用量，没有当时的卖家报价、佣金与 owner
 * 快照。对未结算日志按当前配置补算会改变历史金额或将收益付给错误的卖家。
 */
import { Hono } from "hono";
import type { AdminEnv } from "@/lib/admin-env";
import { requireAdminPrincipal } from "@/lib/middleware/admin-auth";
import {
	assertExpectedConsoleSubject,
	EXPECTED_CONSOLE_SUBJECT_HEADER,
	ExpectedConsoleSubjectError,
} from "@/lib/services/admin/expected-console-subject";
import { handleAdminRouteError } from "./error-response";

export const adminEarningsRoutes = new Hono<AdminEnv>();

adminEarningsRoutes.use("*", async (c, next) => {
	await next();
	c.header("Cache-Control", "private, no-store");
});
adminEarningsRoutes.use("*", requireAdminPrincipal);

/** Query-only legacy endpoint: reject ambiguous input before reading any logs. */
function parseReviewQuery(
	url: string
): { since: string; limit: number; apply: boolean } | null {
	const query = new URL(url).searchParams;
	const allowed = new Set(["since", "limit", "apply"]);
	for (const name of query.keys()) {
		if (!allowed.has(name) || query.getAll(name).length !== 1) return null;
	}
	const sinceRaw = query.get("since");
	let since: string;
	if (sinceRaw === null) {
		since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	} else {
		// Preserve exact calendar values; Date.parse alone normalizes invalid days.
		if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(sinceRaw))
			return null;
		const milliseconds = Date.parse(sinceRaw);
		if (!Number.isFinite(milliseconds)) return null;
		since = new Date(milliseconds).toISOString();
		const fraction = sinceRaw.match(/\.(\d{1,3})Z$/u)?.[1] ?? "";
		const canonicalInput = `${sinceRaw.slice(0, 19)}.${fraction.padEnd(
			3,
			"0"
		)}Z`;
		if (canonicalInput !== since) return null;
	}
	const limitRaw = query.get("limit") ?? "200";
	if (!/^[1-9]\d{0,3}$/u.test(limitRaw)) return null;
	const limit = Number(limitRaw);
	if (limit > 1000) return null;
	const applyRaw = query.get("apply") ?? "0";
	if (applyRaw !== "0" && applyRaw !== "1") return null;
	return { since, limit, apply: applyRaw === "1" };
}

/**
 * 扫描时间窗内由 `sharedkey:` 服务的旧请求日志。仅用于发现待审核候选；
 * 缺失原始经济证据时 `apply=1` 拒绝入账。后续 C04 消费者应读取不可变报价
 * 与经济事件，而不是重新读取当前 shared_keys / system_config。
 *
 * 查询：since=<UTC ISO>（默认 24h 前）、limit（默认 200，1–1000）、apply=0|1
 */
adminEarningsRoutes.post("/rederive", async (c) => {
	try {
		assertExpectedConsoleSubject(
			c.get("principal"),
			c.req.header(EXPECTED_CONSOLE_SUBJECT_HEADER)
		);
		const query = parseReviewQuery(c.req.url);
		if (!query) {
			return c.json(
				{
					success: false,
					code: "invalid_earning_review_query",
					message: "Invalid earning review query",
				},
				400
			);
		}
		const repos = c.get("repositories");
		const { since, limit, apply } = query;

		const { logs, total } = await repos.requestLogs.getRequestLogs({
			page: 1,
			pageSize: limit,
			startDate: since,
		});
		if (
			!Array.isArray(logs) ||
			logs.length > limit ||
			!Number.isSafeInteger(total) ||
			total < logs.length ||
			new Set(logs.map((row) => row.id)).size !== logs.length ||
			logs.some(
				(row) =>
					typeof row.id !== "string" ||
					!row.id ||
					row.id.length > 255 ||
					/[\s/?#\\\p{Cc}\p{Cf}]/u.test(row.id) ||
					/^(?:sk-|enc:v[12]:|sha256:)/u.test(row.id) ||
					(row.provider_key_id !== null &&
						row.provider_key_id !== undefined &&
						typeof row.provider_key_id !== "string")
			)
		) {
			throw new Error("Invalid historical earning review storage result");
		}
		const candidates = logs.filter((row) =>
			(row.provider_key_id ?? "").startsWith("sharedkey:")
		);
		// The legacy query reads only page 1. Even an empty page of candidates
		// cannot establish that later pages contain no shared-key earnings.
		const scanComplete = Number.isSafeInteger(total) && total === logs.length;
		const data = {
			windowSince: since,
			scanned: logs.length,
			windowTotal: total,
			scanComplete,
			candidates: candidates.length,
			reviewRequired: candidates.length,
			candidateLogIds: candidates.map((row) => row.id),
			reviewOnly: true,
			balancesChanged: false,
			queued: false,
			range: { since, limit, page: 1 },
			reviewScope: "first_page_since",
			evidenceRequirement: "original_price_commission_owner",
		};

		if (!apply || (scanComplete && candidates.length === 0)) {
			return c.json({
				success: true,
				dryRun: !apply,
				data,
			});
		}

		return c.json(
			{
				success: false,
				dryRun: false,
				error: scanComplete
					? "Historical shared-key earnings require original price, commission, and owner evidence"
					: "Historical shared-key earnings scan is incomplete; later pages require review",
				code: scanComplete
					? "historical_earning_evidence_required"
					: "historical_earning_scan_incomplete",
				data,
			},
			409
		);
	} catch (error) {
		if (error instanceof ExpectedConsoleSubjectError)
			return c.json(
				{ success: false, code: error.code, message: error.message },
				error.status
			);
		return handleAdminRouteError(
			c,
			error,
			"Failed to rederive shared-key earnings"
		);
	}
});
