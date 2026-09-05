import type { GatewayRepositories } from '@octafuse/core';
import { hashSessionToken } from '@/lib/auth';

export async function revokeCinaAuthBrowserSessions(
	tokens: readonly string[],
	repositories: {
		adminAccess: Pick<GatewayRepositories['adminAccess'], 'deleteSession'>;
		portalAccess: Pick<GatewayRepositories['portalAccess'], 'deleteSession'>;
	},
): Promise<void> {
	const hashes = await Promise.all([...new Set(tokens)].map(hashSessionToken));
	const outcomes = await Promise.allSettled(hashes.flatMap(hash => [
		repositories.adminAccess.deleteSession(hash),
		repositories.portalAccess.deleteSession(hash),
	]));
	const failed = outcomes.find(outcome => outcome.status === 'rejected');
	if (failed?.status === 'rejected') throw failed.reason;
}
