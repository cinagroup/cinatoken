// Local workerd fixture. All SQL clients are in-memory fakes; no database is contacted.
import type { Context } from 'hono';
import type { StorageContext } from '@octafuse/core';
import type { PostgresDatabaseClient } from '../../../../core/src/storage/database-client';
import type { Env } from '../../app';
import { openWorkerPostgresImageRecoveryOwner } from '../worker-postgres-image-producer-owner';

const runtimeUrl = 'postgresql://synthetic:opaque@runtime.invalid/gateway?sslmode=disable';
const dispatchUrl = 'postgresql://synthetic:opaque@dispatch.invalid/gateway?sslmode=disable';
const factUrl = 'postgresql://synthetic:opaque@fact.invalid/gateway?sslmode=require';
const roleQuery = 'SELECT current_user AS current_role, session_user AS session_role';

function sql(role: string, sessionRole: string, label: string, closed: string[], rejectClose: boolean) {
	return {
		async unsafe(query: string) {
			if (query !== roleQuery) throw new Error('Unexpected SQL in workerd fixture');
			return [{ current_role: role, session_role: sessionRole }];
		},
		async end(options: { timeout: number }) {
			if (options.timeout !== 1) throw new Error('Unexpected close timeout');
			closed.push(label);
			if (rejectClose) throw new Error('Synthetic close failure');
		},
	} as unknown as PostgresDatabaseClient['raw'];
}

export default {
	async fetch(request: Request): Promise<Response> {
		const scenario = new URL(request.url).pathname.slice(1);
		const created: Array<{ label: string; max: number }> = [];
		const closed: string[] = [];
		const runtimeBinding = { connectionString: runtimeUrl };
		const dispatchBinding = { connectionString: dispatchUrl };
		const factBinding = { connectionString: factUrl };
		const bindings = {
			DATABASE_DRIVER: 'postgres',
			HYPERDRIVE: runtimeBinding,
			DISPATCH_HYPERDRIVE: dispatchBinding,
			FACT_HYPERDRIVE: factBinding,
		};
		if (scenario === 'missing_binding') bindings.FACT_HYPERDRIVE = undefined as never;
		if (scenario === 'shared_binding') bindings.FACT_HYPERDRIVE = dispatchBinding;
		if (scenario === 'query_override') bindings.FACT_HYPERDRIVE = {
			connectionString: `${factUrl}&user=cinatoken_gateway_runtime`,
		};
		const runtimeRole = scenario === 'runtime_wrong'
			? 'cinatoken_gateway_fact_producer' : 'cinatoken_gateway_runtime';
		const runtimeSql = sql(runtimeRole, runtimeRole, 'runtime', closed, false);
		const context = { env: bindings } as unknown as Context<Env>;
		const storage = { client: { driver: 'postgres', raw: runtimeSql } } as StorageContext;
		try {
			const owner = await openWorkerPostgresImageRecoveryOwner(context, storage, (url, options) => {
				const label = url === dispatchUrl ? 'dispatch' : url === factUrl ? 'fact' : 'unexpected';
				created.push({ label, max: options.max });
				if (label === 'unexpected') throw new Error('Unexpected producer URL');
				const expected = label === 'dispatch'
					? 'cinatoken_gateway_dispatch_producer' : 'cinatoken_gateway_fact_producer';
				const current = scenario === 'producer_wrong' || scenario === 'cleanup_failure'
					? label === 'dispatch' ? 'cinatoken_gateway_fact_producer' : expected
					: expected;
				const session = scenario === 'session_wrong' && label === 'dispatch'
					? 'cinatoken_gateway_runtime' : current;
				return sql(current, session, label, closed, scenario === 'cleanup_failure' && label === 'dispatch');
			});
			await owner.close();
			await owner.close();
			return Response.json({ outcome: 'opened', created, closed });
		} catch (error) {
			return Response.json({ outcome: 'rejected', name: error instanceof Error ? error.name : 'Unknown',
				message: error instanceof Error ? error.message : String(error), created, closed });
		}
	},
};
