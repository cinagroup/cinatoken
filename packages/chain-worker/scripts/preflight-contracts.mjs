import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createPublicClient, getAddress, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ownerAbi = parseAbi(['function owner() view returns (address)']);

function argument(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? null : process.argv[index + 1] ?? null;
}

function loadPublicEnv(file) {
	if (!file) return {};
	const entries = {};
	for (const rawLine of fs.readFileSync(path.resolve(file), 'utf8').split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const separator = line.indexOf('=');
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim();
		let value = line.slice(separator + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		entries[key] = value;
	}
	return entries;
}

function contractAddress(deployment, name, override) {
	const value = override || deployment?.contracts?.[name];
	if (typeof value !== 'string') throw new Error(`${name} address is missing`);
	return getAddress(value);
}

async function main() {
	const envFile = argument('--env-file');
	const deploymentFile = argument('--deployment');
	if (!deploymentFile) throw new Error('--deployment <file> is required');
	const publicEnv = loadPublicEnv(envFile);
	const deployment = JSON.parse(fs.readFileSync(path.resolve(deploymentFile), 'utf8'));
	const requirePrivateKey = process.argv.includes('--require-private-key');

	const rpcUrl = process.env.CINACHAIN_RPC_URL?.trim() || publicEnv.NEXT_PUBLIC_BASE_RPC?.trim();
	if (!rpcUrl) throw new Error('CINACHAIN_RPC_URL or NEXT_PUBLIC_BASE_RPC is missing');
	const expectedChainId = Number(
		process.env.CINACHAIN_CHAIN_ID || publicEnv.CINACHAIN_CHAIN_ID || deployment.chainId,
	);
	if (!Number.isSafeInteger(expectedChainId) || expectedChainId <= 0) {
		throw new Error('Expected chain id is invalid');
	}

	const privateKey = process.env.CINACHAIN_MINTER_PRIVATE_KEY?.trim();
	if (requirePrivateKey && !privateKey) {
		throw new Error('CINACHAIN_MINTER_PRIVATE_KEY is missing from the process environment');
	}
	const declaredMinter =
		process.env.CINACHAIN_MINTER_ADDRESS ||
		publicEnv.CINACHAIN_MINTER_ADDRESS ||
		deployment.deployer;
	if (!privateKey && !declaredMinter) throw new Error('A declared minter address is missing');
	const minterAddress = privateKey
		? privateKeyToAccount(privateKey).address
		: getAddress(declaredMinter);
	const badgeAddress = contractAddress(
		deployment,
		'CinaBadge',
		process.env.CINABADGE_CONTRACT_ADDRESS || publicEnv.CINABADGE_CONTRACT_ADDRESS,
	);
	const creditAddress = contractAddress(
		deployment,
		'CinaCredit',
		process.env.CINACREDIT_CONTRACT_ADDRESS || publicEnv.CINACREDIT_CONTRACT_ADDRESS,
	);

	const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000 }) });
	const chainId = await client.getChainId();
	if (chainId !== expectedChainId) {
		throw new Error(`RPC chain id ${chainId} does not match expected ${expectedChainId}`);
	}

	const contracts = {};
	for (const [name, address] of [
		['CinaBadge', badgeAddress],
		['CinaCredit', creditAddress],
	]) {
		const [bytecode, owner] = await Promise.all([
			client.getBytecode({ address }),
			client.readContract({ address, abi: ownerAbi, functionName: 'owner' }),
		]);
		if (!bytecode || bytecode === '0x') throw new Error(`${name} has no deployed bytecode`);
		const normalizedOwner = getAddress(owner);
		if (normalizedOwner !== minterAddress) {
			throw new Error(`${name} owner does not match the configured minter address`);
		}
		contracts[name] = { address, owner: normalizedOwner, bytecodePresent: true };
	}

	console.log(
		JSON.stringify(
			{
				chainId,
				minterAddress,
				minterEvidence: privateKey ? 'derived-from-process-secret' : 'declared-public-address',
				contracts,
			},
			null,
			2,
		),
	);
}

main().catch((error) => {
	console.error(`[chain-preflight] ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
