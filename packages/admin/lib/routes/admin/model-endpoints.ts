/** Admin API for endpoint-first model/provider catalog records. */
import { Hono } from "hono";
import { normalizeApiTimeFields } from "@octafuse/core/lib/time-format";
import type { AdminEnv } from "@/lib/admin-env";
import { requireAdminPrincipal } from "@/lib/middleware/admin-auth";
import {
	createModelEndpointService,
	deleteModelEndpointService,
	getModelEndpointService,
	linkModelEndpointRouteService,
	listModelEndpointsService,
	type AdminModelEndpointMutationInput,
	unlinkModelEndpointRouteService,
	updateModelEndpointService,
} from "@/lib/services/admin/model-endpoints-service";
import {
	bootstrapDeepSeekEndpointsService,
	type AdminDeepSeekEndpointBootstrapInput,
} from "@/lib/services/admin/deepseek-endpoint-bootstrap";
import { handleAdminRouteError } from "./error-response";

export const adminModelEndpointsRoutes = new Hono<AdminEnv>();

adminModelEndpointsRoutes.use("*", requireAdminPrincipal);
adminModelEndpointsRoutes.use("*", async (c, next) => {
	c.header("Cache-Control", "private, no-store");
	await next();
});

adminModelEndpointsRoutes.get("/", async (c) => {
	try {
		const data = await listModelEndpointsService(c.get("repositories"), {
			model_id: c.req.query("model_id"),
			provider_id: c.req.query("provider_id"),
			status: c.req.query("status"),
		});
		return c.json(
			normalizeApiTimeFields({ success: true, data, count: data.length })
		);
	} catch (error) {
		return handleAdminRouteError(c, error, "Failed to list model endpoints");
	}
});

adminModelEndpointsRoutes.post("/", async (c) => {
	let body: AdminModelEndpointMutationInput;
	try {
		body = await c.req.json<AdminModelEndpointMutationInput>();
	} catch {
		return c.json({ success: false, message: "Invalid JSON body" }, 400);
	}
	try {
		const data = await createModelEndpointService(
			c.get("repositories"),
			body,
			c.get("principal").id
		);
		return c.json(
			{ success: true, message: "Model endpoint created successfully", data },
			201
		);
	} catch (error) {
		return handleAdminRouteError(c, error, "Failed to create model endpoint");
	}
});

adminModelEndpointsRoutes.post("/bootstrap/deepseek", async (c) => {
	let body: AdminDeepSeekEndpointBootstrapInput;
	try {
		body = await c.req.json<AdminDeepSeekEndpointBootstrapInput>();
	} catch {
		return c.json({ success: false, message: "Invalid JSON body" }, 400);
	}
	try {
		const data = await bootstrapDeepSeekEndpointsService(
			c.get("repositories"),
			body,
			c.get("principal").id
		);
		return c.json({
			success: true,
			message: "Official DeepSeek endpoints processed",
			data,
		});
	} catch (error) {
		return handleAdminRouteError(
			c,
			error,
			"Failed to publish official DeepSeek endpoints"
		);
	}
});

adminModelEndpointsRoutes.get("/:id", async (c) => {
	try {
		const data = await getModelEndpointService(
			c.get("repositories"),
			c.req.param("id")
		);
		return c.json(normalizeApiTimeFields({ success: true, data }));
	} catch (error) {
		return handleAdminRouteError(c, error, "Failed to get model endpoint");
	}
});

adminModelEndpointsRoutes.patch("/:id", async (c) => {
	let body: AdminModelEndpointMutationInput;
	try {
		body = await c.req.json<AdminModelEndpointMutationInput>();
	} catch {
		return c.json({ success: false, message: "Invalid JSON body" }, 400);
	}
	try {
		const data = await updateModelEndpointService(
			c.get("repositories"),
			c.req.param("id"),
			body,
			c.get("principal").id
		);
		return c.json({
			success: true,
			message: "Model endpoint updated successfully",
			data,
		});
	} catch (error) {
		return handleAdminRouteError(c, error, "Failed to update model endpoint");
	}
});

adminModelEndpointsRoutes.delete("/:id", async (c) => {
	try {
		await deleteModelEndpointService(c.get("repositories"), c.req.param("id"));
		return c.json({
			success: true,
			message: "Model endpoint deleted successfully",
		});
	} catch (error) {
		return handleAdminRouteError(c, error, "Failed to delete model endpoint");
	}
});

adminModelEndpointsRoutes.post("/:id/routes/:routeTargetId", async (c) => {
	try {
		await linkModelEndpointRouteService(
			c.get("repositories"),
			c.req.param("id"),
			c.req.param("routeTargetId")
		);
		return c.json(
			{ success: true, message: "Route linked to model endpoint" },
			201
		);
	} catch (error) {
		return handleAdminRouteError(
			c,
			error,
			"Failed to link route to model endpoint"
		);
	}
});

adminModelEndpointsRoutes.delete("/:id/routes/:routeTargetId", async (c) => {
	try {
		await unlinkModelEndpointRouteService(
			c.get("repositories"),
			c.req.param("id"),
			c.req.param("routeTargetId")
		);
		return c.json({
			success: true,
			message: "Route unlinked from model endpoint",
		});
	} catch (error) {
		return handleAdminRouteError(
			c,
			error,
			"Failed to unlink route from model endpoint"
		);
	}
});
