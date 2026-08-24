export type ChainJobMessage =
	| { kind: 'withdrawal'; id: string }
	| { kind: 'nft_mint'; id: string };

export function isChainJobMessage(value: unknown): value is ChainJobMessage {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		(candidate.kind === 'withdrawal' || candidate.kind === 'nft_mint') &&
		typeof candidate.id === 'string' &&
		candidate.id.length > 0 &&
		candidate.id.length <= 128
	);
}
