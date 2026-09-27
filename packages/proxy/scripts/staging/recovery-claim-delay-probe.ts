import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';

// Staging operator capability only: never imported by a production/default Worker.
export const RECOVERY_CLAIM_DELAY_KEY = 'c02_recovery_claim_delay_v1';
export const RECOVERY_CLAIM_DELAY_DESCRIPTION = 'c02-recovery-claim-delay-v1';
export const RECOVERY_CLAIM_DELAY_MS = 6000;
type Phase = 'armed' | 'held' | 'released';
const pattern = /^v1\|(staging-recovery-[a-f0-9-]{36})\|(gen-[a-f0-9-]{36})\|(armed|held|released)$/;
export function recoveryClaimDelayValue(fixtureId: string, requestId: string, phase: Phase): string {
	const value = `v1|${fixtureId}|${requestId}|${phase}`;
	if (!pattern.test(value)) throw new Error('C02_CLAIM_DELAY_INVALID_IDENTITY');
	return value;
}
const normalize = (sql: string) => sql.trim().replace(/\s+/g, ' ');
// Deliberately pinned to the reviewed repository claim. Drift must be reviewed.
const CLAIM_SQL = normalize(`UPDATE request_usage_recovery_jobs SET
 state=CASE WHEN attempts<5 THEN 'leased' ELSE 'blocked' END,revision=revision+1,
 lease_token=CASE WHEN attempts<5 THEN ? ELSE NULL END,
 lease_expires_at=CASE WHEN attempts<5 THEN unixepoch('now')+? ELSE NULL END,
 available_at=CASE WHEN attempts<5 THEN unixepoch('now')+? ELSE NULL END,
 last_error=CASE WHEN attempts<5 THEN NULL ELSE 'retry_exhausted' END,
 attempts=MIN(attempts+1,5),updated_at=unixepoch('now')
 WHERE request_id=? AND user_id=? AND api_key_id=? AND workspace_id=? AND payload_sha256=?
 AND revision=? AND state IN ('pending','leased') AND available_at<=unixepoch('now') RETURNING *`);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Retains the ORIGINAL native claim result until a one-shot delay finishes.
 * It never edits jobs, snapshots, lease proof, budgets or repository clocks.
 * All reads/writes and the timer are owned by the existing host waitUntil hold.
 */
export function withRecoveryClaimDelayProbe(db: D1Database): D1Database {
	const entries = new WeakMap<D1PreparedStatement, { native: D1PreparedStatement; claim: boolean }>();
	async function transition(before: string, after: string) {
		const changed = await db.prepare('UPDATE system_config SET value=? WHERE key=? AND description=? AND value=?')
			.bind(after, RECOVERY_CLAIM_DELAY_KEY, RECOVERY_CLAIM_DELAY_DESCRIPTION, before).run();
		if (!changed.success || changed.meta.changes !== 1) throw new Error('C02_CLAIM_DELAY_OWNERSHIP_CHANGED');
	}
	function wrap(native: D1PreparedStatement, sql: string, values: unknown[] = []): D1PreparedStatement {
		const normalized = normalize(sql), claim = normalized === CLAIM_SQL;
		if (!claim && /^UPDATE request_usage_recovery_jobs SET\b/i.test(normalized)
			&& /\blease_token\s*=\s*CASE\b/i.test(normalized)) throw new Error('C02_CLAIM_DELAY_CLAIM_SQL_DRIFT');
		const unsupported = () => { throw new Error('C02_CLAIM_DELAY_UNSUPPORTED_CLAIM_MODE'); };
		const statement: D1PreparedStatement = {
			bind: (...bound) => wrap(native.bind(...bound), sql, [...bound]),
			first: claim ? unsupported : native.first.bind(native),
			run: claim ? unsupported : native.run.bind(native),
			raw: claim ? unsupported : native.raw.bind(native),
			async all<T>(): Promise<D1Result<T>> {
				if (!claim) return native.all<T>();
				const row = await db.prepare(`SELECT CASE WHEN description=? AND typeof(value)='text'
					AND length(CAST(value AS BLOB))<=160 THEN value ELSE '' END AS probe
					FROM system_config WHERE key=? LIMIT 1`)
					.bind(RECOVERY_CLAIM_DELAY_DESCRIPTION, RECOVERY_CLAIM_DELAY_KEY).first<{ probe: string }>();
				if (row === null) return native.all<T>();
				const control = typeof row.probe === 'string' ? pattern.exec(row.probe) : null;
				if (!control) throw new Error('C02_CLAIM_DELAY_INVALID_CONTROL');
				const [, fixtureId, requestId, phase] = control;
				if (values.length !== 9) throw new Error('C02_CLAIM_DELAY_CLAIM_SHAPE_CHANGED');
				if (values[3] !== requestId || values[4] !== fixtureId + '-user'
					|| values[5] !== fixtureId + '-key' || values[6] !== fixtureId + '-workspace') return native.all<T>();
				if (phase === 'released') return native.all<T>();
				if (phase !== 'armed' || values[8] !== 0) throw new Error('C02_CLAIM_DELAY_NOT_INITIAL_ARMED_CLAIM');
				const result = await native.all<T>();
				// A failed CAS is not ownership: no pause, transition or fabricated success.
				if (result.success && result.meta.changes === 0) return result;
				const job: unknown = result.results[0];
				if (!result.success || result.meta.changes !== 1 || result.results.length !== 1 || !isRecord(job)
					|| job.request_id !== requestId || job.user_id !== values[4] || job.api_key_id !== values[5]
					|| job.workspace_id !== values[6] || job.payload_sha256 !== values[7] || job.lease_token !== values[0]
					|| job.state !== 'leased' || job.revision !== 1 || job.attempts !== 1)
					throw new Error('C02_CLAIM_DELAY_INVALID_NATIVE_RESULT');
				const held = recoveryClaimDelayValue(fixtureId, requestId, 'held');
				await transition(row.probe, held);
				await new Promise<void>(resolve => setTimeout(resolve, RECOVERY_CLAIM_DELAY_MS));
				// Real D1 I/O also advances Workers' I/O-based clock after the timer.
				await transition(held, recoveryClaimDelayValue(fixtureId, requestId, 'released'));
				return result;
			},
		};
		entries.set(statement, { native, claim });
		return statement;
	}
	return {
		prepare: sql => wrap(db.prepare(sql), sql),
		batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
			const native = statements.map(statement => {
				const entry = entries.get(statement);
				if (!entry || entry.claim) throw new Error('C02_CLAIM_DELAY_FOREIGN_OR_BATCHED_CLAIM');
				return entry.native;
			});
			return db.batch<T>(native);
		},
		exec: db.exec.bind(db), dump: db.dump.bind(db),
		withSession() { throw new Error('C02_CLAIM_DELAY_SESSION_NOT_IN_SCOPE'); },
	};
}
