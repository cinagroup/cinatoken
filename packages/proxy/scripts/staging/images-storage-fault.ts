import { imageStorageFaultRow, type ImageStorageFault } from './images-storage-fault-contract';

// Opt-in host-lifetime experiment only. No request/configurable duration and no native abort.
export const IMAGE_WAIT_UNTIL_EXPIRY_MS = 45_000;

/** Staging-only faults around a real, tenant-matched D1 batch. Never imported by production. */
export function withImageStorageFault(db: D1Database, probe: ImageStorageFault, {
	pollMs = 500, polls = 20, abortContext, waitUntilExpiry,
}: { pollMs?: number; polls?: number; abortContext?: Pick<ExecutionContext, 'abort'>; waitUntilExpiry?: true } = {}): D1Database {
	if (waitUntilExpiry !== undefined && (waitUntilExpiry !== true || (probe.mode !== 'before-release' && probe.mode !== 'after-release'))) {
		throw new Error('Invalid fixed waitUntil expiry profile');
	}
	if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 500 || !Number.isSafeInteger(polls) || polls < 1 || polls > 40) {
		throw new Error('Bounded storage observation required');
	}
	if ((probe.mode === 'before-abort' || probe.mode === 'after-abort') && typeof abortContext?.abort !== 'function') {
		throw new Error('C02_D1_FAULT_NATIVE_ABORT_UNAVAILABLE');
	}
	const row = imageStorageFaultRow(probe);
	const statements = new WeakMap<D1PreparedStatement, { native: D1PreparedStatement; requestId: string | null }>();
	let used = false, current = row.value, requestId: string | null = null;
	function wrap(native: D1PreparedStatement, sql: string, values: readonly unknown[] = []): D1PreparedStatement {
		// Only the existing critical-write INSERT shape, and this exact synthetic tenant.
		const matchedId = sql.startsWith('INSERT INTO api_key_request_logs (id, user_id, api_key_id, workspace_id,')
			&& typeof values[0] === 'string' && /^gen-[a-f0-9-]{36}$/.test(values[0])
			&& values[1] === probe.runId + '-user' && values[2] === probe.runId + '-key'
			&& values[3] === probe.runId + '-workspace' ? values[0] : null;
		const statement: D1PreparedStatement = {
			bind: (...bound) => wrap(native.bind(...bound), sql, bound),
			first: native.first.bind(native), all: native.all.bind(native), run: native.run.bind(native), raw: native.raw.bind(native),
		};
		statements.set(statement, { native, requestId: matchedId });
		return statement;
	}
	function state(phase: string): string { return JSON.stringify({ ...probe, requestLogId: requestId, phase }); }
	async function transition(phase: string): Promise<void> {
		const next = state(phase);
		const result = await db.prepare('UPDATE system_config SET value=?,updated_at=? WHERE key=? AND description=? AND value=?')
			.bind(next, new Date().toISOString(), row.key, row.description, current).run();
		if (result.meta.changes !== 1) throw new Error('C02_D1_FAULT_NOT_ARMED_OR_OWNERSHIP_CHANGED');
		current = next;
	}
	async function awaitRelease(): Promise<void> {
		const released = state('release-requested');
		for (let i = 0; i < polls; i++) {
			const value = await db.prepare('SELECT value FROM system_config WHERE key=? AND description=?')
				.bind(row.key, row.description).first<string>('value');
			if (value === released) { current = released; return; }
			if (value !== current) throw new Error('C02_D1_FAULT_OWNERSHIP_CHANGED');
			await new Promise<void>(resolve => setTimeout(resolve, pollMs));
		}
		await transition('release-timeout');
		throw new Error('C02_D1_FAULT_RELEASE_TIMEOUT');
	}
	async function abortExecution(phase: string): Promise<never> {
		// Durable marker proves the exact boundary was reached, not that termination succeeded.
		await transition(phase);
		if (!abortContext) throw new Error('C02_D1_FAULT_NATIVE_ABORT_UNAVAILABLE');
		abortContext.abort(); // Keep the native receiver. This is context termination, not isolate eviction.
		// A returning shim is a failed experiment, never a successful native abort.
		throw new Error('C02_D1_FAULT_NATIVE_ABORT_RETURNED');
	}
	async function awaitHostExpiry(phase: string): Promise<never> {
		// This durable marker precedes the fixed pause. It is NOT proof of host cancellation.
		await transition(phase);
		await new Promise<void>(resolve => setTimeout(resolve, IMAGE_WAIT_UNTIL_EXPIRY_MS));
		// A surviving timer proves the intended platform boundary was not observed.
		// Never release/commit the held batch or label an ordinary throw as host cancellation.
		await transition('host-expiry-not-observed');
		throw new Error('C02_D1_FAULT_HOST_EXPIRY_NOT_OBSERVED');
	}
	return {
		prepare: sql => wrap(db.prepare(sql), sql),
		async batch<T>(batch: D1PreparedStatement[]): Promise<D1Result<T>[]> {
			const entries = batch.map(statement => {
				const entry = statements.get(statement);
				if (!entry) throw new Error('C02_D1_FAULT_FOREIGN_STATEMENT');
				return entry;
			});
			const matching = entries.filter(entry => entry.requestId != null);
			const native = entries.map(entry => entry.native);
			if (!matching.length || used) return db.batch<T>(native);
			if (matching.length !== 1) throw new Error('C02_D1_FAULT_AMBIGUOUS_BATCH');
			used = true; requestId = matching[0].requestId;
			await transition('claimed');
			if (waitUntilExpiry && probe.mode === 'before-release') return awaitHostExpiry('awaiting-host-expiry-before-commit');
			if (probe.mode === 'before-abort') return abortExecution('abort-requested-before-commit');
			if (probe.mode === 'before-fail') {
				await transition('failed-before-commit');
				throw new Error('C02_D1_FAULT_BEFORE_COMMIT');
			}
			if (probe.mode === 'before-release' || probe.mode === 'before-fence') { await transition('held-before-commit'); await awaitRelease(); }
			let result: D1Result<T>[];
			try { result = await db.batch<T>(native); } // Genuine batch; never manufacture a failure/success result.
			catch (error) {
				if (probe.mode === 'before-fence') {
					// Only a real SQL lease-fence error gets this label. Generic/unique-key
					// rejection does not prove fencing, and no raw error is stored in D1.
					await transition(error instanceof Error && error.message.includes('Settlement recovery lease invalid')
						? 'stale-lease-rejected' : 'unexpected-batch-error');
				}
				throw error;
			}
			if (waitUntilExpiry && probe.mode === 'after-release') return awaitHostExpiry('awaiting-host-expiry-after-commit');
			if (probe.mode === 'after-abort') return abortExecution('abort-requested-after-commit');
			if (probe.mode === 'after-fail') {
				await transition('committed-ack-lost');
				throw new Error('C02_D1_FAULT_COMMIT_ACK_LOST');
			}
			if (probe.mode === 'after-release') { await transition('held-after-commit'); await awaitRelease(); }
			await transition('ack-returned');
			return result;
		},
		exec: db.exec.bind(db), dump: db.dump.bind(db),
		withSession() { throw new Error('C02_D1_FAULT_SESSION_PATH_NOT_IN_SCOPE'); },
	};
}
