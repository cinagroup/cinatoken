import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { PostgresDatabaseClient } from '@octafuse/core';
import {
	renewPostgresCompleteTextHoldsV367,
	PostgresCompleteTextHoldRenewalCleanupUnconfirmedError,
	PostgresCompleteTextHoldRenewalRejectedError,
} from './postgres-complete-text-hold-renewal-v369';

const CONNECTION = 'postgres://cinatoken_gateway_complete_text_hold_renewer:synthetic@localhost:5432/synthetic?sslmode=disable';
const GRANT_ID = '77777777-7777-7777-7777-777777777777';
const RUN_ID = '88888888-8888-8888-8888-888888888888';
const START_ID = '99999999-9999-9999-9999-999999999999';
const now = Date.parse('2026-09-25T12:00:00.000Z');
const later = new Date(now + 30_000).toISOString();
const roleRow = {
	current_role: 'cinatoken_gateway_complete_text_hold_renewer',
	session_role: 'cinatoken_gateway_complete_text_hold_renewer',
	transaction_isolation: 'read committed',
};
const recorded = Object.freeze({ status: 'renewal_recorded',
	grantId: GRANT_ID, holderRunId: RUN_ID, sendStartId: START_ID,
	leaseEpoch: 2, leaseUntil: later });

type Client = PostgresDatabaseClient['raw'];
function fakeClient(value: unknown, events: string[], opts: {
	commitFails?: boolean; closeFails?: boolean; role?: Record<string, unknown>;
	afterRole?: () => void; afterClose?: () => void;
} = {}) {
	const client = {
		async begin<T>(run: (tx: { unsafe: (query: string, args?: unknown[]) => Promise<unknown> }) => Promise<T>) {
			events.push('begin');
			const result = await run({
				async unsafe(query: string, args?: unknown[]) {
					if (query.includes('current_user')) {
						events.push('role'); opts.afterRole?.(); return [opts.role ?? roleRow];
					}
					assert.match(query,/renew_complete_text_holds_v367/u);
					assert.deepEqual(args,[GRANT_ID,RUN_ID,START_ID,1]);
					events.push('renew');
					return [{ value }];
				},
			});
			if (opts.commitFails) throw new Error('COMMIT ACK unknown');
			events.push('commit');
			return result;
		},
		end({ timeout }: { timeout: number }) {
			assert.equal(timeout,1);
			events.push('close');
			opts.afterClose?.();
			return opts.closeFails ? Promise.reject(new Error('close ACK unknown'))
				: Promise.resolve();
		},
	};
	return (connection: string, config: { max: 1 }) => {
		assert.equal(connection,CONNECTION);
		assert.deepEqual(config,{max:1});
		return client as unknown as Client;
	};
}

const request = () => ({ renewerConnectionString: CONNECTION,
	grantId: GRANT_ID, holderRunId: RUN_ID, sendStartId: START_ID,
	expectedEpoch: 1, nowMs: () => now });

it('returns a new deadline only after COMMIT and dedicated LOGIN close ACK', async () => {
	const events: string[] = [];
	const result = await renewPostgresCompleteTextHoldsV367(request(),
		fakeClient(recorded,events));
	assert.deepEqual(events,['begin','role','renew','commit','close']);
	assert.deepEqual(result,{...recorded,commitAcknowledged:true,
		closeAcknowledged:true});
	assert.equal(Object.isFrozen(result),true);
});

it('captures the frozen IDs and expected epoch before the database await', async () => {
	const params=request();
	const result=await renewPostgresCompleteTextHoldsV367(params,
		fakeClient(recorded,[],{afterRole:()=>{
			params.grantId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
			params.holderRunId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
			params.sendStartId='cccccccc-cccc-cccc-cccc-cccccccccccc';
			params.expectedEpoch=9;
		}}));
	assert.equal(result.grantId,GRANT_ID);
	assert.equal(result.leaseEpoch,2);
});

it('denies replay and stale statuses without trying a new epoch', async () => {
	for (const status of ['already_recorded','stale_epoch','lease_expired',
		'holder_binding_differs']) {
		const events: string[]=[];
		await assert.rejects(renewPostgresCompleteTextHoldsV367(request(),
			fakeClient({status},events)),error=>{
			assert.ok(error instanceof PostgresCompleteTextHoldRenewalRejectedError);
			assert.equal(error.status,status);
			return true;
		});
		assert.deepEqual(events,['begin','role','renew','commit','close']);
	}
});

it('rejects an uncertain COMMIT or close ACK without returning the deadline', async () => {
	for (const [label,opts] of [
		['commit',{commitFails:true}],['close',{closeFails:true}],
	] as const) {
		const events: string[]=[];
		await assert.rejects(renewPostgresCompleteTextHoldsV367(request(),
			fakeClient(recorded,events,opts)),label==='close'
				? PostgresCompleteTextHoldRenewalCleanupUnconfirmedError:Error);
		assert.equal(events.filter(x=>x==='renew').length,1);
		assert.equal(events.at(-1),'close');
	}
});

it('requires the exact URL username and direct session role', async () => {
	for (const url of [
		CONNECTION.replace('hold_renewer','send_holder'),
		CONNECTION+'#fragment',
		CONNECTION.replace('sslmode=disable','sslmode=prefer'),
	]) {
		await assert.rejects(renewPostgresCompleteTextHoldsV367({
			...request(),renewerConnectionString:url,
		},()=>{assert.fail('invalid URL reached factory');}),TypeError);
	}
	const events: string[]=[];
	await assert.rejects(renewPostgresCompleteTextHoldsV367(request(),
		fakeClient(recorded,events,{role:{...roleRow,
			session_role:'cinatoken_gateway_runtime'}})),TypeError);
	assert.deepEqual(events,['begin','role','close']);
});

it('rejects mismatched, malformed or expired result after close', async () => {
	for (const value of [
		{...recorded,leaseEpoch:3},
		{...recorded,sendStartId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'},
		{...recorded,leaseUntil:'not-a-date'},
		[],
	]) {
		const events: string[]=[];
		await assert.rejects(renewPostgresCompleteTextHoldsV367(request(),
			fakeClient(value,events)),TypeError);
		assert.equal(events.at(-1),'close');
	}
	let observedNow=now;
	await assert.rejects(renewPostgresCompleteTextHoldsV367({
		...request(),nowMs:()=>observedNow,
	},fakeClient(recorded,[],{afterClose:()=>{
		observedNow=Date.parse(later)+1;
	}})),TypeError);
});

it('rejects invalid frozen inputs before opening a connection', async () => {
	for (const params of [
		{...request(),expectedEpoch:0},
		{...request(),expectedEpoch:Number.MAX_SAFE_INTEGER},
		{...request(),grantId:'not-uuid'},
		{...request(),sendStartId:'not-uuid'},
	]) {
		await assert.rejects(renewPostgresCompleteTextHoldsV367(params,
			()=>{assert.fail('invalid input reached factory');}),TypeError);
	}
});
