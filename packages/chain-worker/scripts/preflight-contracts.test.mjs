import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const owner = '0xa1fBED1846E1fA0d7c1D44f60195F2Fc3dC23060';
const badge = '0x0a32Fc1302bf7765b386dE5Eae857c26D6C8E0ce';
const credit = '0x03A5637a465707cCD59dCe16c1965F4ac84b495A';

function run(args, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['scripts/preflight-contracts.mjs', ...args], {
			cwd: path.resolve(import.meta.dirname, '..'),
			env: { ...process.env, ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
		child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
		child.once('error', reject);
		child.once('exit', (code) => resolve({ code, stdout, stderr }));
	});
}

test('preflight proves chain, bytecode and owner without printing RPC credentials', async () => {
	const server = createServer(async (request, response) => {
		let body = '';
		request.setEncoding('utf8');
		for await (const chunk of request) body += chunk;
		const payload = JSON.parse(body);
		const result =
			payload.method === 'eth_chainId'
				? '0x14a34'
				: payload.method === 'eth_getCode'
					? '0x6000'
					: payload.method === 'eth_call'
						? `0x${'0'.repeat(24)}${owner.slice(2).toLowerCase()}`
						: null;
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	assert.equal(typeof address, 'object');
	const rpcUrl = `http://127.0.0.1:${address.port}/credential-that-must-not-print`;
	const directory = mkdtempSync(path.join(tmpdir(), 'cinatoken-chain-preflight-'));
	const deployment = path.join(directory, 'deployment.json');
	writeFileSync(
		deployment,
		JSON.stringify({ chainId: 84532, deployer: owner, contracts: { CinaBadge: badge, CinaCredit: credit } }),
	);
	try {
		const result = await run(['--deployment', deployment], {
			CINACHAIN_RPC_URL: rpcUrl,
			CINACHAIN_CHAIN_ID: '84532',
			CINACHAIN_MINTER_PRIVATE_KEY: '',
		});
		assert.equal(result.code, 0, result.stderr);
		assert.doesNotMatch(result.stdout + result.stderr, /credential-that-must-not-print/u);
		const output = JSON.parse(result.stdout);
		assert.equal(output.chainId, 84532);
		assert.equal(output.minterAddress, owner);
		assert.equal(output.contracts.CinaBadge.bytecodePresent, true);
		assert.equal(output.contracts.CinaCredit.owner, owner);

		const missingSecret = await run(['--deployment', deployment, '--require-private-key'], {
			CINACHAIN_RPC_URL: rpcUrl,
			CINACHAIN_MINTER_PRIVATE_KEY: '',
		});
		assert.equal(missingSecret.code, 1);
		assert.match(missingSecret.stderr, /CINACHAIN_MINTER_PRIVATE_KEY is missing/u);
	} finally {
		server.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
