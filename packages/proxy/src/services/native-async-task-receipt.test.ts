import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	signNativeAsyncTaskReceipt,
	verifyNativeAsyncTaskReceipt,
	type NativeAsyncTaskReceipt,
} from './native-async-task-receipt';
const secret = 'test-only-native-task-receipt-secret-at-least32';
const owner = { workspaceId: 'personal:user-1', userId: 'user-1', keyId: 'key-1' };
test('task receipts bind owner, task and immutable billing/route identity, reject tampering and expiration', async () => {
	const start = Date.now();
	const receipt: NativeAsyncTaskReceipt = {
		v: 1,
		taskId: 'task-1',
		requestLogId: crypto.randomUUID(),
		workspaceId: owner.workspaceId,
		userId: owner.userId,
		apiKeyId: owner.keyId,
		providerId: 'provider-1',
		targetId: 'route-1',
		providerKeyId: 'provider-key-1',
		modelId: 'asr',
		routeGroup: 'default',
		budgetEpoch: 4,
		reservedMicros: 10000,
		chargedCeiling: 0.01,
		startMs: start,
		exp: start + 60000,
		settledUpfront: true,
	};
	const token = await signNativeAsyncTaskReceipt(receipt, secret);
	assert.deepEqual(await verifyNativeAsyncTaskReceipt(token, secret, owner, 'task-1'), receipt);
	for (const changed of [
		{ ...owner, workspaceId: 'other' },
		{ ...owner, userId: 'other' },
		{ ...owner, keyId: 'other' },
	])
		assert.equal(await verifyNativeAsyncTaskReceipt(token, secret, changed, 'task-1'), null);
	assert.equal(await verifyNativeAsyncTaskReceipt(token, secret, owner, 'task-2'), null);
	assert.equal(await verifyNativeAsyncTaskReceipt(token, secret, owner, 'task-1', receipt.exp), null);
	assert.equal(await verifyNativeAsyncTaskReceipt(token, secret + 'rotated', owner, 'task-1'), null);
	const [payload, signature] = token.split('.');
	const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString());
	decoded.chargedCeiling = 0;
	assert.equal(
		await verifyNativeAsyncTaskReceipt(
			Buffer.from(JSON.stringify(decoded)).toString('base64url') + '.' + signature,
			secret,
			owner,
			'task-1',
		),
		null,
	);
	assert.equal(await verifyNativeAsyncTaskReceipt('x'.repeat(9000), secret, owner, 'task-1'), null);
	await assert.rejects(() => signNativeAsyncTaskReceipt(receipt, 'short'));
});
