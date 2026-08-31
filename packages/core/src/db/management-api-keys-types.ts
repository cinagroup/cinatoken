import type { WorkspaceScopeType } from "../workspaces";

export const MANAGEMENT_API_KEY_PREFIX = "sk-cina-mgmt-";
export const MANAGEMENT_API_KEY_STATUSES = ["active", "revoked"] as const;
export type ManagementApiKeyStatus =
	(typeof MANAGEMENT_API_KEY_STATUSES)[number];

export type ManagementApiKeyAccount = {
	accountType: WorkspaceScopeType;
	personalOwnerUserId: string | null;
	organizationId: string | null;
};

export interface ManagementApiKeyRow {
	id: string;
	key_hash: string;
	key_preview: string;
	account_type: WorkspaceScopeType;
	personal_owner_user_id: string | null;
	organization_id: string | null;
	name: string;
	status: ManagementApiKeyStatus;
	expires_at: string | null;
	last_used_at: string | null;
	created_by_user_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface InsertManagementApiKeyParams extends ManagementApiKeyAccount {
	id: string;
	keyHash: string;
	keyPreview: string;
	name: string;
	expiresAt: string | null;
	createdByUserId: string;
	nowIso: string;
}

export interface ManagementApiKeyPrincipal extends ManagementApiKeyAccount {
	keyId: string;
	createdByUserId: string | null;
}

export function assertManagementApiKeyAccount(
	account: ManagementApiKeyAccount
): void {
	const personal =
		account.accountType === "personal" &&
		typeof account.personalOwnerUserId === "string" &&
		account.personalOwnerUserId.length > 0 &&
		account.personalOwnerUserId.length <= 512 &&
		account.organizationId === null;
	const organization =
		account.accountType === "organization" &&
		account.personalOwnerUserId === null &&
		typeof account.organizationId === "string" &&
		account.organizationId.length > 0 &&
		account.organizationId.length <= 255;
	if (!personal && !organization) {
		throw new TypeError("management API key account scope is invalid");
	}
}

export function managementApiKeyAccountFromRow(
	row: ManagementApiKeyRow
): ManagementApiKeyAccount {
	const account = {
		accountType: row.account_type,
		personalOwnerUserId: row.personal_owner_user_id,
		organizationId: row.organization_id,
	};
	assertManagementApiKeyAccount(account);
	return account;
}
