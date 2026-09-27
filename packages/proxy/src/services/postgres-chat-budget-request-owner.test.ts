import assert from 'node:assert/strict';
import test from 'node:test';
import type { PostgresDatabaseClient } from '@octafuse/core';
import {
	openPostgresChatBudgetRequestOwner,
	PostgresChatBudgetRequestCleanupUnconfirmedError,
} from './postgres-chat-budget-request-owner';
import type { openPostgresOrdinaryBudgetRequestOwner } from './postgres-ordinary-budget-request-owner';
import type { openPostgresGuardrailBudgetRequestPortV356 } from './postgres-guardrail-budget-request-port-v356';

const params = {
	runtimeClient: { driver: 'postgres' } as PostgresDatabaseClient,
	runtimeConnectionString: 'postgres://runtime@localhost/gateway',
	admissionConnectionString: 'postgres://admission@localhost/gateway',
	recoveryConnectionString: 'postgres://recovery@localhost/gateway',
	identity: { requestId: 'request-1', userId: 'user-1', apiKeyId: 'key-1', expectedBudgetEpoch: 3 },
};

test('Chat budget owner fixes one identity across both direct LOGIN ports and closes both', async () => {
	const events: string[] = [];
	const ordinaryRepositories = { userBudgets: {} };
	const guardrailPort = { identity: { requestId: 'request-1', userId: 'user-1', apiKeyId: 'key-1' },
		close: async () => { events.push('guardrail-close'); } };
	const owner = await openPostgresChatBudgetRequestOwner(params, {
		ordinary: (async values => {
			assert.deepEqual(values.identity, params.identity);
			events.push('ordinary-open');
			return { ordinaryBudgetRepositories: ordinaryRepositories,
				close: async () => { events.push('ordinary-close'); } };
		}) as typeof openPostgresOrdinaryBudgetRequestOwner,
		guardrail: (async values => {
			assert.deepEqual({ requestId: values.requestId, userId: values.userId, apiKeyId: values.apiKeyId },
				{ requestId: params.identity.requestId, userId: params.identity.userId, apiKeyId: params.identity.apiKeyId });
			events.push('guardrail-open');
			return guardrailPort;
		}) as typeof openPostgresGuardrailBudgetRequestPortV356,
	});
	assert.equal(owner.ordinaryBudgetRepositories, ordinaryRepositories);
	assert.equal(owner.guardrailBudgetRequestPort, guardrailPort);
	await owner.close();
	await owner.close();
	assert.deepEqual(events, ['ordinary-open', 'guardrail-open', 'ordinary-close', 'guardrail-close']);
});

test('failed Guardrail open closes Ordinary; failed partial-open close has an explicit unconfirmed receipt', async () => {
	let closes = 0;
	const guardrail = (async () => { throw new Error('guardrail open failed'); }) as typeof openPostgresGuardrailBudgetRequestPortV356;
	await assert.rejects(openPostgresChatBudgetRequestOwner(params, {
		ordinary: (async () => ({ ordinaryBudgetRepositories: { userBudgets: {} },
			close: async () => { closes++; } })) as typeof openPostgresOrdinaryBudgetRequestOwner,
		guardrail,
	}), /guardrail open failed/);
	assert.equal(closes, 1);
	await assert.rejects(openPostgresChatBudgetRequestOwner(params, {
		ordinary: (async () => ({ ordinaryBudgetRepositories: { userBudgets: {} },
			close: async () => { throw new Error('ordinary close failed'); } })) as typeof openPostgresOrdinaryBudgetRequestOwner,
		guardrail,
	}), PostgresChatBudgetRequestCleanupUnconfirmedError);
});
