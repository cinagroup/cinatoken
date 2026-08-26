import assert from 'node:assert/strict';
import test from 'node:test';
import { hashLookupKey } from './key-hash';

test('audit M2: lookup keys hash deterministically with the sha256 prefix', async () => {
	const a = await hashLookupKey('sk-admin-' + 'ab'.repeat(32));
	const b = await hashLookupKey('sk-admin-' + 'ab'.repeat(32));
	const c = await hashLookupKey('sk-admin-' + 'cd'.repeat(32));
	assert.equal(a, b);
	assert.notEqual(a, c);
	assert.equal(a.startsWith('sha256:'), true);
	assert.equal(a.length, 'sha256:'.length + 64);
	// 已知向量：SHA-256("abc") 的十六进制
	const known = await hashLookupKey('abc');
	assert.equal(known, 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
