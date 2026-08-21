/**
 * cinachain（Base Sepolia，chainId 84532）链上服务：CinaBadge 铸造 / CinaCredit 提现。
 *
 * 合约为 cinachain 仓库已部署的实例；服务端持有 owner EOA 私钥执行 owner-only
 * `mint` / `mintTo`。所有链上操作幂等性由数据库状态机保证（nft_mints /
 * withdrawals 的 pending → submitted → confirmed）。
 *
 * 环境变量：
 * - CINACHAIN_RPC_URL（默认 https://sepolia.base.org）
 * - CINACHAIN_CHAIN_ID（默认 84532）
 * - CINABADGE_CONTRACT_ADDRESS（CinaBadge ERC-1155）
 * - CINACREDIT_CONTRACT_ADDRESS（CinaCredit ERC-20）
 * - CINACHAIN_MINTER_PRIVATE_KEY（owner EOA，仅服务端）
 */
import {
	createPublicClient,
	createWalletClient,
	http,
	parseAbi,
	formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const CINA_BADGE_ABI = parseAbi([
	'function mint(address to, uint256 tokenId, uint256 amount) external',
	'function createBadgeType(string name, string description, bool soulbound, uint256 maxSupply) external',
	'function balanceOf(address account, uint256 id) external view returns (uint256)',
]);

const CINA_CREDIT_ABI = parseAbi([
	'function mintTo(address to, uint256 amount) external',
	'function balanceOf(address account) external view returns (uint256)',
	'function decimals() external view returns (uint8)',
]);

export type CinachainRuntime = {
	rpcUrl: string;
	chainId: number;
	badgeAddress: `0x${string}`;
	creditAddress: `0x${string}`;
	accountAddress: `0x${string}`;
};

export class CinachainNotConfiguredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CinachainNotConfiguredError';
	}
}

function readEnv(name: string): string | undefined {
	const value = process.env[name];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function resolveCinachainRuntime(): CinachainRuntime {
	const rpcUrl = readEnv('CINACHAIN_RPC_URL') ?? 'https://sepolia.base.org';
	const chainId = Number(readEnv('CINACHAIN_CHAIN_ID') ?? 84532);
	const badgeAddress = readEnv('CINABADGE_CONTRACT_ADDRESS');
	const creditAddress = readEnv('CINACREDIT_CONTRACT_ADDRESS');
	const privateKey = readEnv('CINACHAIN_MINTER_PRIVATE_KEY');
	if (!badgeAddress || !creditAddress || !privateKey) {
		throw new CinachainNotConfiguredError(
			'cinachain env missing: CINABADGE_CONTRACT_ADDRESS / CINACREDIT_CONTRACT_ADDRESS / CINACHAIN_MINTER_PRIVATE_KEY',
		);
	}
	const account = privateKeyToAccount(privateKey as `0x${string}`);
	return {
		rpcUrl,
		chainId,
		badgeAddress: badgeAddress as `0x${string}`,
		creditAddress: creditAddress as `0x${string}`,
		accountAddress: account.address,
	};
}

export function isCinachainConfigured(): boolean {
	try {
		resolveCinachainRuntime();
		return true;
	} catch {
		return false;
	}
}

const chainById = (chainId: number) => {
	if (chainId === baseSepolia.id) return baseSepolia;
	// 自定义链（如 Base 主网 8453）：以 Base Sepolia 模板派生
	return { ...baseSepolia, id: chainId };
};

export type SimulateOnly = { simulateOnly?: boolean };

/**
 * 服务端铸造 CinaBadge（ERC-1155，owner-only mint）。
 * 返回 txHash；`simulateOnly` 仅做 eth_call 预检（不签名、不上链）。
 */
export async function mintCinaBadge(
	to: `0x${string}`,
	tokenId: number,
	options?: SimulateOnly,
): Promise<`0x${string}`> {
	const runtime = resolveCinachainRuntime();
	const account = privateKeyToAccount((readEnv('CINACHAIN_MINTER_PRIVATE_KEY') as `0x${string}`));
	const walletClient = createWalletClient({
		account,
		chain: chainById(runtime.chainId),
		transport: http(runtime.rpcUrl),
	});
	const publicClient = createPublicClient({
		chain: chainById(runtime.chainId),
		transport: http(runtime.rpcUrl),
	});
	const { request } = await publicClient.simulateContract({
		address: runtime.badgeAddress,
		abi: CINA_BADGE_ABI,
		functionName: 'mint',
		args: [to, BigInt(tokenId), BigInt(1)],
		account: account.address,
	});
	if (options?.simulateOnly) {
		return '0x0000000000000000000000000000000000000000000000000000000000000000';
	}
	const txHash = await walletClient.writeContract(request);
	return txHash;
}

/**
 * 服务端增发 CinaCredit（ERC-20，owner-only mintTo）作为提现到账。
 * `tokenAmount` 为最小单位整数（调用方换算好 decimals，默认 18）。
 */
export async function mintCinaCredit(
	to: `0x${string}`,
	tokenAmount: bigint,
	options?: SimulateOnly,
): Promise<`0x${string}`> {
	const runtime = resolveCinachainRuntime();
	const account = privateKeyToAccount((readEnv('CINACHAIN_MINTER_PRIVATE_KEY') as `0x${string}`));
	const walletClient = createWalletClient({
		account,
		chain: chainById(runtime.chainId),
		transport: http(runtime.rpcUrl),
	});
	const publicClient = createPublicClient({
		chain: chainById(runtime.chainId),
		transport: http(runtime.rpcUrl),
	});
	const { request } = await publicClient.simulateContract({
		address: runtime.creditAddress,
		abi: CINA_CREDIT_ABI,
		functionName: 'mintTo',
		args: [to, tokenAmount],
		account: account.address,
	});
	if (options?.simulateOnly) {
		return '0x0000000000000000000000000000000000000000000000000000000000000000';
	}
	const txHash = await walletClient.writeContract(request);
	return txHash;
}

/** 轮询等待交易回执；超时抛错（由状态机标记 failed，可人工重试）。 */
export async function waitForCinachainReceipt(
	txHash: `0x${string}`,
	timeoutMs = 120_000,
): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint }> {
	const runtime = resolveCinachainRuntime();
	const publicClient = createPublicClient({
		chain: chainById(runtime.chainId),
		transport: http(runtime.rpcUrl),
	});
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const receipt = await publicClient.getTransactionReceipt({ hash: txHash }).catch(() => null);
		if (receipt) {
			return { status: receipt.status === 'success' ? 'success' : 'reverted', blockNumber: receipt.blockNumber };
		}
		if (Date.now() > deadline) {
			throw new Error(`cinachain receipt timeout for ${txHash}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 3_000));
	}
}

/** 18 decimals 换算（CinaCredit 标准 ERC-20 精度）。 */
export function toTokenUnits(amount: number): bigint {
	return BigInt(Math.round(amount * 1_000_000_000_000_000_000));
}

export function formatTokenUnits(units: bigint): string {
	return formatUnits(units, 18);
}

export { CINA_BADGE_ABI, CINA_CREDIT_ABI };
