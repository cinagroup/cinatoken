import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, parseAbi } from 'viem';
import { encodeBadgeMint, encodeCreditMint } from './cinachain';

const recipient = '0x0000000000000000000000000000000000000001';

test('encodes the owner-only CinaCredit mintTo call exactly', () => {
	const decoded = decodeFunctionData({
		abi: parseAbi(['function mintTo(address to, uint256 amount) external']),
		data: encodeCreditMint(recipient, 123n),
	});
	assert.equal(decoded.functionName, 'mintTo');
	assert.deepEqual(decoded.args, [recipient, 123n]);
});

test('encodes one soulbound badge unit for the selected tier', () => {
	const decoded = decodeFunctionData({
		abi: parseAbi(['function mint(address to, uint256 tokenId, uint256 amount) external']),
		data: encodeBadgeMint(recipient, 4),
	});
	assert.equal(decoded.functionName, 'mint');
	assert.deepEqual(decoded.args, [recipient, 4n, 1n]);
});
