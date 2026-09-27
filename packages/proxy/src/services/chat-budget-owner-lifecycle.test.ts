import assert from 'node:assert/strict';
import test from 'node:test';
import type { RouteAwareBudgetAdmission } from './request-budget-admission';
import type { PostgresChatBudgetRequestOwner } from './postgres-chat-budget-request-owner';
import { chatBudgetOwnerResourceCompletion } from './chat-budget-owner-lifecycle';

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}

function owner(close: () => Promise<void>): PostgresChatBudgetRequestOwner {
	return { close } as PostgresChatBudgetRequestOwner;
}

function admission(guardrail: () => Promise<void>, ordinary: () => Promise<void>): RouteAwareBudgetAdmission {
	return { terminateGuardrailUnknown: guardrail, ordinaryLease: { terminateUnknown: ordinary } } as unknown as RouteAwareBudgetAdmission;
}

test('streamed Chat owner remains open through background usage settlement', async () => {
	const usage = deferred();
	let closes = 0;
	const receipt = chatBudgetOwnerResourceCompletion(owner(async () => { closes++; }), null, usage.promise);
	await Promise.resolve();
	assert.equal(closes, 0);
	usage.resolve();
	assert.equal(await receipt, 'confirmed');
	assert.equal(closes, 1);
});

test('foreground error or cancellation terminates both budget ledgers before owner close', async () => {
	const ordinary = deferred();
	const events: string[] = [];
	const receipt = chatBudgetOwnerResourceCompletion(owner(async () => { events.push('close'); }),
		admission(async () => { events.push('guardrail'); }, async () => {
			events.push('ordinary-start'); await ordinary.promise; events.push('ordinary-done');
		}), null);
	await Promise.resolve();
	assert.deepEqual(events, ['guardrail', 'ordinary-start']);
	ordinary.resolve();
	assert.equal(await receipt, 'confirmed');
	assert.deepEqual(events, ['guardrail', 'ordinary-start', 'ordinary-done', 'close']);
});

test('failed foreground termination still closes clients and gives an unconfirmed receipt', async () => {
	const events: string[] = [];
	const receipt = chatBudgetOwnerResourceCompletion(owner(async () => { events.push('close'); }),
		admission(async () => { events.push('guardrail'); throw new Error('lost COMMIT'); },
			async () => { events.push('ordinary'); }), null);
	assert.equal(await receipt, 'unconfirmed');
	assert.deepEqual(events, ['guardrail', 'ordinary', 'close']);
});

test('failed background accounting or close cannot produce a confirmed cleanup receipt', async () => {
	let closes = 0;
	assert.equal(await chatBudgetOwnerResourceCompletion(owner(async () => { closes++; }), null,
		Promise.reject(new Error('usage write failed'))), 'unconfirmed');
	assert.equal(closes, 1);
	assert.equal(await chatBudgetOwnerResourceCompletion(owner(async () => { throw new Error('close failed'); }),
		null, Promise.resolve()), 'unconfirmed');
});
