import type { ExportedHandler, ScheduledController } from '@cloudflare/workers-types';
import type { CompleteTextNoFetchRecoveryV389Env } from './complete-text-no-fetch-recovery-v389-env';
import { runPostgresCompleteTextNoFetchRecoveryV389 } from '../services/postgres-complete-text-no-fetch-recovery-v389';
import { createHyperdriveDedicatedRoleTransportV390 } from '../services/hyperdrive-dedicated-role-transport-v390';

const ALLOWED_BINDINGS = new Set([
	'COMPLETE_TEXT_NO_FETCH_RECOVERY_ENABLED', 'COMPLETE_TEXT_RECOVERY_WORKER',
	'COMPLETE_TEXT_RECOVERY_OBSERVER', 'COMPLETE_TEXT_NO_FETCH_RESOLVER', 'COMPLETE_TEXT_PLATFORM_CLOSER',
]);

/** Separate scheduled composition; no request, Provider, money-operator or send authority. */
export async function runNoFetchRecoveryFromBindingsV389(
	controller: Pick<ScheduledController, 'cron'>,
	env: Partial<CompleteTextNoFetchRecoveryV389Env>,
	run: typeof runPostgresCompleteTextNoFetchRecoveryV389 = runPostgresCompleteTextNoFetchRecoveryV389,
) {
	if (!env || Object.keys(env).some(key => !ALLOWED_BINDINGS.has(key))) {
		throw new TypeError('No-fetch recovery Worker contains an unexpected authority');
	}
	if (env.COMPLETE_TEXT_NO_FETCH_RECOVERY_ENABLED === undefined
		|| env.COMPLETE_TEXT_NO_FETCH_RECOVERY_ENABLED === 'disabled') {
		return Object.freeze({ stopReason: 'disabled' as const });
	}
	if (env.COMPLETE_TEXT_NO_FETCH_RECOVERY_ENABLED !== 'reviewed-v1' || controller.cron !== '* * * * *') {
		throw new TypeError('No-fetch recovery activation or schedule invalid');
	}
	const workerConnectionString = env.COMPLETE_TEXT_RECOVERY_WORKER?.connectionString;
	const observerConnectionString = env.COMPLETE_TEXT_RECOVERY_OBSERVER?.connectionString;
	const resolverConnectionString = env.COMPLETE_TEXT_NO_FETCH_RESOLVER?.connectionString;
	const closerConnectionString = env.COMPLETE_TEXT_PLATFORM_CLOSER?.connectionString;
	if (!workerConnectionString || !observerConnectionString || !resolverConnectionString || !closerConnectionString
		|| new Set([workerConnectionString, observerConnectionString, resolverConnectionString, closerConnectionString]).size !== 4) {
		throw new TypeError('No-fetch recovery requires four distinct direct LOGIN bindings');
	}
	// Hyperdrive's transport username may be generated. Preserve its original
	// connection bytes and let each client attest the actual PostgreSQL role.
	const worker = createHyperdriveDedicatedRoleTransportV390({ connectionString: workerConnectionString },
		'cinatoken_gateway_complete_text_recovery_worker');
	const observer = createHyperdriveDedicatedRoleTransportV390({ connectionString: observerConnectionString },
		'cinatoken_gateway_complete_text_recovery_observer');
	const resolver = createHyperdriveDedicatedRoleTransportV390({ connectionString: resolverConnectionString },
		'cinatoken_gateway_complete_text_no_fetch_resolver');
	const closer = createHyperdriveDedicatedRoleTransportV390({ connectionString: closerConnectionString },
		'cinatoken_gateway_complete_text_platform_closer');
	const transports = [worker, observer, resolver, closer];
	return run(Object.freeze({ workerConnectionString: worker.roleConnectionString,
		observerConnectionString: observer.roleConnectionString,
		resolverConnectionString: resolver.roleConnectionString, closerConnectionString: closer.roleConnectionString }),
	undefined, { sqlFactory(connection, options) {
		const transport = transports.find(candidate => candidate.roleConnectionString === connection);
		if (!transport) throw new TypeError('No-fetch recovery binding transport differs');
		return transport.createSql(connection, options);
	} });
}

export const completeTextNoFetchRecoveryWorkerV389 = {
	fetch() {
		return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
	},
	scheduled(controller, env, ctx) {
		ctx.waitUntil(runNoFetchRecoveryFromBindingsV389(controller, env).catch(() => {
			// Database errors can contain bound parameters. Keep scheduled failure
			// visible without logging a connection string or private database row.
			throw new Error('No-fetch recovery invocation unconfirmed; durable work remains');
		}));
	},
} satisfies ExportedHandler<CompleteTextNoFetchRecoveryV389Env>;

export default completeTextNoFetchRecoveryWorkerV389;
