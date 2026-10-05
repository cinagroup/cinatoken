/** User-owned EOA wallet verification; workspace is only a session precondition. */
import { Hono } from "hono";
import type { UserEnv } from "@/lib/user-env";
import { verifyEvmMessage } from "@/lib/evm-signature";
import { getPublicRequestUrl } from "@/lib/public-request-url";
import {
	createWalletChallenge,
	openWalletChallenge,
	sealWalletChallenge,
} from "@/lib/wallet-challenge";

export const userWalletRoutes = new Hono<UserEnv>();
userWalletRoutes.use("*", async (c, next) => {
	c.header("Cache-Control", "private, no-store");
	if (!c.get("principal").capabilities?.includes("wallet.manage"))
		return c.json(
			{ success: false, message: "Wallet access is not available" },
			403
		);
	await next();
});
function signingSecret(env: UserEnv["Bindings"]): string | null {
	const secret =
		env.CINATOKEN_OIDC_TRANSACTION_SECRET ??
		process.env.CINATOKEN_OIDC_TRANSACTION_SECRET;
	return secret && secret.length >= 32 ? secret : null;
}
export function walletChainId(env?: UserEnv["Bindings"]): number | null {
	const configured = env
		? (Reflect.get(env, "CINACHAIN_CHAIN_ID") as unknown)
		: undefined;
	const value = Number(configured ?? process.env.CINACHAIN_CHAIN_ID ?? 84532);
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}
userWalletRoutes.get("/", async (c) => {
	const principal = c.get("principal");
	const ledger = c.get("repositories").portalLedger;
	await ledger.ensureUserEarnings(principal.userId);
	const earnings = await ledger.getUserEarnings(principal.userId);
	return c.json({
		success: true,
		userId: principal.userId,
		workspaceId: c.get("workspaceContext").currentWorkspace.id,
		availability:
			signingSecret(c.env) && walletChainId(c.env)
				? "available"
				: "unavailable",
		chainId: walletChainId(c.env),
		data: {
			walletAddress: earnings?.walletAddress ?? null,
			walletMasked: earnings?.walletAddress
				? `${earnings.walletAddress.slice(0, 6)}…${earnings.walletAddress.slice(
						-4
				  )}`
				: null,
			verifiedAt: earnings?.walletVerifiedAt ?? null,
		},
	});
});
userWalletRoutes.post("/challenge", async (c) => {
	const principal = c.get("principal");
	const body = (await c.req.json().catch(() => null)) as {
		walletAddress?: unknown;
	} | null;
	if (typeof body?.walletAddress !== "string")
		return c.json(
			{ success: false, message: "Wallet address is required" },
			400
		);
	const secret = signingSecret(c.env);
	const chainId = walletChainId(c.env);
	if (!secret || !chainId)
		return c.json(
			{ success: false, message: "Wallet verification is not configured" },
			503
		);
	try {
		const origin = getPublicRequestUrl(c.req.raw).origin;
		const challenge = createWalletChallenge({
			userId: principal.userId,
			address: body.walletAddress.trim(),
			origin,
			chainId,
		});
		return c.json({
			success: true,
			userId: principal.userId,
			workspaceId: c.get("workspaceContext").currentWorkspace.id,
			data: {
				address: challenge.address,
				message: challenge.message,
				challengeToken: await sealWalletChallenge(challenge, secret),
				origin,
				chainId,
				issuedAt: new Date(challenge.createdAt).toISOString(),
				expiresAt: new Date(challenge.expiresAt).toISOString(),
			},
		});
	} catch {
		return c.json(
			{
				success: false,
				message: "Invalid EVM wallet address or public origin",
			},
			400
		);
	}
});
userWalletRoutes.post("/verify", async (c) => {
	const ledger = c.get("repositories").portalLedger;
	const principal = c.get("principal");
	const body = (await c.req.json().catch(() => null)) as {
		challengeToken?: unknown;
		signature?: unknown;
	} | null;
	if (
		typeof body?.challengeToken !== "string" ||
		typeof body.signature !== "string"
	)
		return c.json(
			{ success: false, message: "Challenge token and signature are required" },
			400
		);
	const secret = signingSecret(c.env);
	if (!secret)
		return c.json(
			{ success: false, message: "Wallet verification is not configured" },
			503
		);
	const challenge = await openWalletChallenge(body.challengeToken, secret);
	if (!challenge || challenge.userId !== principal.userId)
		return c.json(
			{ success: false, message: "Wallet challenge is invalid or expired" },
			400
		);
	let origin: string;
	try {
		origin = getPublicRequestUrl(c.req.raw).origin;
	} catch {
		return c.json({ success: false, message: "Invalid public origin" }, 400);
	}
	if (
		!challenge.message.includes(`\nURI: ${origin}\n`) ||
		!challenge.message.includes(`\nChain ID: ${walletChainId(c.env)}\n`)
	)
		return c.json(
			{
				success: false,
				message: "Wallet challenge context changed; request a new challenge",
			},
			400
		);
	if (
		!verifyEvmMessage({
			address: challenge.address,
			message: challenge.message,
			signature: body.signature,
		})
	)
		return c.json(
			{ success: false, message: "Wallet signature is invalid" },
			400
		);
	// Invalid signatures never create a ledger. The conditional UPDATE consumes the
	// challenge cutoff atomically, so concurrent/replayed signatures cannot win twice.
	await ledger.ensureUserEarnings(principal.userId);
	const verifiedAt = new Date().toISOString();
	const accepted = await ledger.updateWalletIfChallengeUnused(
		principal.userId,
		challenge.address,
		verifiedAt,
		new Date(challenge.createdAt).toISOString()
	);
	if (!accepted)
		return c.json(
			{ success: false, message: "Wallet challenge has already been used" },
			409
		);
	return c.json({
		success: true,
		userId: principal.userId,
		workspaceId: c.get("workspaceContext").currentWorkspace.id,
		data: { walletAddress: challenge.address, verifiedAt },
	});
});
userWalletRoutes.post("/", (c) =>
	c.json(
		{
			success: false,
			message: "Direct wallet binding is disabled; complete SIWE verification.",
		},
		410
	)
);
