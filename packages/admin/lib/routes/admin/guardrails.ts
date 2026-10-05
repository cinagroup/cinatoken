import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
	getAccessibleWorkspaceForSubject,
	type GuardrailScopeType,
	type UpdateGuardrailMetadataPatch,
} from "@octafuse/core";
import { BILLING_CURRENCY_KEY } from "@octafuse/core/lib/billing-currency";
import type { AdminEnv } from "@/lib/admin-env";
import { hasAdminPermission } from "@/lib/admin-principal";
import { handleGatewayApiError } from "@/lib/api-error";
import {
	adminGuardrailSummaryResponse,
	adminGuardrailVersionSummaryResponse,
	adminGuardrailPreviewConflict,
	adminGuardrailPreviewMetadata,
	adminGuardrailPreviewSuccess,
	guardrailAssignmentResponse,
	guardrailResponse,
	guardrailVersionResponse,
} from "@/lib/guardrail-response";
import { buildGuardrailPreviewForRequest } from "@/lib/services/guardrail-preview";
import {
	adminDomainContract,
	domainAcknowledgement,
} from "@/lib/services/admin/domain-contract";

export const adminGuardrailsRoutes = new Hono<AdminEnv>();

adminGuardrailsRoutes.use("*", async (c, next) => {
	c.header("Cache-Control", "private, no-store");
	await next();
	c.header("Cache-Control", "private, no-store");
});
adminGuardrailsRoutes.use("*", adminDomainContract);

adminGuardrailsRoutes.onError((error) => {
	const response =
		error instanceof HTTPException
			? error.getResponse()
			: handleGatewayApiError({ route: "admin.guardrails", error });
	response.headers.set("Cache-Control", "private, no-store");
	return response;
});

adminGuardrailsRoutes.get("/summaries", async (c) => {
	const rows = await c.get("repositories").guardrails.listAll(true);
	return c.json({
		success: true,
		data: rows.map(adminGuardrailSummaryResponse),
		count: rows.length,
		canWrite: hasAdminPermission(c.get("principal"), "guardrails.write"),
	});
});

