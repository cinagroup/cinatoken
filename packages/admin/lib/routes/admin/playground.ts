/**
 * 管理路由：`/admin/playground` — 管理员试调用。
 * - routeId 分支：直连单条 model_routes 上游（不计费、不写 logs、无 failover）
 * - toolId 分支：读 system_config catalog 直连工具引擎（可测非 Active；不计费、不写 logs）
 */
import { Hono } from "hono";
import type { AdminEnv } from "@/lib/admin-env";
import { requireAdminPrincipal } from "@/lib/middleware/admin-auth";
import type { GeminiContentAction } from "@octafuse/core/gemini-upstream-url";
import type { ImageOperation } from "@/lib/image-generations";
import { invokePlaygroundUpstream } from "@/lib/services/admin/playground-service";
import { invokePlaygroundTool } from "@/lib/services/admin/playground-tools-service";
import {
	dispatchPlaygroundDashScopeRealtime,
	PLAYGROUND_DASHSCOPE_REALTIME_OPERATIONS,
} from "@/lib/services/admin/playground-realtime-service";
import { copyPlaygroundUpstreamHeaders } from "@/lib/playground/proxy-response-headers";
import { handleAdminRouteError } from "./error-response";
import { hasAdminPermission } from "@/lib/admin-principal";
import { badRequest } from "@/lib/services/admin/errors";
import { getPlaygroundContext } from "@/lib/services/admin/playground-context-service";
import { previewPlaygroundRequest } from "@/lib/services/admin/playground-preview-service";
import {
	parsePlaygroundMultipart,
	withBoundedPlaygroundBody,
	type PlaygroundUploads,
} from "@/lib/playground/uploads";
import { safePlaygroundUrl } from "@/lib/playground/private-preview";
import { checkBrowserMutationOrigin } from "@/lib/browser-mutation";
import {
	assertExpectedConsoleSubject,
	ExpectedConsoleSubjectError,
	EXPECTED_CONSOLE_SUBJECT_HEADER,
} from "@/lib/services/admin/expected-console-subject";

export const adminPlaygroundRoutes = new Hono<AdminEnv>();

adminPlaygroundRoutes.use("*", requireAdminPrincipal);
adminPlaygroundRoutes.use("*", async (c, next) => {
	c.header("Cache-Control", "private, no-store");
	if (!hasAdminPermission(c.get("principal"), "playground.execute")) {
		return c.json(
			{
				success: false,
				message: "Forbidden",
				required_permission: "playground.execute",
			},
			403
		);
	}
	try {
		assertExpectedConsoleSubject(
			c.get("principal"),
			c.req.header(EXPECTED_CONSOLE_SUBJECT_HEADER) ??
				(c.req.path.endsWith("/realtime")
					? expectedRealtimeSubject(c.req.header("Sec-WebSocket-Protocol"))
					: undefined)
		);
	} catch (error) {
		if (error instanceof ExpectedConsoleSubjectError)
			return c.json(
				{ success: false, message: error.message, code: error.code },
				error.status
			);
		throw error;
	}
	await next();
	c.header(
		"Cache-Control",
		(c.res.headers.get("Content-Type") ?? "").includes("text/event-stream")
			? "private, no-store, no-transform"
			: "private, no-store"
	);
});

