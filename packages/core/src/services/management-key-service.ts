import {
	assertManagementApiKeyAccount,
	MANAGEMENT_API_KEY_PREFIX,
	type ManagementApiKeyAccount,
	type ManagementApiKeyRow,
} from "../db/management-api-keys-types";
import { hashLookupKey, previewGatewayApiKey } from "../lib/key-hash";
import { normalizeFutureKeyExpiry } from "../lib/key-expiry";
import type { GatewayRepositories } from "../storage/repositories-types";

const MANAGEMENT_KEY_RANDOM_BYTES = 32;
const MANAGEMENT_KEY_NAME_MAX_LENGTH = 128;

function generateManagementApiKey(): string {
	const bytes = new Uint8Array(MANAGEMENT_KEY_RANDOM_BYTES);
	crypto.getRandomValues(bytes);
	const secret = Array.from(bytes, (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
	return `${MANAGEMENT_API_KEY_PREFIX}${secret}`;
}

function normalizeName(value: string): string {
	const name = value.trim();
	if (!name || name.length > MANAGEMENT_KEY_NAME_MAX_LENGTH) {
		throw new TypeError("management API key name is invalid");
	}
	return name;
}

export async function createManagementApiKey(
	repositories: GatewayRepositories,
	input: ManagementApiKeyAccount & {
		name: string;
		expiresAt?: string | null;
		createdByUserId: string;
		now?: Date;
	}
): Promise<{ key: string; data: ManagementApiKeyRow }> {
	assertManagementApiKeyAccount(input);
	const creator = await repositories.users.getById(input.createdByUserId);
	if (!creator || creator.status !== "active") {
		throw new Error("management API key creator is unavailable");
	}
	if (
		input.accountType === "personal" &&
		input.personalOwnerUserId !== input.createdByUserId
	) {
		throw new Error("personal management API key creator must own the account");
	}

	const key = generateManagementApiKey();
	const nowIso = (input.now ?? new Date()).toISOString();
	const id = crypto.randomUUID();
	await repositories.managementApiKeys.insert({
		id,
		keyHash: await hashLookupKey(key),
		keyPreview: previewGatewayApiKey(key),
		accountType: input.accountType,
		personalOwnerUserId: input.personalOwnerUserId,
		organizationId: input.organizationId,
		name: normalizeName(input.name),
		expiresAt: normalizeFutureKeyExpiry(
			input.expiresAt,
			nowIso,
			"Management"
		),
		createdByUserId: input.createdByUserId,
		nowIso,
	});
	const data = await repositories.managementApiKeys.getByIdInAccount(id, input);
	if (!data) throw new Error("management API key insert was not observable");
	return { key, data };
}
