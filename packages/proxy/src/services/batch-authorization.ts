import type { BatchRow, GatewayRepositories } from '@octafuse/core';
import {
	authenticateApiKeyByLookupHash,
	type AuthenticatedApiKey,
} from './api-key-auth';

export type AuthenticatedBatchApiKey = AuthenticatedApiKey & {
	/** Lowercase SHA-256 hex used by the synchronous BYOK allowlist path. */
	apiKeyHash: string;
};

export type BatchGatewayAuthorizationResult =
	| { status: 'authorized'; apiKey: AuthenticatedBatchApiKey }
	| { status: 'unauthorized'; reason: 'inactive' | 'snapshot_mismatch' };

/**
 * Recheck all mutable Gateway-key authorization state at consumption time and
 * bind the result back to the immutable tenant snapshot on the Batch row.
 */
export async function reauthorizeBatchGatewayKey(
	repos: GatewayRepositories,
	batch: Pick<
		BatchRow,
		'api_key_hash' | 'user_id' | 'workspace_id'
	>,
): Promise<BatchGatewayAuthorizationResult> {
	const auth = await authenticateApiKeyByLookupHash(repos, batch.api_key_hash);
	if (!auth) return { status: 'unauthorized', reason: 'inactive' };
	if (
		auth.userId !== batch.user_id ||
		auth.workspaceId !== batch.workspace_id
	) {
		return { status: 'unauthorized', reason: 'snapshot_mismatch' };
	}
	return {
		status: 'authorized',
		apiKey: {
			...auth,
			apiKeyHash: batch.api_key_hash.slice('sha256:'.length),
		},
	};
}