/** Browser WebSocket subject preconditions stay out of URLs and provider headers. */
export function expectedRealtimeSubject(
	header: string | undefined
): string | undefined {
	const prefix = "cinatoken-playground-subject.";
	const values = (header ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.startsWith(prefix));
	if (!values.length) return undefined;
	if (values.length !== 1)
		throw new ExpectedConsoleSubjectError(
			400,
			"invalid_console_subject_precondition",
			"Invalid Console subject precondition"
		);
	const encoded = values[0].slice(prefix.length);
	try {
		if (!encoded || encoded.length > 7200 || !/^[A-Za-z0-9_-]+$/u.test(encoded))
			throw new Error();
		const value = atob(encoded.replace(/-/gu, "+").replace(/_/gu, "/"));
		if (
			btoa(value)
				.replace(/\+/gu, "-")
				.replace(/\//gu, "_")
				.replace(/=+$/u, "") !== encoded
		)
			throw new Error();
		return value;
	} catch {
		throw new ExpectedConsoleSubjectError(
			400,
			"invalid_console_subject_precondition",
			"Invalid Console subject precondition"
		);
	}
}

adminPlaygroundRoutes.get("/context", async (c) => {
	try {
		return c.json({
			success: true,
			data: await getPlaygroundContext(
				c.get("repositories"),
				c.get("principal"),
				c.req.raw.signal
			),
		});
	} catch (error) {
		return handleAdminRouteError(c, error, "Playground context failed");
	}
});

function refusePlaygroundRedirect(response: Response): Response | null {
	if (response.status < 300 || response.status >= 400) return null;
	// Returning 307/308 plus Location to the browser would replay this POST
	// through the Admin route even though the server-side fetch used manual redirect.
	void response.body
		?.cancel("playground_upstream_redirect_refused")
		.catch(() => undefined);
	return new Response(
		JSON.stringify({
			success: false,
			message: "Playground upstream redirect refused",
		}),
		{
			status: 502,
			headers: { "content-type": "application/json; charset=utf-8" },
		}
	);
}

adminPlaygroundRoutes.get("/realtime", async (c) => {
	if (c.get("principal").type === "console") {
		const origin = checkBrowserMutationOrigin(
			new Request(c.req.raw, { method: "POST" })
		);
		if (!origin.allowed)
			return c.json(
				{ success: false, message: "Forbidden: invalid request origin" },
				403
			);
	}
	if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
		return c.json(
			{
				success: false as const,
				message: "Expected a WebSocket upgrade request",
			},
			426
		);
	}
	const routeId = c.req.query("routeId")?.trim() ?? "";
	const operation = c.req.query("operation")?.trim() ?? "";
	if (!routeId)
		return c.json(
			{ success: false as const, message: "routeId is required" },
			400
		);
	if (
		!(PLAYGROUND_DASHSCOPE_REALTIME_OPERATIONS as readonly string[]).includes(
			operation
		)
	) {
		return c.json(
			{
				success: false as const,
				message: `Unsupported realtime operation: ${operation || "(empty)"}`,
			},
			400
		);
	}
	try {
		const result = await dispatchPlaygroundDashScopeRealtime(
			c.get("repositories"),
			{ routeId, operation },
			c.req.raw.signal
		);
		const headers =
			result.response.status === 101
				? new Headers(result.response.headers)
				: copyPlaygroundUpstreamHeaders(result.response.headers);
		headers.set("Cache-Control", "private, no-store");
		headers.set(
			"x-playground-upstream-url",
			safePlaygroundUrl(result.upstreamUrl)
		);
		headers.set("x-playground-mode", "realtime");
		if (
			result.response.status === 101 &&
			(c.req.header("Sec-WebSocket-Protocol") ?? "")
				.split(",")
				.some((value) => value.trim() === "cinatoken-playground")
		)
			headers.set("Sec-WebSocket-Protocol", "cinatoken-playground");
		return new Response(result.response.body, {
			status: result.response.status,
			statusText: result.response.statusText,
			headers,
			webSocket: result.response.webSocket,
		});
	} catch (error) {
		return handleAdminRouteError(c, error, "Playground realtime invoke failed");
	}
});

type PlaygroundPostBody = {
	routeId?: unknown;
	toolId?: unknown;
	provider?: unknown;
	body?: unknown;
	geminiAction?: unknown;
	imageOperation?: unknown;
	uploadManifest?: unknown;
};

