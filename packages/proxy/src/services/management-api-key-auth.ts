import {
	MANAGEMENT_API_KEY_PREFIX,
	managementApiKeyAccountFromRow,
	type GatewayRepositories,
	type ManagementApiKeyPrincipal,
} from "@octafuse/core";

const MANAGEMENT_API_KEY_PATTERN = new RegExp(
	`^${MANAGEMENT_API_KEY_PREFIX}[0-9a-f]{64}$`,
	"u"
);

/** Authenticate only the non-inference Management credential namespace. */
export async function authenticateManagementApiKey(
	repositories: GatewayRepositories,
	secret: string
): Promise<ManagementApiKeyPrincipal | null> {
	if (!MANAGEMENT_API_KEY_PATTERN.test(secret)) return null;
	const row = await repositories.managementApiKeys.getActiveBySecret(secret);
	if (!row) return null;
	return {
		...managementApiKeyAccountFromRow(row),
		keyId: row.id,
		createdByUserId: row.created_by_user_id,
	};
}
