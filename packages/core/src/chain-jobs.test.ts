import assert from 'node:assert/strict';
import test from 'node:test';
import { isChainJobMessage } from './chain-jobs';

test('accepts only bounded withdrawal and NFT queue messages', () => {
	assert.equal(isChainJobMessage({ kind: 'withdrawal', id: 'withdrawal-1' }), true);
	assert.equal(isChainJobMessage({ kind: 'nft_mint', id: 'mint-1' }), true);
	assert.equal(isChainJobMessage({ kind: 'other', id: 'job-1' }), false);
	assert.equal(isChainJobMessage({ kind: 'withdrawal', id: '' }), false);
	assert.equal(isChainJobMessage({ kind: 'withdrawal', id: 'x'.repeat(129) }), false);
	assert.equal(isChainJobMessage(null), false);
});
