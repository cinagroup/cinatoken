import { createMiddleware } from "hono/factory";
import type { Env } from "../app";
import { GatewayErrorCode } from "../services/gateway-error-codes";
import { gatewayErrorJson } from "../services/gateway-error-response";
import { authenticateApiKey } from "../services/api-key-auth";
import { authenticateManagementApiKey } from "../services/management-api-key-auth";
import { throttleAuthFailure } from "./auth";

function bearerCredential(value: string | undefined): string | null {
	if (!value) return null;
	const match = /^Bearer[\t ]+([^\s]+)[\t ]*$/iu.exec(value);
	return match?.[1] ?? null;
}

/** Management endpoints accept only a Management Bearer key. */
export const requireManagementApiKey = createMiddleware<Env>(
	async (c, next) => {
		const secret = bearerCredential(c.req.header("Authorization"));
		const principal = secret
			? await authenticateManagementApiKey(c.get("repositories"), secret)
			: null;
		if (!principal) {
			return (
				(await throttleAuthFailure(c)) ??
				gatewayErrorJson(c, {
					status: 401,
					code: GatewayErrorCode.authFailed,
					message: "Missing or invalid Management API key",
				})
			);
		}
		c.set("managementKey", principal);
		await next();
	}
);

/**
 * OpenRouter Management APIs accept Management keys only.
 * A valid ordinary Gateway key is authenticated first and then rejected as a
 * 403 authorization failure; missing, malformed, revoked, or unknown
 * credentials remain 401 authentication failures.
 */
export const requireStrictManagementApiKey = createMiddleware<Env>(
	async (c, next) => {
		const secret = bearerCredential(c.req.header("Authorization"));
		if (!secret) {
			return (
				(await throttleAuthFailure(c)) ??
				gatewayErrorJson(c, {
					status: 401,
					code: GatewayErrorCode.authFailed,
					message: "Missing or invalid Management API key",
				})
			);
		}

		const repositories = c.get("repositories");
		const principal = await authenticateManagementApiKey(repositories, secret);
		if (principal) {
			c.set("managementKey", principal);
			await next();
			return;
		}

		const gatewayPrincipal = await authenticateApiKey(repositories, secret);
		if (gatewayPrincipal) {
			return gatewayErrorJson(c, {
				status: 403,
				code: GatewayErrorCode.permissionDenied,
				message: "Only management keys can perform this operation",
			});
		}

		return (
			(await throttleAuthFailure(c)) ??
			gatewayErrorJson(c, {
				status: 401,
				code: GatewayErrorCode.authFailed,
				message: "Missing or invalid Management API key",
			})
		);
	}
);

/** Backward-compatible name for the canonical per-model Endpoints API. */
export const requireModelEndpointsManagementApiKey = requireStrictManagementApiKey;
