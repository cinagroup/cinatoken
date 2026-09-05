import type {
	ByokKeyInsertParams,
	ByokKeyUpdateParams,
	ByokRuntimeKeyRow,
} from '../db/byok-keys-types';
import type { ByokKeysRepository } from '../storage/gateway-repository-interfaces';
import {
	assertSharedKeyEncryptionSecret,
	decryptSharedKeySecret,
	encryptSharedKeySecret,
	isEncryptedSharedKeySecret,
} from './shared-key-encryption';

function byokContext(row: {
	id: string;
	workspace_id: string;
	provider: string;
}): string {
	return `cinatoken:byok-key:${row.id}:${row.workspace_id}:${row.provider}`;
}

/**
 * Encrypts BYOK writes and reveals plaintext only to the inference runtime lookup.
 * Management list/get/create/update responses remain metadata-only and therefore
 * never decrypt provider credentials.
 */
export function createEncryptedByokKeysRepository(
	repository: ByokKeysRepository,
	secret: string,
): ByokKeysRepository {
	assertSharedKeyEncryptionSecret(secret);

	const revealRuntime = async (
		row: ByokRuntimeKeyRow,
	): Promise<ByokRuntimeKeyRow> => {
		if (!isEncryptedSharedKeySecret(row.api_key)) {
			throw new Error('BYOK credential is not encrypted at rest');
		}
		return {
			...row,
			api_key: await decryptSharedKeySecret(
				row.api_key,
				secret,
				byokContext(row),
			),
		};
	};

	return {
		...repository,
		async insertForManagement(params: ByokKeyInsertParams) {
			return repository.insertForManagement({
				...params,
				input: {
					...params.input,
					apiKey: await encryptSharedKeySecret(
						params.input.apiKey,
						secret,
						byokContext({
							id: params.id,
							workspace_id: params.input.workspaceId,
							provider: params.input.provider,
						}),
					),
				},
			});
		},
		async updateForManagement(params: ByokKeyUpdateParams) {
			if (params.patch.apiKey === undefined) {
				return repository.updateForManagement(params);
			}
			const account = {
				accountType: params.principal.accountType,
				personalOwnerUserId: params.principal.personalOwnerUserId,
				organizationId: params.principal.organizationId,
			};
			const current = await repository.getByIdInAccount(params.id, account);
			if (!current) return null;
			return repository.updateForManagement({
				...params,
				patch: {
					...params.patch,
					apiKey: await encryptSharedKeySecret(
						params.patch.apiKey,
						secret,
						byokContext(current),
					),
				},
			});
		},
		async listActiveForRequest(params) {
			const rows = await repository.listActiveForRequest(params);
			return Promise.all(rows.map(revealRuntime));
		},
		shouldSuppressSharedCapacityForRequest(params) {
			return repository.shouldSuppressSharedCapacityForRequest(params);
		},
	};
}
