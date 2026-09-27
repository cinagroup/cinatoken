import { readFile } from 'node:fs/promises';
import { RecoveryOriginBudgetError, validatePostgresRecoveryOriginBudget } from './postgres-recovery-origin-budget';

/** Reads only the explicitly named local snapshot. There is no network or live-probe path. */
async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length !== 1 || !args[0]?.startsWith('--snapshot=') || args[0].length <= '--snapshot='.length) {
		throw new RecoveryOriginBudgetError('explicit_snapshot_path_required');
	}
	const path = args[0].slice('--snapshot='.length);
	if (/^https?:\/\//iu.test(path)) throw new RecoveryOriginBudgetError('local_snapshot_file_required');
	const file = await readFile(path);
	if (file.byteLength > 32 * 1024) throw new RecoveryOriginBudgetError('budget_snapshot_too_large');
	let facts: unknown;
	try {
		facts = JSON.parse(file.toString('utf8'));
	} catch {
		throw new RecoveryOriginBudgetError('invalid_budget_snapshot_json');
	}
	const budget = validatePostgresRecoveryOriginBudget(facts, Date.now());
	process.stdout.write(`${JSON.stringify({ ok: true, budget })}\n`);
}

main().catch((error: unknown) => {
	const code = error instanceof RecoveryOriginBudgetError ? error.code : 'budget_snapshot_file_unavailable';
	process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`);
	process.exitCode = 1;
});
