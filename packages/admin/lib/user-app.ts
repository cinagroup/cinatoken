/**
 * 用户门户 API Hono 子应用：内部路由为 `/user/*`；由 Next 对外暴露为 `/api/user/*`。
 * 与管理台 `/admin/*` 共享存储绑定但会话/权限完全独立（`user_session`）。
 */
import { Hono } from "hono";
import { logger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import {
	listOrganizationMembershipsForSubject,
	resolveWorkspaceContextForSubject,
	type OrganizationMembershipProjection,
} from "@octafuse/core";
import type { UserEnv } from "@/lib/user-env";
import { resolveAdminStorageContext } from "@/lib/storage-context";
import { adminAppVersion as appVersion } from "@/lib/app-version";
import { getUserSessionToken, USER_SESSION_COOKIE } from "@/lib/user-auth";
import { userSharedKeysRoutes } from "@/lib/routes/user/shared-keys";
import { userEarningsRoutes } from "@/lib/routes/user/earnings";
import { userWalletRoutes } from "@/lib/routes/user/wallet";
import { userWithdrawalsRoutes } from "@/lib/routes/user/withdrawals";
import { userNftRoutes } from "@/lib/routes/user/nft";
import { userGatewayKeysRoutes } from "@/lib/routes/user/gateway-keys";
import { userPresetsRoutes } from "@/lib/routes/user/presets";
import { userGuardrailsRoutes } from "@/lib/routes/user/guardrails";
import { userActivityRoutes } from "@/lib/routes/user/activity";
import { userWorkspacesRoutes } from "@/lib/routes/user/workspaces";
import { userManagementKeysRoutes } from "@/lib/routes/user/management-keys";
import { userWorkspaceBudgetsRoutes } from "@/lib/routes/user/workspace-budgets";
import type { AccountCapability } from "@/lib/unified-session";
import {
	clearWorkspaceCookieHeader,
	readPreferredWorkspaceId,
} from "@/lib/workspace-cookie";

export type PortalMeData = {
	userId: string;
	subject: string;
	email: string;
	isAdmin: boolean;
	capabilities: AccountCapability[];
	organizations: OrganizationMembershipProjection[];
};

export function createPortalMeResponse(
	principal: Omit<PortalMeData, "organizations"> & {
		organizations?: OrganizationMembershipProjection[];
	}
): {
	success: true;
	data: PortalMeData;
} {
	return {
		success: true,
		data: {
			userId: principal.userId,
			subject: principal.subject,
			email: principal.email,
			isAdmin: principal.isAdmin,
			capabilities: [...principal.capabilities],
			organizations: [...(principal.organizations ?? [])],
		},
	};
}

export function createUserApp(): Hono<UserEnv> {
	const app = new Hono<UserEnv>();

	app.use("*", logger());
	app.use("*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));

	app.use("*", async (c, next) => {
		const { repositories } = await resolveAdminStorageContext(c.env);
		c.set("repositories", repositories);
		const principal = c.env.USER_PRINCIPAL;
		if (!principal)
			return c.json({ success: false, message: "Unauthorized" }, 401);
		c.set("principal", principal);
		if (c.req.path !== "/user/auth/logout") {
			c.set(
				"workspaceContext",
				await resolveWorkspaceContextForSubject(repositories.client, {
					userId: principal.userId,
					subject: principal.subject,
					preferredWorkspaceId: readPreferredWorkspaceId(c.req.raw),
				})
			);
		}
		await next();
	});

	app.get("/user/me", async (c) => {
		const principal = c.get("principal");
		const repositories = c.get("repositories");
		const organizations = await listOrganizationMembershipsForSubject(
			repositories.client,
			principal.subject
		);
		return c.json(createPortalMeResponse({ ...principal, organizations }));
	});

	app.post("/user/auth/logout", async (c) => {
		const repositories = c.get("repositories");
		const token = getUserSessionToken(c.req.raw);
		if (token) {
			const { hashSessionToken } = await import("@/lib/auth");
			const tokenHash = await hashSessionToken(token);
			await Promise.all([
				repositories.portalAccess.deleteSession(tokenHash),
				repositories.adminAccess.deleteSession(tokenHash),
			]);
		}
		c.header(
			"Set-Cookie",
			`cinatoken_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
		);
		c.header(
			"Set-Cookie",
			`${USER_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
			{ append: true }
		);
		c.header(
			"Set-Cookie",
			"admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
			{ append: true }
		);
		c.header("Set-Cookie", clearWorkspaceCookieHeader(c.req.raw), {
			append: true,
		});
		return c.json({ success: true });
	});

	app.route("/user/shared-keys", userSharedKeysRoutes);
	app.route("/user/earnings", userEarningsRoutes);
	app.route("/user/wallet", userWalletRoutes);
	app.route("/user/withdrawals", userWithdrawalsRoutes);
	app.route("/user/nft", userNftRoutes);
	app.route("/user/gateway-keys", userGatewayKeysRoutes);
	app.route("/user/presets", userPresetsRoutes);
	app.route("/user/guardrails", userGuardrailsRoutes);
	app.route("/user/activity", userActivityRoutes);
	app.route("/user/workspaces", userWorkspacesRoutes);
	app.route("/user/management-keys", userManagementKeysRoutes);
	app.route("/user/workspace-budgets", userWorkspaceBudgetsRoutes);

	app.get("/user", (c) =>
		c.json({ name: "cinatoken-user-api", version: appVersion })
	);

	return app;
}

let cached: ReturnType<typeof createUserApp> | undefined;

export function getUserApp(): Hono<UserEnv> {
	if (!cached) {
		cached = createUserApp();
	}
	return cached;
}
