import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';

/** Per-case instrumentation; NOT a database timeout or an exact billing meter.
 * Original SQL/parameters/batch boundaries pass through unchanged. A rejected
 * native call may still have committed; there is deliberately no retry here.
 */
export function guardByokD1(db: D1Database, startedAt = performance.now()) {
	const limits = Object.freeze({ statements: 200, concurrent: 2, startWindowMs: 20_000,
		acknowledgedRowsRead: 100_000, acknowledgedRowsWritten: 10_000 });
	const counters = { statements: 0, calls: 0, active: 0, peakActive: 0,
		acknowledgedRowsRead: 0, acknowledgedRowsWritten: 0, callsWithoutRowMetadata: 0, nativeRejectedCalls: 0 };
	const statements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
	let sealed = false;
	function check(ok: unknown): asserts ok { if (!ok) { sealed = true; throw new Error('byok_guard_limit'); } }
	function record(value: unknown) {
		check(typeof value === 'object' && value !== null && 'success' in value && value.success === true
			&& 'meta' in value && typeof value.meta === 'object' && value.meta !== null);
		const meta = value.meta;
		check('rows_read' in meta && 'rows_written' in meta);
		check(typeof meta.rows_read === 'number' && Number.isSafeInteger(meta.rows_read) && meta.rows_read >= 0
			&& typeof meta.rows_written === 'number' && Number.isSafeInteger(meta.rows_written) && meta.rows_written >= 0);
		counters.acknowledgedRowsRead += meta.rows_read;
		counters.acknowledgedRowsWritten += meta.rows_written;
		check(counters.acknowledgedRowsRead <= limits.acknowledgedRowsRead
			&& counters.acknowledgedRowsWritten <= limits.acknowledgedRowsWritten);
	}
	async function invoke<T>(count: number, action: () => Promise<T>, mode: 'one' | 'batch' | 'no-meta'): Promise<T> {
		const elapsed = performance.now() - startedAt;
		check(!sealed && Number.isFinite(elapsed) && elapsed >= 0 && elapsed < limits.startWindowMs
			&& count > 0 && counters.statements + count <= limits.statements && counters.active < limits.concurrent);
		counters.statements += count; counters.calls++; counters.active++;
		counters.peakActive = Math.max(counters.peakActive, counters.active);
		let acknowledged = false, returned = false;
		try {
			const result = await action();
			returned = true;
			if (mode === 'batch') {
				check(Array.isArray(result) && result.length === count);
				for (const item of result) record(item);
			} else if (mode === 'one') record(result);
			else counters.callsWithoutRowMetadata++;
			acknowledged = true;
			return result;
		} finally {
			// No Promise.race: active means the actual native Promise has not
			// settled. Its rejection is NOT proof of database-side quiescence.
			if (!acknowledged) counters.callsWithoutRowMetadata++;
			if (!returned) counters.nativeRejectedCalls++;
			counters.active--;
		}
	}
	function wrap(statement: D1PreparedStatement): D1PreparedStatement {
		const wrapped = new Proxy(statement, { get(target, property) {
			if (property === 'bind') return (...values: unknown[]) => {
				check(values.length <= 100); return wrap(target.bind(...values));
			};
			if (property === 'run' || property === 'all' || property === 'first' || property === 'raw')
				return (...args: unknown[]) => invoke(1, () => Reflect.apply(target[property], target, args),
					property === 'run' || property === 'all' ? 'one' : 'no-meta');
			throw new Error('byok_guard_statement_api');
		} });
		statements.set(wrapped, statement); return wrapped;
	}
	const batch: D1Database['batch'] = <T = unknown>(items: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
		const native = items.map(item => { const found = statements.get(item); check(found !== undefined);
			return found; });
		return invoke(items.length, () => db.batch<T>(native), 'batch');
	};
	const guarded = new Proxy(db, { get(_target, property) {
		if (property === 'prepare') return (sql: string) => {
			check(typeof sql === 'string' && new TextEncoder().encode(sql).length <= 100_000);
			return wrap(db.prepare(sql));
		};
		if (property === 'batch') return batch;
		throw new Error('byok_guard_database_api');
	} });
	return { db: guarded, snapshot: () => ({ ...counters }), seal: () => { sealed = true; }, limits };
}
