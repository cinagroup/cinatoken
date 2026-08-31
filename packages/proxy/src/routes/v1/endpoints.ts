/** Authenticated OpenRouter-compatible endpoint discovery surfaces. */
import { Hono } from "hono";
import type { Env } from "../../app";
import type { ApiKeyContext } from "../../middleware/auth";
import { requireApiKey } from "../../middleware/auth";
import { GatewayErrorCode } from "../../services/gateway-error-codes";
import { gatewayErrorJson } from "../../services/gateway-error-response";
import {
	getPublicImageModelEndpoints,
	getPublicModelEndpoints,
	listPublicImageModels,
	listVerifiedZdrPublicEndpoints,
	parseModelEndpointPath,
} from "../../services/public-model-endpoints";

type EndpointsEnv = Env & { Variables: { apiKey: ApiKeyContext } };

// CinaToken's safe equivalent policy is any valid Gateway Bearer key with no
// inference-budget charge. OpenRouter's distinct management-key role is not
// represented in the current identity model and must not be inferred here.
export const endpointDiscoveryRoutes = new Hono<EndpointsEnv>();

endpointDiscoveryRoutes.get(
	"/models/:author/:slug/endpoints",
	requireApiKey,
	async (c) => {
		const path = parseModelEndpointPath(
			c.req.param("author"),
			c.req.param("slug")
		);
		if (!path) {
			return gatewayErrorJson(c, {
				status: 404,
				code: GatewayErrorCode.modelNotFound,
				message: "Resource not found",
			});
		}
		try {
			const data = await getPublicModelEndpoints(c.get("repositories"), path);
			if (!data) {
				return gatewayErrorJson(c, {
					status: 404,
					code: GatewayErrorCode.modelNotFound,
					message: "Resource not found",
				});
			}
			c.header("Cache-Control", "private, no-store");
			return c.json({ data });
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "endpoint discovery failed",
					model_id: path.canonicalModelId,
					error_type: error instanceof Error ? error.name : "UnknownError",
				})
			);
			return gatewayErrorJson(c, {
				status: 500,
				code: GatewayErrorCode.internalError,
				message: "Endpoint discovery failed",
			});
		}
	}
);

endpointDiscoveryRoutes.get("/endpoints/zdr", requireApiKey, async (c) => {
	try {
		const data = await listVerifiedZdrPublicEndpoints(c.get("repositories"));
		c.header("Cache-Control", "private, no-store");
		return c.json({ data });
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "ZDR endpoint discovery failed",
				error_type: error instanceof Error ? error.name : "UnknownError",
			})
		);
		return gatewayErrorJson(c, {
			status: 500,
			code: GatewayErrorCode.internalError,
			message: "ZDR endpoint discovery failed",
		});
	}
});

endpointDiscoveryRoutes.get("/images/models", requireApiKey, async (c) => {
	try {
		const data = await listPublicImageModels(c.get("repositories"));
		c.header("Cache-Control", "private, no-store");
		return c.json({ data });
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "image model discovery failed",
				error_type: error instanceof Error ? error.name : "UnknownError",
			})
		);
		return gatewayErrorJson(c, {
			status: 500,
			code: GatewayErrorCode.internalError,
			message: "Image model discovery failed",
		});
	}
});

endpointDiscoveryRoutes.get(
	"/images/models/:author/:slug/endpoints",
	requireApiKey,
	async (c) => {
		const path = parseModelEndpointPath(
			c.req.param("author"),
			c.req.param("slug")
		);
		if (!path)
			return gatewayErrorJson(c, {
				status: 404,
				code: GatewayErrorCode.modelNotFound,
				message: "Resource not found",
			});
		try {
			const data = await getPublicImageModelEndpoints(
				c.get("repositories"),
				path
			);
			if (!data)
				return gatewayErrorJson(c, {
					status: 404,
					code: GatewayErrorCode.modelNotFound,
					message: "Resource not found",
				});
			c.header("Cache-Control", "private, no-store");
			return c.json(data);
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "image endpoint discovery failed",
					model_id: path.canonicalModelId,
					error_type: error instanceof Error ? error.name : "UnknownError",
				})
			);
			return gatewayErrorJson(c, {
				status: 500,
				code: GatewayErrorCode.internalError,
				message: "Image endpoint discovery failed",
			});
		}
	}
);
