import postgres from 'postgres';
import type { PostgresDatabaseClient } from '@octafuse/core';

const LOGINS = new Set([
	'cinatoken_gateway_runtime',
	'cinatoken_gateway_personal_key_auth',
	'cinatoken_gateway_complete_text_routing_projector',
	'cinatoken_gateway_complete_text_sticky_router',
	'cinatoken_gateway_request_capability_issuer',
	'cinatoken_gateway_complete_text_quote_issuer',
	'cinatoken_gateway_budget_admission',
	'cinatoken_gateway_complete_text_ingress_planner',
	'cinatoken_gateway_complete_text_private_reader',
	'cinatoken_gateway_complete_text_attempt_granter',
	'cinatoken_gateway_complete_text_send_holder',
	'cinatoken_gateway_complete_text_hold_renewer',
	'cinatoken_gateway_complete_text_recovery_worker',
	'cinatoken_gateway_complete_text_recovery_observer',
	'cinatoken_gateway_complete_text_no_fetch_resolver',
	'cinatoken_gateway_complete_text_platform_closer',
]);
type SqlClient = PostgresDatabaseClient['raw'];
type DriverOptions = { max: 1; prepare: false; fetch_types: false; connect_timeout: 3;
	idle_timeout: 0; max_lifetime: 0; backoff: false };
type Driver = (connectionString: string, options: DriverOptions) => SqlClient;

/**
 * Hyperdrive supplies transient transport credentials, distinct from the
 * PostgreSQL origin LOGIN. The role URL is an in-memory key for existing direct
 * clients; it is NEVER opened. The factory opens the original binding URL.
 * Every caller must retain its existing current_user/session_user transaction
 * check: this adapter does not attest the configured origin or grant a role.
 */
export function createHyperdriveDedicatedRoleTransportV390(
	binding: Pick<Hyperdrive, 'connectionString'>,
	expectedLogin: string,
	driver: Driver = postgres,
) {
	const original = binding?.connectionString;
	let url: URL;
	try { url = new URL(original); }
	catch { throw new TypeError('Dedicated Hyperdrive transport invalid'); }
	if (!LOGINS.has(expectedLogin) || typeof original !== 'string' || original !== original.trim()
		|| !['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname
		|| !url.username || !url.password || !url.pathname || url.pathname === '/' || url.hash
		|| [...url.searchParams].length > 1 || [...url.searchParams].some(([key, value]) =>
			key.toLowerCase() !== 'sslmode' || !['disable', 'require'].includes(value))) {
		throw new TypeError('Dedicated Hyperdrive transport or expected origin LOGIN invalid');
	}
	url.username = expectedLogin;
	const roleConnectionString = url.toString();
	return Object.freeze({
		roleConnectionString,
		createSql(connectionString: string, options: { max: 1 }): SqlClient {
			if (connectionString !== roleConnectionString || options?.max !== 1
				|| Object.keys(options).some(key => key !== 'max')) {
				throw new TypeError('Dedicated Hyperdrive transport key differs');
			}
			return driver(original, { max: 1, prepare: false, fetch_types: false,
				connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false });
		},
	});
}
