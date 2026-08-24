import {
	createPublicClient,
	createWalletClient,
	encodeFunctionData,
	http,
	keccak256,
	parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

export type SignerEnv = {
	CINACHAIN_RPC_URL: string;
	CINACHAIN_CHAIN_ID: string;
	CINACHAIN_MINTER_PRIVATE_KEY: string;
	CINABADGE_CONTRACT_ADDRESS: string;
	CINACREDIT_CONTRACT_ADDRESS: string;
};

const BADGE_ABI = parseAbi(['function mint(address to, uint256 tokenId, uint256 amount) external']);
const CREDIT_ABI = parseAbi(['function mintTo(address to, uint256 amount) external']);

export function encodeCreditMint(to: `0x${string}`, amount: bigint) {
	return encodeFunctionData({
		abi: CREDIT_ABI,
		functionName: 'mintTo',
		args: [to, amount],
	});
}

export function encodeBadgeMint(to: `0x${string}`, tokenId: number) {
	return encodeFunctionData({
		abi: BADGE_ABI,
		functionName: 'mint',
		args: [to, BigInt(tokenId), 1n],
	});
}

function runtime(env: SignerEnv) {
	const chainId = Number(env.CINACHAIN_CHAIN_ID);
	if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('Invalid CINACHAIN_CHAIN_ID');
	const chain = chainId === baseSepolia.id ? baseSepolia : { ...baseSepolia, id: chainId };
	const account = privateKeyToAccount(env.CINACHAIN_MINTER_PRIVATE_KEY as `0x${string}`);
	const transport = http(env.CINACHAIN_RPC_URL);
	return {
		chain,
		account,
		publicClient: createPublicClient({ chain, transport }),
		walletClient: createWalletClient({ chain, transport, account }),
	};
}

export type PreparedChainTransaction = {
	hash: `0x${string}`;
	rawTransaction: `0x${string}`;
};

async function prepareContractTransaction(
	env: SignerEnv,
	address: `0x${string}`,
	data: `0x${string}`,
): Promise<PreparedChainTransaction> {
	const clients = runtime(env);
	const request = await clients.walletClient.prepareTransactionRequest({
		account: clients.account,
		to: address,
		data,
	});
	const rawTransaction = await clients.walletClient.signTransaction(request);
	return { hash: keccak256(rawTransaction), rawTransaction };
}

export function prepareCredit(env: SignerEnv, to: `0x${string}`, amount: bigint) {
	return prepareContractTransaction(
		env,
		env.CINACREDIT_CONTRACT_ADDRESS as `0x${string}`,
		encodeCreditMint(to, amount),
	);
}

export function prepareBadge(env: SignerEnv, to: `0x${string}`, tokenId: number) {
	return prepareContractTransaction(
		env,
		env.CINABADGE_CONTRACT_ADDRESS as `0x${string}`,
		encodeBadgeMint(to, tokenId),
	);
}

export async function broadcastPreparedTransaction(
	env: SignerEnv,
	rawTransaction: `0x${string}`,
) {
	return runtime(env).publicClient.sendRawTransaction({ serializedTransaction: rawTransaction });
}

export async function waitForReceipt(env: SignerEnv, hash: `0x${string}`) {
	const { publicClient } = runtime(env);
	const receipt = await publicClient.waitForTransactionReceipt({
		hash,
		confirmations: 1,
		timeout: 90_000,
	});
	return receipt.status;
}
