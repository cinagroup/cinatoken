/** Wallet ownership verification using an expiring EIP-4361 (SIWE) challenge. */
import { Hono } from 'hono';
import type { UserEnv } from '@/lib/user-env';
import { verifyEvmMessage } from '@/lib/evm-signature';
import {
	createWalletChallenge,
	openWalletChallenge,
	sealWalletChallenge,
} from '@/lib/wallet-challenge';

export const userWalletRoutes = new Hono<UserEnv>();

function maskWallet(address: string): string {
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function challengeSecret(c: { env: UserEnv['Bindings'] }): string {
	const secret = c.env.CINATOKEN_OIDC_TRANSACTION_SECRET ?? process.env.CINATOKEN_OIDC_TRANSACTION_SECRET;
	if (!secret || secret.length < 32) throw new Error('Wallet challenge signing secret is missing');
	return secret;
}

userWalletRoutes.get('/', async (c) => {
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	await repositories.portalLedger.ensureUserEarnings(principal.userId);
	const earnings = await repositories.portalLedger.getUserEarnings(principal.userId);
	return c.json({
		success: true,
		data: {
			walletAddress: earnings?.walletAddress ?? null,
			walletMasked: earnings?.walletAddress ? maskWallet(earnings.walletAddress) : null,
			verifiedAt: earnings?.walletVerifiedAt ?? null,
		},
	});
});

userWalletRoutes.post('/challenge', async (c) => {
	const principal = c.get('principal');
	const body = (await c.req.json().catch(() => null)) as { walletAddress?: unknown } | null;
	if (typeof body?.walletAddress !== 'string') {
		return c.json({ success: false, message: 'Wallet address is required' }, 400);
	}
	try {
		const requestUrl = new URL(c.req.url);
		const challenge = createWalletChallenge({
			userId: principal.userId,
			address: body.walletAddress.trim(),
			origin: requestUrl.origin,
			chainId: Number(process.env.CINACHAIN_CHAIN_ID ?? 84532),
		});
		return c.json({
			success: true,
			data: {
				address: challenge.address,
				message: challenge.message,
				challengeToken: await sealWalletChallenge(challenge, challengeSecret(c)),
				expiresAt: new Date(challenge.expiresAt).toISOString(),
			},
		});
	} catch {
		return c.json({ success: false, message: 'Invalid EVM wallet address' }, 400);
	}
});

userWalletRoutes.post('/verify', async (c) => {
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	const body = (await c.req.json().catch(() => null)) as {
		challengeToken?: unknown;
		signature?: unknown;
	} | null;
	if (typeof body?.challengeToken !== 'string' || typeof body.signature !== 'string') {
		return c.json({ success: false, message: 'Challenge token and signature are required' }, 400);
	}
	const challenge = await openWalletChallenge(
		body.challengeToken,
		challengeSecret(c),
	);
	if (!challenge || challenge.userId !== principal.userId) {
		return c.json({ success: false, message: 'Wallet challenge is invalid or expired' }, 400);
	}
	await repositories.portalLedger.ensureUserEarnings(principal.userId);
	const earnings = await repositories.portalLedger.getUserEarnings(principal.userId);
	if (
		earnings?.walletVerifiedAt &&
		new Date(earnings.walletVerifiedAt).getTime() >= challenge.createdAt
	) {
		return c.json({ success: false, message: 'Wallet challenge has already been used' }, 409);
	}
	const valid = verifyEvmMessage({
		address: challenge.address,
		message: challenge.message,
		signature: body.signature,
	});
	if (!valid) return c.json({ success: false, message: 'Wallet signature is invalid' }, 400);

	const verifiedAt = new Date().toISOString();
	await repositories.portalLedger.updateWallet(
		principal.userId,
		challenge.address,
		verifiedAt,
	);
	return c.json({
		success: true,
		data: { walletAddress: challenge.address, verifiedAt },
	});
});

userWalletRoutes.post('/', (c) =>
	c.json(
		{ success: false, message: 'Direct wallet binding is disabled; complete SIWE verification.' },
		410,
	),
);
