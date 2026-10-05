/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { Hono } from "hono";
import type { AdminEnv } from "@/lib/admin-env";
import { hasAdminPermission } from "@/lib/admin-principal";
import { getSimulatorContext } from "@/lib/services/admin/simulator-context-service";

export const adminSimulatorRoutes = new Hono<AdminEnv>();
adminSimulatorRoutes.use("*", async (c, next) => {
	c.header("Cache-Control", "private, no-store");
	const principal = c.get("principal");
	if (!principal)
		return c.json({ success: false, message: "Unauthorized" }, 401);
	for (const permission of ["models.read", "routes.read"] as const)
		if (!hasAdminPermission(principal, permission))
			return c.json(
				{
					success: false,
					message: "Forbidden",
					required_permission: permission,
				},
				403
			);
	await next();
});

adminSimulatorRoutes.get("/context", async (c) => {
	if (new URL(c.req.url).search)
		return c.json(
			{ success: false, message: "Invalid Simulator context query" },
			400
		);
	try {
		const data = await getSimulatorContext(
			c.get("repositories"),
			c.get("principal")
		);
		return c.json({ success: true, data });
	} catch {
		return c.json(
			{ success: false, message: "Simulator context unavailable" },
			503
		);
	}
});
