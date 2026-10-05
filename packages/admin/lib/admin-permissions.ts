import type { AdminPermission } from "@/lib/admin-principal";

export type AdminAuthorizationDecision =
	| { kind: "permission"; permission: AdminPermission }
	| { kind: "console_only" }
	| { kind: "authenticated" }
	| { kind: "deny" };

function readOrWrite(
	method: string,
	resource: string
): AdminAuthorizationDecision {
	const suffix = method === "GET" || method === "HEAD" ? "read" : "write";
	return {
		kind: "permission",
		permission: `${resource}.${suffix}` as AdminPermission,
	};
}

export function getAdminAuthorizationDecision(
	method: string,
	pathname: string
): AdminAuthorizationDecision {
	const normalizedMethod = method.toUpperCase();
	if (normalizedMethod === "OPTIONS") return { kind: "authenticated" };
	if (pathname === "/admin" && normalizedMethod === "GET")
		return { kind: "authenticated" };
	if (pathname.startsWith("/admin/access-keys")) {
		return { kind: "console_only" };
	}
	if (
		/^\/admin\/providers\/[^/]+\/api-key$/.test(pathname) &&
		normalizedMethod === "GET"
	) {
		return { kind: "permission", permission: "providers.secrets.read" };
	}
	if (pathname.startsWith("/admin/providers"))
		return readOrWrite(normalizedMethod, "providers");
	// 用户共享密钥池治理（挂靠 providers 权限域）
	if (pathname.startsWith("/admin/shared-keys"))
		return readOrWrite(normalizedMethod, "providers");
	// 门户账本：提现 / NFT 铸造（挂靠 users 权限域）
	if (pathname.startsWith("/admin/withdrawals"))
		return readOrWrite(normalizedMethod, "users");
	if (pathname.startsWith("/admin/nft-mints"))
		return readOrWrite(normalizedMethod, "users");
	// 门户账本：共享密钥收益补偿（挂靠 users 权限域）
	if (pathname.startsWith("/admin/earnings"))
		return readOrWrite(normalizedMethod, "users");
	if (pathname.startsWith("/admin/models"))
		return readOrWrite(normalizedMethod, "models");
	if (pathname.startsWith("/admin/presets"))
		return readOrWrite(normalizedMethod, "presets");
	if (pathname.startsWith("/admin/guardrails"))
		return readOrWrite(normalizedMethod, "guardrails");
	if (pathname.startsWith("/admin/data-policies"))
		return readOrWrite(normalizedMethod, "routes");
	if (pathname.startsWith("/admin/endpoints"))
		return readOrWrite(normalizedMethod, "routes");
	if (pathname.startsWith("/admin/routes"))
		return readOrWrite(normalizedMethod, "routes");
	if (
		pathname === "/admin/simulator/context" ||
		pathname === "/admin/simulator/context/"
	)
		return normalizedMethod === "GET" || normalizedMethod === "HEAD"
			? { kind: "permission", permission: "models.read" }
			: { kind: "deny" };
	if (
		pathname === "/admin/simulator" ||
		pathname.startsWith("/admin/simulator/")
	)
		return { kind: "deny" };
	if (/^\/admin\/keys\/[^/]+\/verify-secret\/?$/u.test(pathname))
		return normalizedMethod === "POST"
			? { kind: "permission", permission: "user_keys.read" }
			: { kind: "deny" };
	if (/^\/admin\/users\/[^/]+\/(?:logs|audit-logs)(?:\/|$)/.test(pathname)) {
		return { kind: "permission", permission: "logs.read" };
	}
	if (/^\/admin\/keys\/[^/]+\/logs(?:\/|$)/.test(pathname)) {
		return { kind: "permission", permission: "logs.read" };
	}
	if (/^\/admin\/users\/[^/]+\/keys(?:\/|$)/.test(pathname))
		return readOrWrite(normalizedMethod, "user_keys");
	if (pathname.startsWith("/admin/users"))
		return readOrWrite(normalizedMethod, "users");
	if (pathname.startsWith("/admin/keys"))
		return readOrWrite(normalizedMethod, "user_keys");
	const toolsRoot = "/admin/config/tools";
	if (pathname === toolsRoot || pathname.startsWith(toolsRoot + "/")) {
		const family = "(?:web-search|web-fetch|web-deep-search|ai-detection)";
		const provider =
			"(?:bocha|tavily|cleversee|tencent_wsa|firecrawl|jina|tencent_tms)";
		if (
			new RegExp(
				"^" +
					toolsRoot +
					"/(?:overview|" +
					family +
					"/audit|" +
					family +
					"/providers/" +
					provider +
					"/detail)/?$"
			).test(pathname)
		)
			return normalizedMethod === "GET" || normalizedMethod === "HEAD"
				? { kind: "permission", permission: "config.read" }
				: { kind: "deny" };
		if (
			new RegExp(
				"^" + toolsRoot + "/" + family + "/providers/" + provider + "/save/?$"
			).test(pathname)
		)
			return normalizedMethod === "POST"
				? { kind: "permission", permission: "config.write" }
				: { kind: "deny" };
		if (
			new RegExp(
				"^" + toolsRoot + "/" + family + "/providers/" + provider + "/reveal/?$"
			).test(pathname)
		)
			return normalizedMethod === "POST"
				? { kind: "permission", permission: "config.secrets.read" }
				: { kind: "deny" };
		return { kind: "deny" };
	}
	if (
		pathname === "/admin/config/overview" ||
		pathname === "/admin/config/overview/"
	) {
		return normalizedMethod === "GET" || normalizedMethod === "HEAD"
			? { kind: "permission", permission: "config.read" }
			: { kind: "deny" };
	}
	if (
		/^\/admin\/config\/(?:billing-currency|route-strategy)\/?$/u.test(pathname)
	) {
		return normalizedMethod === "PUT"
			? { kind: "permission", permission: "config.write" }
			: { kind: "deny" };
	}
	if (/^\/admin\/config\/webhooks\/(?:wecom|feishu)\/?$/u.test(pathname)) {
		return normalizedMethod === "PUT" || normalizedMethod === "DELETE"
			? { kind: "permission", permission: "config.write" }
			: { kind: "deny" };
	}
	if (
		/^\/admin\/config\/webhooks\/(?:wecom|feishu)\/(?:reveal|verify)\/?$/u.test(
			pathname
		)
	) {
		if (normalizedMethod === "GET" && /\/reveal\/?$/u.test(pathname)) {
			return { kind: "permission", permission: "config.secrets.read" };
		}
		if (normalizedMethod === "POST" && /\/verify\/?$/u.test(pathname)) {
			return { kind: "permission", permission: "config.secrets.read" };
		}
		return { kind: "deny" };
	}
	if (pathname === "/admin/config" || pathname === "/admin/config/")
		return readOrWrite(normalizedMethod, "config");
	if (pathname.startsWith("/admin/business-timezone"))
		return { kind: "permission", permission: "config.read" };
	if (
		pathname.startsWith("/admin/analytics") ||
		pathname.startsWith("/admin/stats")
	) {
		return { kind: "permission", permission: "analytics.read" };
	}
	if (
		pathname === "/admin/budget-audit-logs/export.csv" ||
		pathname === "/admin/budget-audit-logs/export.csv/"
	) {
		return normalizedMethod === "GET" || normalizedMethod === "HEAD"
			? { kind: "permission", permission: "logs.read" }
			: { kind: "deny" };
	}
	if (
		pathname.startsWith("/admin/request-logs") ||
		pathname.startsWith("/admin/budget-audit-logs")
	) {
		return { kind: "permission", permission: "logs.read" };
	}
	if (pathname.startsWith("/admin/playground")) {
		return { kind: "permission", permission: "playground.execute" };
	}
	return { kind: "deny" };
}
