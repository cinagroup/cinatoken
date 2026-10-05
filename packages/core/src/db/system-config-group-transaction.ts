import { completeConfigSnapshots, configReadSetMatches, configRevisionVector } from './system-config-group';
import type { ConfigGroupApplyInput, ConfigGroupApplyResult, ConfigSnapshot } from './system-config-group-types';
import type { prepareConfigGroup } from './system-config-group';

/** Caller supplies one transaction and acquires the shared singleton before any read. */
export async function applyLockedConfigGroup(input: ConfigGroupApplyInput, prepared: ReturnType<typeof prepareConfigGroup>, operations: {
	lock(): Promise<void>;
	read(keys: readonly string[]): Promise<ConfigSnapshot[]>;
	write(write: { key: string; value: string; revision: string }, expectedRevision: string | null): Promise<void>;
	audit(): Promise<void>;
}): Promise<ConfigGroupApplyResult> {
	await operations.lock();
	const keys = input.readSet.map(row => row.key);
	const current = completeConfigSnapshots(keys, await operations.read(keys));
	if (!configReadSetMatches(input.readSet, current)) return { outcome: 'conflict', auditId: null, revisionVector: configRevisionVector(current) };
	if (input.safeAudit.action !== 'reveal' && prepared.writes.every(write => current.find(row => row.key === write.key)?.value === write.value)) {
		return { outcome: 'unchanged', auditId: null, revisionVector: configRevisionVector(current) };
	}
	for (const write of prepared.writes) await operations.write(write, input.readSet.find(row => row.key === write.key)!.revision);
	const after = completeConfigSnapshots(keys, await operations.read(keys));
	if (!configReadSetMatches(prepared.after, after) || prepared.writes.some(write => after.find(row => row.key === write.key)?.value !== write.value)) throw new Error('Config group target did not commit');
	await operations.audit();
	const committed = completeConfigSnapshots(keys, await operations.read(keys));
	if (!configReadSetMatches(prepared.after, committed) || prepared.writes.some(write => committed.find(row => row.key === write.key)?.value !== write.value)) throw new Error('Config group target did not commit');
	return { outcome: 'applied', auditId: input.safeAudit.auditId, revisionVector: configRevisionVector(committed) };
}
