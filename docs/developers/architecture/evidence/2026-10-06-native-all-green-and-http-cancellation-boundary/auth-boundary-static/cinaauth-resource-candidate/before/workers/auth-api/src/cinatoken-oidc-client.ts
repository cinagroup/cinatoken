import {
	ADMIN_OIDC_CLIENT_SECRET_MIN_PAYLOAD_LENGTH,
	ADMIN_OIDC_CLIENT_SECRET_PREFIX,
} from "@cinaauth/auth-web-contract";
import { hashOidcClientSecret } from "./admin-oidc-client";

export const CINATOKEN_OIDC_CLIENT_ID = "cinatoken-admin";
const CINATOKEN_OIDC_SCOPES = ["openid", "profile", "email"] as const;

type CinatokenOidcClientDatabase = {
	query: (queryText: string, values: unknown[]) => Promise<unknown>;
};

export const isValidCinatokenOidcClientSecret = (
	secret: string | undefined,
): secret is string =>
	typeof secret === "string" &&
	secret.startsWith(ADMIN_OIDC_CLIENT_SECRET_PREFIX) &&
	secret.slice(ADMIN_OIDC_CLIENT_SECRET_PREFIX.length).length >=
		ADMIN_OIDC_CLIENT_SECRET_MIN_PAYLOAD_LENGTH;

/** Returns true only for an authorization request using the fixed cinatoken client. */
export const isCinatokenOidcAuthorizationRequest = (request: Request) => {
	if (request.method !== "GET") return false;
	const url = new URL(request.url);
	return (
		url.pathname === "/api/auth/oauth2/authorize" &&
		url.searchParams.get("client_id") === CINATOKEN_OIDC_CLIENT_ID
	);
};

/** Reconciles the fixed confidential cinatoken PKCE client. */
export const ensureCinatokenOidcClient = async (
	database: CinatokenOidcClientDatabase,
	clientSecret: string | undefined,
	applicationOrigin: string,
) => {
	if (!isValidCinatokenOidcClientSecret(clientSecret)) {
		throw new Error(
			`cinatoken OIDC client secret must start with ${ADMIN_OIDC_CLIENT_SECRET_PREFIX} and contain a strong payload`,
		);
	}
	const providerSecret = clientSecret.slice(
		ADMIN_OIDC_CLIENT_SECRET_PREFIX.length,
	);
	const now = new Date();
	const values: unknown[] = [
		`${CINATOKEN_OIDC_CLIENT_ID}:first-party`,
		CINATOKEN_OIDC_CLIENT_ID,
		await hashOidcClientSecret(providerSecret),
		false,
		false,
		true,
		"public",
		JSON.stringify([...CINATOKEN_OIDC_SCOPES]),
		null,
		null,
		now,
		now,
		"cinatoken Gateway",
		applicationOrigin,
		`${applicationOrigin}/favicon.ico`,
		JSON.stringify([`${applicationOrigin}/api/auth/cinaauth/callback`]),
		JSON.stringify([`${applicationOrigin}/`]),
		"client_secret_basic",
		JSON.stringify(["authorization_code"]),
		JSON.stringify(["code"]),
		false,
		"web",
		true,
		"cinatoken-gateway",
		"1.0.0",
	];

	await database.query(
		`INSERT INTO "oauthClient" (
			"id", "clientId", "clientSecret", "disabled", "skipConsent",
			"enableEndSession", "subjectType", "scopes", "userId", "referenceId",
			"createdAt", "updatedAt", "name", "uri", "icon", "redirectUris",
			"postLogoutRedirectUris", "tokenEndpointAuthMethod", "grantTypes",
			"responseTypes", "public", "type", "requirePKCE", "softwareId",
			"softwareVersion"
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
			$14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
		)
		ON CONFLICT ("clientId") DO UPDATE SET
			"clientSecret" = EXCLUDED."clientSecret",
			"disabled" = EXCLUDED."disabled",
			"skipConsent" = EXCLUDED."skipConsent",
			"enableEndSession" = EXCLUDED."enableEndSession",
			"subjectType" = EXCLUDED."subjectType",
			"scopes" = EXCLUDED."scopes",
			"userId" = NULL,
			"referenceId" = NULL,
			"updatedAt" = EXCLUDED."updatedAt",
			"name" = EXCLUDED."name",
			"uri" = EXCLUDED."uri",
			"icon" = EXCLUDED."icon",
			"redirectUris" = EXCLUDED."redirectUris",
			"postLogoutRedirectUris" = EXCLUDED."postLogoutRedirectUris",
			"tokenEndpointAuthMethod" = EXCLUDED."tokenEndpointAuthMethod",
			"grantTypes" = EXCLUDED."grantTypes",
			"responseTypes" = EXCLUDED."responseTypes",
			"public" = EXCLUDED."public",
			"type" = EXCLUDED."type",
			"requirePKCE" = EXCLUDED."requirePKCE",
			"softwareId" = EXCLUDED."softwareId",
			"softwareVersion" = EXCLUDED."softwareVersion"`,
		values,
	);
};
