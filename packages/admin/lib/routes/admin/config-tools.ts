import { Hono, type Context } from "hono";
import type { AdminEnv } from "@/lib/admin-env";
import {
	ToolConfigError,
	toolConfigFamily,
	toolConfigProvider,
} from "@/lib/services/admin/tool-config-contract";
import {
	toolConfigQuery,
	toolConfigAuditQuery,
	toolConfigSaveInput,
	toolConfigRevealInput,
} from "@/lib/services/admin/tool-config-input";
import {
	getToolConfigOverview,
	getToolConfigProviderDetail,
	saveToolConfig,
	revealToolConfig,
	getToolConfigAudit,
} from "@/lib/services/admin/tool-config-service";
import {
	assertExpectedConsoleSubject,
	ExpectedConsoleSubjectError,
	EXPECTED_CONSOLE_SUBJECT_HEADER,
} from "@/lib/services/admin/expected-console-subject";

export const adminToolsConfigRoutes = new Hono<AdminEnv>();
adminToolsConfigRoutes.use("*", async (c, next) => {
	await next();
	c.header("Cache-Control", "private, no-store");
});
function error(c: Context<AdminEnv>, value: unknown) {
	if (
		value instanceof ToolConfigError ||
		value instanceof ExpectedConsoleSubjectError
	)
		return c.json(
			{ success: false, code: value.code, message: value.message },
			value.status
		);
	return c.json(
		{
			success: false,
			code: "tools_operation_failed",
			message: "Tools configuration operation failed",
		},
		500
	);
}
adminToolsConfigRoutes.get("/overview", async (c) => {
	try {
		toolConfigQuery(c.req.url);
		return c.json({
			success: true,
			data: await getToolConfigOverview(
				c.get("repositories"),
				c.get("principal")
			),
		});
	} catch (value) {
		return error(c, value);
	}
});
adminToolsConfigRoutes.get("/:family/providers/:provider/detail", async (c) => {
	try {
		toolConfigQuery(c.req.url);
		const family = toolConfigFamily(c.req.param("family"));
		const provider = toolConfigProvider(family, c.req.param("provider"));
		return c.json({
			success: true,
			data: await getToolConfigProviderDetail(
				c.get("repositories"),
				c.get("principal"),
				family,
				provider
			),
		});
	} catch (value) {
		return error(c, value);
	}
});
for (const operation of ["save", "reveal"] as const)
	adminToolsConfigRoutes.post(
		"/:family/providers/:provider/" + operation,
		async (c) => {
			try {
				toolConfigQuery(c.req.url);
				const family = toolConfigFamily(c.req.param("family"));
				const provider = toolConfigProvider(family, c.req.param("provider"));
				assertExpectedConsoleSubject(
					c.get("principal"),
					c.req.header(EXPECTED_CONSOLE_SUBJECT_HEADER),
					true
				);
				let raw: string;
				try {
					raw = await c.req.text();
				} catch (value) {
					if (value instanceof Error && value.name === "BodyLimitError")
						return c.json(
							{
								success: false,
								code: "tools_body_too_large",
								message: "Tools request body is too large",
							},
							413
						);
					throw value;
				}
				const data =
					operation === "save"
						? await saveToolConfig(
								c.get("repositories"),
								c.get("principal"),
								family,
								provider,
								toolConfigSaveInput(family, raw)
						  )
						: await revealToolConfig(
								c.get("repositories"),
								c.get("principal"),
								family,
								provider,
								toolConfigRevealInput(family, provider, raw)
						  );
				return c.json({ success: true, data });
			} catch (value) {
				return error(c, value);
			}
		}
	);
adminToolsConfigRoutes.get("/:family/audit", async (c) => {
	try {
		const family = toolConfigFamily(c.req.param("family"));
		return c.json({
			success: true,
			data: await getToolConfigAudit(
				c.get("repositories"),
				c.get("principal"),
				family,
				toolConfigAuditQuery(family, c.req.url)
			),
		});
	} catch (value) {
		return error(c, value);
	}
});
