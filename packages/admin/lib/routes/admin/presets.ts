import { Hono } from "hono";
import type { UpdateRequestPresetMetadataPatch } from "@octafuse/core";
import type { AdminEnv } from "@/lib/admin-env";
import { hasAdminPermission } from "@/lib/admin-principal";
import {
	adminDomainContract,
	domainAcknowledgement,
} from "@/lib/services/admin/domain-contract";
import {
	adminPresetSummary,
	adminPresetVersionSummary,
} from "@/lib/admin-preset-summary";
import {
	requestPresetResponse,
	requestPresetVersionResponse,
} from "@/lib/request-preset-response";

export const adminPresetsRoutes = new Hono<AdminEnv>();

adminPresetsRoutes.use("*", async (c, next) => {
	c.header("Cache-Control", "private, no-store");
	await next();
	c.header("Cache-Control", "private, no-store");
});
adminPresetsRoutes.use("*", adminDomainContract);

adminPresetsRoutes.get("/summaries", async (c) => {
	try {
		const rows = await c.get("repositories").requestPresets.listAll(true);
		return c.json({
			success: true,
			data: rows.map(adminPresetSummary),
			count: rows.length,
			canWrite: hasAdminPermission(c.get("principal"), "presets.write"),
		});
	} catch {
		return c.json({ success: false, message: "Failed to list presets" }, 500);
	}
});

adminPresetsRoutes.get("/", async (c) => {
	try {
		const rows = await c.get("repositories").requestPresets.listAll(true);
		return c.json({ success: true, data: rows.map(requestPresetResponse) });
	} catch {
		return c.json({ success: false, message: "Failed to list presets" }, 500);
	}
});

adminPresetsRoutes.get("/:id/version-summaries", async (c) => {
	try {
		const row = await c
			.get("repositories")
			.requestPresets.getById(c.req.param("id"));
		if (!row) return c.json({ success: false, message: "Not found" }, 404);
		const versions = await c
			.get("repositories")
			.requestPresets.listVersions(row.id);
		return c.json({
			success: true,
			data: {
				presetId: row.id,
				versions: versions.map(adminPresetVersionSummary),
				total: versions.length,
			},
		});
	} catch {
		return c.json(
			{ success: false, message: "Failed to list preset versions" },
			500
		);
	}
});

adminPresetsRoutes.get("/:id/versions", async (c) => {
	try {
		const row = await c
			.get("repositories")
			.requestPresets.getById(c.req.param("id"));
		if (!row) return c.json({ success: false, message: "Not found" }, 404);
		const versions = await c
			.get("repositories")
			.requestPresets.listVersions(row.id);
		return c.json({
			success: true,
			data: versions.map(requestPresetVersionResponse),
		});
	} catch {
		return c.json(
			{ success: false, message: "Failed to list preset versions" },
			500
		);
	}
});

adminPresetsRoutes.patch("/:id", async (c) => {
	const view = c.req.query("view");
	if (view !== undefined && view !== "summary")
		return c.json({ success: false, message: "Invalid view" }, 400);
	try {
		const row = await c
			.get("repositories")
			.requestPresets.getById(c.req.param("id"));
		if (!row) return c.json({ success: false, message: "Not found" }, 404);
		const body = await c.req.json<Record<string, unknown>>().catch(() => null);
		if (!body)
			return c.json({ success: false, message: "Invalid JSON body" }, 400);
		const patch: UpdateRequestPresetMetadataPatch = {
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
		if (body.visibility !== undefined) {
			if (body.visibility !== "private" && body.visibility !== "public")
				return c.json({ success: false, message: "Invalid visibility" }, 400);
			patch.visibility = body.visibility;
		}
		if (body.status !== undefined) {
			if (body.status !== "active" && body.status !== "archived")
				return c.json({ success: false, message: "Invalid status" }, 400);
			patch.status = body.status;
		}
		await c.get("repositories").requestPresets.updateMetadata(row.id, patch);
		const updated = await c.get("repositories").requestPresets.getById(row.id);
		if (!updated && view === "summary")
			return c.json(
				{ success: false, message: "Failed to read updated preset" },
				500
			);
		return c.json({
			success: true,
			data: updated
				? view === "summary"
					? adminPresetSummary(updated)
					: requestPresetResponse(updated)
				: null,
			acknowledgement: domainAcknowledgement("presets", "update", row.id),
		});
	} catch {
		return c.json({ success: false, message: "Failed to update preset" }, 500);
	}
});

adminPresetsRoutes.post("/:id/designate", async (c) => {
	const view = c.req.query("view");
	if (view !== undefined && view !== "summary")
		return c.json({ success: false, message: "Invalid view" }, 400);
	try {
		const body = await c.req.json<{ version?: unknown }>().catch(() => null);
		const version = Number(body?.version);
		if (!Number.isInteger(version) || version < 1)
			return c.json({ success: false, message: "Invalid version" }, 400);
		const changed = await c
			.get("repositories")
			.requestPresets.designateVersion(
				c.req.param("id"),
				version,
				new Date().toISOString()
			);
		if (!changed)
			return c.json(
				{ success: false, message: "Preset or version not found" },
				404
			);
		const updated = await c
			.get("repositories")
			.requestPresets.getById(c.req.param("id"));
		if (!updated && view === "summary")
			return c.json(
				{ success: false, message: "Failed to read updated preset" },
				500
			);
		return c.json({
			success: true,
			data: updated
				? view === "summary"
					? adminPresetSummary(updated)
					: requestPresetResponse(updated)
				: null,
			acknowledgement: domainAcknowledgement(
				"presets",
				"designate",
				c.req.param("id")
			),
		});
	} catch {
		return c.json(
			{ success: false, message: "Failed to designate preset version" },
			500
		);
	}
});
