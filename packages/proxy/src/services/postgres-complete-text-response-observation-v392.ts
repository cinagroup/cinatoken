import postgres from 'postgres';
import type { PostgresDatabaseClient } from '@octafuse/core';
import { canonicalResponseObservationV392, responseObservationNonceV392,
	type CompleteTextResponseObservationInputV392, type CommittedCompleteTextResponseObservationV392 } from './complete-text-response-observation-v392';

type SqlClient = PostgresDatabaseClient['raw'];
type SqlFactory = (connection: string, options: { max: 1 }) => SqlClient;
type Tx = Pick<SqlClient, 'unsafe'>;
const ROLE = 'cinatoken_gateway_complete_text_send_holder';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const FIELDS = 'evidenceNonce,factId,grantId,holderRunId,observationId,observationSha256,requestId,sendStartId,status';

export class PostgresResponseObservationCleanupUnconfirmedV392 extends Error {
	constructor(cause: unknown) { super('Response observation LOGIN cleanup unconfirmed', { cause }); this.name = 'PostgresResponseObservationCleanupUnconfirmedV392'; }
}

/** Checks the receipt inside the transaction; exposes it only after COMMIT and close ACK. */
export async function appendPostgresCompleteTextResponseObservationV392(
	params: CompleteTextResponseObservationInputV392 & { holderConnectionString: string }, factory: SqlFactory = postgres,
): Promise<CommittedCompleteTextResponseObservationV392> {
	const input = Object.freeze({ ...params, observation: Object.freeze({ ...params.observation }) });
	const canonical = canonicalResponseObservationV392(input.observation);
	if (input.expectedEpoch !== 1 || input.evidenceNonce !== responseObservationNonceV392(input.grantId, input.holderRunId, input.sendStartId))
		throw new TypeError('Response observation identity invalid');
	let url: URL;
	try { url = new URL(input.holderConnectionString); } catch { throw new TypeError('Response observation connection invalid'); }
	if (input.holderConnectionString !== input.holderConnectionString.trim()
		|| !['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== ROLE || !url.password
		|| !url.hostname || !url.pathname || url.pathname === '/' || url.hash
		|| [...url.searchParams].length > 1 || [...url.searchParams].some(([k, v]) => k !== 'sslmode' || !['require', 'disable'].includes(v)))
		throw new TypeError('Response observation direct LOGIN invalid');
	const sql = factory(input.holderConnectionString, { max: 1 });
	let result: Omit<CommittedCompleteTextResponseObservationV392, 'commitAcknowledged' | 'closeAcknowledged'> | undefined;
	let failure: unknown;
	try {
		result = await (sql as unknown as { begin<T>(cb: (tx: Tx) => Promise<T>): Promise<T> }).begin(async tx => {
			const roles = await tx.unsafe("SELECT current_user AS current_role, session_user AS session_role, current_setting('transaction_isolation') AS transaction_isolation");
			if (roles.length !== 1 || roles[0]?.current_role !== ROLE || roles[0]?.session_role !== ROLE || roles[0]?.transaction_isolation !== 'read committed')
				throw new TypeError('Response observation direct LOGIN mismatch');
			await tx.unsafe("SET LOCAL lock_timeout='2s'"); await tx.unsafe("SET LOCAL statement_timeout='15s'");
			const rows = await tx.unsafe('SELECT cinatoken_gateway.append_complete_text_response_observation_v392($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::uuid,$6::text::jsonb) AS value',
				[input.grantId, input.holderRunId, input.sendStartId, input.expectedEpoch, input.evidenceNonce, canonical.text]);
			const row = rows.length === 1 ? rows[0]?.value as Record<string, unknown> : undefined;
			if (!row || Object.keys(row).sort().join(',') !== FIELDS
				|| !['observation_recorded', 'already_recorded'].includes(row.status as string)
				|| row.grantId !== input.grantId || row.holderRunId !== input.holderRunId || row.sendStartId !== input.sendStartId
				|| row.evidenceNonce !== input.evidenceNonce || row.observationSha256 !== canonical.digest
				|| typeof row.requestId !== 'string' || !row.requestId || row.requestId.length > 128
				|| typeof row.observationId !== 'string' || !UUID.test(row.observationId) || typeof row.factId !== 'string' || !UUID.test(row.factId))
				throw new TypeError('Response observation receipt invalid');
			return Object.freeze(row) as NonNullable<typeof result>;
		});
	} catch (error) { failure = error; }
	try {
		const closed = sql.end({ timeout: 1 });
		if (!closed || typeof closed.then !== 'function') throw new Error('LOGIN close did not acknowledge');
		await closed;
	} catch (error) { throw new PostgresResponseObservationCleanupUnconfirmedV392(failure === undefined ? error : new AggregateError([failure, error])); }
	if (failure !== undefined) throw failure;
	if (!result) throw new TypeError('Response observation result missing');
	return Object.freeze({ ...result, commitAcknowledged: true, closeAcknowledged: true });
}
