import { parseImageStorageFault } from './images-storage-fault-contract';
import { withImageStorageFault } from './images-storage-fault';

// Operator-owned staging row, not a public/RPC parameter or a new binding.
export const RECOVERY_FENCING_CONTROL_KEY = 'c02_recovery_fencing_control_v1';
export const RECOVERY_FENCING_CONTROL_DESCRIPTION = 'c02-recovery-fencing-control-v1';
const LOG_INSERT = 'INSERT INTO api_key_request_logs (id, user_id, api_key_id, workspace_id,';

/** Lazy, invocation-owned adapter: all I/O remains inside the existing host hold. */
export function withRecoveryFencingProbe(db: D1Database): D1Database {
	const entries = new WeakMap<D1PreparedStatement, { native: D1PreparedStatement; sql: string; values: unknown[] }>();
	function wrap(native: D1PreparedStatement, sql: string, values: unknown[] = []): D1PreparedStatement {
		const statement: D1PreparedStatement = {
			bind: (...bound) => wrap(native.bind(...bound), sql, bound),
			first: native.first.bind(native), all: native.all.bind(native), run: native.run.bind(native), raw: native.raw.bind(native),
		};
		entries.set(statement, { native, sql, values });
		return statement;
	}
	return {
		prepare: sql => wrap(db.prepare(sql), sql),
		async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
			const batch = statements.map(statement => {
				const entry = entries.get(statement);
				if (!entry) throw new Error('C02_RECOVERY_FENCING_FOREIGN_STATEMENT');
				return entry;
			});
			const logs = batch.filter(entry => entry.sql.startsWith(LOG_INSERT));
			const native = batch.map(entry => entry.native);
			if (logs.length === 0) return db.batch<T>(native);
			// Bound bytes in SQL before crossing the D1 boundary; reject bad rows,
			// rather than loading a large value or interpreting arbitrary config JSON.
			const row = await db.prepare(`SELECT CASE WHEN description=? AND typeof(value)='text'
				AND length(CAST(value AS BLOB))<=190 THEN value ELSE '' END AS probe
				FROM system_config WHERE key=? LIMIT 1`)
				.bind(RECOVERY_FENCING_CONTROL_DESCRIPTION, RECOVERY_FENCING_CONTROL_KEY).first<{ probe: string }>();
			if (row === null) return db.batch<T>(native);
			const probe = parseImageStorageFault(row.probe);
			if (!probe || probe.mode !== 'before-release') throw new Error('C02_RECOVERY_FENCING_INVALID_CONTROL');
			const matched = logs.filter(({ values }) => values[1] === probe.runId + '-user'
				&& values[2] === probe.runId + '-key' && values[3] === probe.runId + '-workspace');
			if (matched.length === 0) return db.batch<T>(native);
			if (matched.length !== 1 || logs.length !== 1) throw new Error('C02_RECOVERY_FENCING_AMBIGUOUS_BATCH');
			// Reuse the exact owned CAS and bounded 20 x 500 ms release protocol.
			// It invokes the genuine native transaction; it cannot fake a commit.
			const paused = withImageStorageFault(db, probe);
			return paused.batch<T>(batch.map(({ sql, values }) => paused.prepare(sql).bind(...values)));
		},
		exec: db.exec.bind(db), dump: db.dump.bind(db),
		withSession() { throw new Error('C02_RECOVERY_FENCING_SESSION_NOT_IN_SCOPE'); },
	};
}