async function readInvocation(request: Request, preview: boolean) {
	let parsed: PlaygroundPostBody;
	let uploads: PlaygroundUploads | undefined;
	try {
		if (
			!preview &&
			(request.headers.get("content-type") ?? "")
				.toLowerCase()
				.startsWith("multipart/form-data")
		) {
			const multipart = await withBoundedPlaygroundBody(
				request,
				true,
				parsePlaygroundMultipart
			);
			parsed = multipart.envelope;
			uploads = multipart.uploads;
		} else {
			const value: unknown = await withBoundedPlaygroundBody(
				request,
				false,
				(bounded) => bounded.json()
			);
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw badRequest("Request must be a JSON object");
			parsed = value as PlaygroundPostBody;
		}
	} catch (error) {
		if (error instanceof Error && error.name === "AdminServiceError")
			throw error;
		throw badRequest("Invalid JSON or multipart body");
	}
	if (
		!parsed.body ||
		typeof parsed.body !== "object" ||
		Array.isArray(parsed.body)
	)
		throw badRequest("body must be a JSON object");
	const routeId =
		typeof parsed.routeId === "string" ? parsed.routeId.trim() : "";
	const toolId = typeof parsed.toolId === "string" ? parsed.toolId.trim() : "";
	if (!routeId && !toolId) throw badRequest("routeId or toolId is required");
	if (routeId && toolId)
		throw badRequest("Provide either routeId or toolId, not both");
	if (toolId && (uploads || parsed.uploadManifest != null))
		throw badRequest("Tool invocations do not accept uploads");
	let geminiAction: GeminiContentAction | undefined;
	if (
		parsed.geminiAction === "generateContent" ||
		parsed.geminiAction === "streamGenerateContent"
	)
		geminiAction = parsed.geminiAction;
	else if (parsed.geminiAction != null && parsed.geminiAction !== "")
		throw badRequest(
			"geminiAction must be generateContent or streamGenerateContent"
		);
	let imageOperation: ImageOperation | undefined;
	if (
		parsed.imageOperation === "generations" ||
		parsed.imageOperation === "edits"
	)
		imageOperation = parsed.imageOperation;
	else if (parsed.imageOperation != null && parsed.imageOperation !== "")
		throw badRequest("imageOperation must be generations or edits");
	if (!preview && parsed.uploadManifest != null)
		throw badRequest("Upload manifest is only accepted for preview");
	return {
		routeId,
		toolId,
		provider: typeof parsed.provider === "string" ? parsed.provider.trim() : "",
		body: parsed.body as Record<string, unknown>,
		geminiAction,
		imageOperation,
		uploads,
		uploadManifest: parsed.uploadManifest,
	};
}

adminPlaygroundRoutes.post("/preview", async (c) => {
	try {
		const input = await readInvocation(c.req.raw, true);
		return c.json({
			success: true,
			data: await previewPlaygroundRequest(
				c.get("repositories"),
				input,
				c.req.raw.signal
			),
		});
	} catch (error) {
		return handleAdminRouteError(c, error, "Playground request preview failed");
	}
});

adminPlaygroundRoutes.post("/", async (c) => {
	try {
		const input = await readInvocation(c.req.raw, false);
		const result = input.toolId
			? await invokePlaygroundTool(
					c.get("repositories"),
					input,
					c.req.raw.signal
			  )
			: await invokePlaygroundUpstream(
					c.get("repositories"),
					input,
					c.req.raw.signal
			  );
		const { response, upstreamUrlForHeader, latencyMs, upstreamWireBodyJson } =
			result;
		const redirectError = refusePlaygroundRedirect(response);
		if (redirectError) return redirectError;

		const headers = copyPlaygroundUpstreamHeaders(response.headers);
		headers.set("x-playground-latency-ms", String(latencyMs));
		headers.set("x-playground-upstream-status", String(response.status));
		headers.set("x-playground-upstream-url", upstreamUrlForHeader);
		headers.set(
			"x-playground-request-body",
			encodeURIComponent(upstreamWireBodyJson)
		);
		headers.set(
			"x-playground-request-body-truncated",
			String(upstreamWireBodyJson.includes('"__playground_truncated":true'))
		);
		headers.set("x-playground-mode", input.toolId ? "tool" : "route");
		headers.set(
			"x-playground-latency-scope",
			input.toolId
				? "catalog-and-engine-total"
				: "body-build-through-upstream-headers-and-control"
		);
		headers.set(
			"x-playground-upstream-outcome",
			response.headers.get("x-playground-upstream-outcome") ??
				(response.status >= 400 ? "unknown" : "response-received")
		);

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	} catch (error) {
		const response = handleAdminRouteError(
			c,
			error,
			"Playground invoke failed"
		);
		response.headers.set("x-playground-upstream-outcome", "unknown");
		return response;
	}
});
