import {
	ADMIN_OIDC_CLIENT_ID,
	ADMIN_OIDC_CLIENT_SECRET_MIN_PAYLOAD_LENGTH,
	ADMIN_OIDC_CLIENT_SECRET_PREFIX,
	ADMIN_OIDC_SCOPES,
} from "@cinaauth/auth-web-contract";

type AdminOidcClientDatabase = {
	query: (queryText: string, values: unknown[]) => Promise<unknown>;
};

const bytesToBase64Url = (bytes: Uint8Array) => {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
};

/** Hashes a confidential OIDC client secret using the provider storage format. */
export const hashOidcClientSecret = async (secret: string) => {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(secret),
	);
	return bytesToBase64Url(new Uint8Array(digest));
};

/** Returns true only for an authorization request using the fixed Admin client. */
export const isAdminOidcAuthorizationRequest = (request: Request) => {
	if (request.method !== "GET") return false;
	const url = new URL(request.url);
	return (
		url.pathname === "/api/auth/oauth2/authorize" &&
		url.searchParams.get("client_id") === ADMIN_OIDC_CLIENT_ID
	);
};

/** Reconciles the fixed confidential Admin OIDC client. */
export const ensureAdminOidcClient = async (
	database: AdminOidcClientDatabase,
	clientSecret: string | undefined,
	adminOrigin: string,
) => {
	if (!clientSecret?.startsWith(ADMIN_OIDC_CLIENT_SECRET_PREFIX)) {
		throw new Error(
			`Admin OIDC client secret must start with ${ADMIN_OIDC_CLIENT_SECRET_PREFIX}`,
		);
	}
	const providerSecret = clientSecret.slice(
		ADMIN_OIDC_CLIENT_SECRET_PREFIX.length,
	);
	if (providerSecret.length < ADMIN_OIDC_CLIENT_SECRET_MIN_PAYLOAD_LENGTH) {
		throw new Error(
			`Admin OIDC client secret payload must contain at least ${ADMIN_OIDC_CLIENT_SECRET_MIN_PAYLOAD_LENGTH} characters`,
		);
	}

	const now = new Date();
	const storedSecret = await hashOidcClientSecret(providerSecret);
	const redirectUri = `${adminOrigin}/api/auth/oidc/callback`;
	const postLogoutRedirectUri = `${adminOrigin}/login`;
	const values: unknown[] = [
		`${ADMIN_OIDC_CLIENT_ID}:first-party`,
		ADMIN_OIDC_CLIENT_ID,
		storedSecret,
		false,
		false,
		true,
		"public",
		JSON.stringify([...ADMIN_OIDC_SCOPES]),
		null,
		null,
		now,
		now,
		"CinaSeek Admin Console",
		adminOrigin,
		`${adminOrigin}/favicon.ico`,
		JSON.stringify([redirectUri]),
		JSON.stringify([postLogoutRedirectUri]),
		"client_secret_basic",
		JSON.stringify(["authorization_code"]),
		JSON.stringify(["code"]),
		"web",
		true,
		"cinaseek-admin-console",
		"1.0.0",
	];

	await database.query(
		`INSERT INTO "oauthClient" (
			"id", "clientId", "clientSecret", "disabled", "skipConsent",
			"enableEndSession", "subjectType", "scopes", "userId", "referenceId",
			"createdAt", "updatedAt", "name", "uri", "icon", "redirectUris",
			"postLogoutRedirectUris", "tokenEndpointAuthMethod", "grantTypes",
			"responseTypes", "applicationType", "requirePKCE", "softwareId",
			"softwareVersion"
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
			$14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
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
			"applicationType" = EXCLUDED."applicationType",
			"requirePKCE" = EXCLUDED."requirePKCE",
			"softwareId" = EXCLUDED."softwareId",
			"softwareVersion" = EXCLUDED."softwareVersion"`,
		values,
	);

	// First-party resource bindings are required by the 1.7 provider. Preserve
	// operator-managed resource policy, including an intentional disablement.
	await database.query(
		`INSERT INTO "oauthResource" ("id", "identifier", "name", "createdAt", "updatedAt")
		 VALUES ($1, $2, $3, $4, $4)
		 ON CONFLICT ("identifier") DO NOTHING`,
		[`first-party:${adminOrigin}`, adminOrigin, "CinaSeek Admin Console", now],
	);
	await database.query(
		`INSERT INTO "oauthClientResource" ("id", "clientId", "resourceId", "createdAt")
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT DO NOTHING`,
		[
			`${ADMIN_OIDC_CLIENT_ID}:${adminOrigin}`,
			ADMIN_OIDC_CLIENT_ID,
			adminOrigin,
			now,
		],
	);
};
