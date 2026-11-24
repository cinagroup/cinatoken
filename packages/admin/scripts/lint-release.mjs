import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const adminRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function lintFingerprint(message, root) {
	return digest(JSON.stringify([
		message.ruleId, message.line, message.column, message.endLine,
		message.endColumn, message.message.replaceAll(root, '<admin>'),
	]));
}

/** Existing debt is accepted only in byte-identical, explicitly recorded files. */
export function evaluateReleaseLint(results, baseline, root, fileHash) {
	const known = new Map(baseline.files.map((file) => [file.path, file]));
	const unexpected = [];
	let knownErrors = 0;
	let warnings = 0;
	for (const result of results) {
		const path = relative(root, result.filePath).replaceAll('\\', '/');
		const entry = known.get(path);
		const remaining = [...(entry?.fingerprints ?? [])];
		let unchanged;
		for (const message of result.messages) {
			if (message.severity !== 2) {
				warnings++;
				continue;
			}
			if (entry && unchanged === undefined)
				unchanged = fileHash(result.filePath) === entry.sha256;
			const index = remaining.indexOf(lintFingerprint(message, root));
			if (unchanged && index !== -1) {
				remaining.splice(index, 1);
				knownErrors++;
				continue;
			}
			unexpected.push({ path, ruleId: message.ruleId, line: message.line, column: message.column, message: message.message });
		}
	}
	return { knownErrors, warnings, unexpected };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const baseline = JSON.parse(readFileSync(resolve(adminRoot, 'eslint-release-baseline.json'), 'utf8'));
	if (baseline.version !== 1 || baseline.baselineRef !== 'd0c559d390921c6aee227c38b4057f728e5935c8')
		throw new Error('Unrecognized original-main lint baseline');
	const run = spawnSync(process.execPath, [resolve(adminRoot, '../../node_modules/eslint/bin/eslint.js'), '.', '--format', 'json'], {
		cwd: adminRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
	});
	if (run.error || ![0, 1].includes(run.status)) {
		process.stderr.write(run.stderr || String(run.error || 'ESLint did not finish'));
		process.exit(1);
	}
	const result = evaluateReleaseLint(JSON.parse(run.stdout), baseline, adminRoot, (file) => digest(readFileSync(file)));
	console.log(JSON.stringify({ baselineRef: baseline.baselineRef, knownLegacyErrors: result.knownErrors, newErrors: result.unexpected.length, warnings: result.warnings }));
	for (const error of result.unexpected)
		console.error(`${error.path}:${error.line}:${error.column} ${error.ruleId}: ${error.message}`);
	if (result.knownErrors)
		console.warn(`Retained ${result.knownErrors} known lint errors in unchanged original-main files; ordinary npm run lint still reports them.`);
	process.exitCode = result.unexpected.length ? 1 : 0;
}
