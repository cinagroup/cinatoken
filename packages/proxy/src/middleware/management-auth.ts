import { createMiddleware } from "hono/factory";
import type { Env } from "../app";
import { GatewayErrorCode } from "../services/gateway-error-codes";
import { gatewayErrorJson } from "../services/gateway-error-response";
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