adminGuardrailsRoutes.get("/", async (c) =>
	c.json({
		success: true,
		data: (await c.get("repositories").guardrails.listAll(true)).map(
			guardrailResponse
		),
	})
);
adminGuardrailsRoutes.get("/effective", async (c) => {
	const workspaceId = c.req.query("workspace_id")?.trim() ?? "";
	const userId = c.req.query("user_id")?.trim() ?? "";
	const apiKeyId = c.req.query("api_key_id")?.trim() || null;
	if (
		!workspaceId ||
		workspaceId.length > 600 ||
		!userId ||
		userId.length > 256 ||
		(apiKeyId != null && apiKeyId.length > 256)
	) {
		return c.json(
			{ success: false, message: "workspace_id and user_id are required" },
			400
		);
	}
	const user = await c.get("repositories").users.getById(userId);
	if (!user)
		return c.json(
			{ success: false, message: "User or Workspace not found" },
			404
		);
	const workspace = await getAccessibleWorkspaceForSubject(
		c.get("repositories").client,
		{
			userId: user.id,
			subject: user.external_user_id ?? user.id,
			workspaceId,
		}
	);
	if (!workspace)
		return c.json(
			{ success: false, message: "User or Workspace not found" },
			404
		);
	if (apiKeyId) {
		const key = await c
			.get("repositories")
			.apiKeys.getApiKeyByIdInWorkspace(apiKeyId, workspaceId);
		if (!key || key.user_id !== userId || key.status !== "active") {
			return c.json({ success: false, message: "Gateway key not found" }, 404);
		}
	}
	const preview = await buildGuardrailPreviewForRequest(c.get("repositories"), {
		workspaceId,
		userId,
		apiKeyId,
	});
	const metadata = adminGuardrailPreviewMetadata(
		workspace,
		userId,
		apiKeyId,
		await c.get("repositories").systemConfig.getConfig(BILLING_CURRENCY_KEY)
	);
	return preview.ok
		? c.json(adminGuardrailPreviewSuccess(preview.value, metadata))
		: c.json(
				adminGuardrailPreviewConflict(preview.message, preview.trace, metadata),
				409
		  );
});
adminGuardrailsRoutes.get("/:id/version-summaries", async (c) => {
	const row = await c.get("repositories").guardrails.getById(c.req.param("id"));
	if (!row) return c.json({ success: false, message: "Not found" }, 404);
	const versions = await c.get("repositories").guardrails.listVersions(row.id);
	return c.json({
		success: true,
		data: {
			guardrailId: row.id,
			versions: versions.map(adminGuardrailVersionSummaryResponse),
			total: versions.length,
		},
	});
});
adminGuardrailsRoutes.get("/:id/versions", async (c) => {
	const row = await c.get("repositories").guardrails.getById(c.req.param("id"));
	if (!row) return c.json({ success: false, message: "Not found" }, 404);
	return c.json({
		success: true,
		data: (await c.get("repositories").guardrails.listVersions(row.id)).map(
			guardrailVersionResponse
		),
	});
});
adminGuardrailsRoutes.get("/:id/assignments", async (c) => {
	const row = await c.get("repositories").guardrails.getById(c.req.param("id"));
	if (!row) return c.json({ success: false, message: "Not found" }, 404);
	return c.json({
		success: true,
		data: (await c.get("repositories").guardrails.listAssignments(row.id)).map(
			guardrailAssignmentResponse
		),
	});
});
adminGuardrailsRoutes.put("/:id/assignments", async (c) => {
	const row = await c.get("repositories").guardrails.getById(c.req.param("id"));
	if (!row || row.status !== "active")
		return c.json({ success: false, message: "Not found or archived" }, 404);
	if (row.is_workspace_default || row.is_account_default)
		return c.json(
			{
				success: false,
				message: "Default Guardrails apply implicitly and cannot be assigned",
			},
			400
		);
	const body = await c.req
		.json<{ scope_type?: unknown; scope_id?: unknown }>()
		.catch(() => null);
	if (
		!body ||
		(body.scope_type !== "user" && body.scope_type !== "api_key") ||
		typeof body.scope_id !== "string" ||
		!body.scope_id
	)
		return c.json({ success: false, message: "Invalid assignment scope" }, 400);
	if (body.scope_type === "api_key") {
		const key = await c
			.get("repositories")
			.apiKeys.getApiKeyByIdInWorkspace(body.scope_id, row.workspace_id);
		if (!key || key.status !== "active")
			return c.json(
				{
					success: false,
					message: "Active assignment scope not found in this workspace",
				},
				404
			);
	} else {
		const user = await c.get("repositories").users.getById(body.scope_id);
		if (!user)
			return c.json(
				{ success: false, message: "Assignment scope not found" },
				404
			);
		const workspace = await getAccessibleWorkspaceForSubject(
			c.get("repositories").client,
			{
				userId: user.id,
				subject: user.external_user_id ?? user.id,
				workspaceId: row.workspace_id,
			}
		);
		if (!workspace)
			return c.json(
				{ success: false, message: "User is not a member of this workspace" },
				404
			);
	}
	let assignment;
	try {
		assignment = await c.get("repositories").guardrails.upsertAssignment({
			id: crypto.randomUUID(),
			workspaceId: row.workspace_id,
			guardrailId: row.id,
			scopeType: body.scope_type,
			scopeId: body.scope_id,
			createdByUserId: null,
			nowIso: new Date().toISOString(),
		});
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === "guardrail_assignment_scope_not_assignable"
		)
			return c.json(
				{
					success: false,
					code: "guardrail_assignment_scope_not_assignable",
					message:
						"Assignment scope changed while the binding was being applied",
				},
				409
			);
		if (
			error instanceof Error &&
			error.message === "guardrail_assignment_target_not_assignable"
		)
			return c.json(
				{ success: false, message: "Guardrail assignment target changed" },
				409
			);
		throw error;
	}
	if (
		assignment.guardrail_id !== row.id ||
		assignment.workspace_id !== row.workspace_id
	)
		return c.json(
			{ success: false, message: "Guardrail assignment changed during write" },
			409
		);
	return c.json({
		success: true,
		data: guardrailAssignmentResponse(assignment),
		acknowledgement: domainAcknowledgement(
			"guardrails",
			"bind",
			row.id,
			body.scope_id
		),
	});
});
adminGuardrailsRoutes.delete("/assignments/:scopeType/:scopeId", async (c) => {
	const scopeType = c.req.param("scopeType") as GuardrailScopeType;
	if (scopeType !== "user" && scopeType !== "api_key")
		return c.json({ success: false, message: "Invalid scope" }, 400);
	const workspaceId = c.req.query("workspace_id")?.trim();
	if (!workspaceId)
		return c.json({ success: false, message: "workspace_id is required" }, 400);
	const expectedGuardrailId = c.req.query("expected_guardrail_id");
	if (
		expectedGuardrailId !== undefined &&
		(!expectedGuardrailId ||
			expectedGuardrailId.length > 600 ||
			expectedGuardrailId !== expectedGuardrailId.trim() ||
			/[\u0000-\u001f\u007f]/u.test(expectedGuardrailId))
	)
		return c.json(
			{ success: false, message: "Invalid expected guardrail ID" },
			400
		);
	const removed = await c
		.get("repositories")
		.guardrails.deleteAssignment(
			workspaceId,
			scopeType,
			c.req.param("scopeId"),
			undefined,
			expectedGuardrailId
		);
	if (expectedGuardrailId !== undefined && !removed)
		return c.json(
			{
				success: false,
				message: "Guardrail assignment changed or no longer exists",
			},
			409
		);
	return c.json({
		success: true,
		removed,
		acknowledgement: domainAcknowledgement(
			"guardrails",
			"unbind",
			expectedGuardrailId,
			c.req.param("scopeId")
		),
	});
});
adminGuardrailsRoutes.patch("/:id", async (c) => {
	const view = c.req.query("view");
	if (view !== undefined && view !== "summary")
		return c.json({ success: false, message: "Invalid view" }, 400);
	const row = await c.get("repositories").guardrails.getById(c.req.param("id"));
	if (!row) return c.json({ success: false, message: "Not found" }, 404);
	const body = await c.req.json<Record<string, unknown>>().catch(() => null);
	if (!body)
		return c.json({ success: false, message: "Invalid JSON body" }, 400);
	if (
		(row.is_workspace_default || row.is_account_default) &&
		(body.name !== undefined || body.status !== undefined)
	)
		return c.json(
			{
				success: false,
				message: "Default Guardrail name and status are immutable",
			},
			400
		);
	const patch: UpdateGuardrailMetadataPatch = {
		nowIso: new Date().toISOString(),
	};
	if (body.name !== undefined) {
		if (typeof body.name !== "string" || !body.name.trim())
			return c.json({ success: false, message: "Name is required" }, 400);
		patch.name = body.name.trim().slice(0, 128);
	}
	if (body.description === null || typeof body.description === "string")
		patch.description =
			typeof body.description === "string"
				? body.description.trim().slice(0, 1024) || null
				: null;
	if (body.status !== undefined) {
		if (body.status !== "active" && body.status !== "archived")
			return c.json({ success: false, message: "Invalid status" }, 400);
		patch.status = body.status;
	}
	if (!(await c.get("repositories").guardrails.updateMetadata(row.id, patch)))
		return c.json(
			{
				success: false,
				message: "Guardrail changed while the update was being applied",
			},
			409
		);
	const updated = await c.get("repositories").guardrails.getById(row.id);
	if (!updated && view === "summary")
		return c.json(
			{ success: false, message: "Failed to read updated guardrail" },
			500
		);
	return c.json({
		success: true,
		data: updated
			? view === "summary"
				? adminGuardrailSummaryResponse(updated)
				: guardrailResponse(updated)
			: null,
		acknowledgement: domainAcknowledgement("guardrails", "update", row.id),
	});
});
adminGuardrailsRoutes.post("/:id/designate", async (c) => {
	const view = c.req.query("view");
	if (view !== undefined && view !== "summary")
		return c.json({ success: false, message: "Invalid view" }, 400);
	const body = await c.req.json<{ version?: unknown }>().catch(() => null);
	const version = Number(body?.version);
	if (!Number.isInteger(version) || version < 1)
		return c.json({ success: false, message: "Invalid version" }, 400);
	if (
		!(await c
			.get("repositories")
			.guardrails.designateVersion(
				c.req.param("id"),
				version,
				new Date().toISOString()
			))
	)
		return c.json(
			{ success: false, message: "Guardrail or version not found" },
			404
		);
	const updated = await c
		.get("repositories")
		.guardrails.getById(c.req.param("id"));
	if (!updated && view === "summary")
		return c.json(
			{ success: false, message: "Failed to read updated guardrail" },
			500
		);
	return c.json({
		success: true,
		data: updated
			? view === "summary"
				? adminGuardrailSummaryResponse(updated)
				: guardrailResponse(updated)
			: null,
		acknowledgement: domainAcknowledgement(
			"guardrails",
			"designate",
			c.req.param("id")
		),
	});
});
