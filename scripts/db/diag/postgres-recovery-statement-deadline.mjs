import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';
import { sourcePins, sha256 } from './postgres-transaction-retirement.mjs';
import { ownedScanDeadlineSources } from './postgres-owned-scan-deadline.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
export const POSTGRES_RECOVERY_STATEMENT_DEADLINE_FENCE = 'postgres-js-3.4.9-recovery-statement-deadline-v312';

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Non-unique recovery statement deadline anchor');
  return source.replace(before, after);
}

/** A separate, default-disabled successor to v311. Recovery owner ordinary SQL
 * carries recovery_admission_deadline without acquiring owned cancellation.
 * Both deadline options are checked immediately before the final wire write.
 */
export function recoveryStatementDeadlineSources(original, variant) {
  const transformed = ownedScanDeadlineSources(original, variant);
  let { index, connection } = transformed;
  index = replaceOnce(index,
    "      ownedRecoveryDeadlineFence: 'postgres-js-3.4.9-owned-scan-deadline-v311',\n",
    "      ownedRecoveryDeadlineFence: 'postgres-js-3.4.9-owned-scan-deadline-v311',\n" +
    `      recoveryStatementDeadlineFence: '${POSTGRES_RECOVERY_STATEMENT_DEADLINE_FENCE}',\n`);

  connection = replaceOnce(connection,
    `      const deadline = q.options.admission_deadline
      if (deadline === undefined) return false
      if (q.options.owned_cancel !== true || !deadline ||
          typeof deadline.snapshot !== 'function') return true
      const state = deadline.snapshot()
      return !state || state.status !== 'open' ||
        !Number.isSafeInteger(state.remainingMs) || state.remainingMs < 1`,
    `      const scanDeadline = q.options.admission_deadline
      const statementDeadline = q.options.recovery_admission_deadline
      if (scanDeadline === undefined && statementDeadline === undefined) return false
      // The older scan option remains restricted to owned cancellation scans.
      if (scanDeadline !== undefined && q.options.owned_cancel !== true) return true
      for (const deadline of [scanDeadline, statementDeadline]) {
        if (deadline === undefined) continue
        if (!deadline || typeof deadline.snapshot !== 'function') return true
        const state = deadline.snapshot()
        if (!state || state.status !== 'open' ||
            !Number.isSafeInteger(state.remainingMs) || state.remainingMs < 1) return true
      }
      return false`);
  connection = replaceOnce(connection,
    `      const writable = q.options.admission_deadline === undefined
        ? write(encoded) : write(encoded, () => {})`,
    `      const writable = q.options.admission_deadline === undefined &&
        q.options.recovery_admission_deadline === undefined
        ? write(encoded) : write(encoded, () => {})`);
  connection = replaceOnce(connection,
    `      write(encoded, binding.options.admission_deadline === undefined ? undefined : () => {})`,
    `      write(encoded, binding.options.admission_deadline === undefined &&
        binding.options.recovery_admission_deadline === undefined ? undefined : () => {})`);
  return { index, connection, query: transformed.query };
}

export async function buildRecoveryStatementDeadlineCandidates() {
  const pkg = JSON.parse(await readFile(join(root, 'node_modules/postgres/package.json'), 'utf8'));
  if (pkg.version !== '3.4.9' || esbuildVersion !== '0.27.3')
    throw new Error('Unsupported recovery statement deadline build versions');
  const sources = {};
  for (const [variant, pin] of Object.entries(sourcePins)) {
    const directory = dirname(join(root, 'node_modules/postgres', pin.entry));
    const original = {};
    for (const kind of ['index', 'connection', 'query'])
      original[kind] = await readFile(join(directory, kind + '.js'), 'utf8');
    sources[variant] = recoveryStatementDeadlineSources(original, variant);
  }
  await mkdir(join(root, '.wrangler/staging'), { recursive: true });
  const directory = await mkdtemp(join(root, '.wrangler/staging/postgres-recovery-statement-deadline-v312-'));
  const artifacts = {};
  for (const [variant, pin] of Object.entries(sourcePins)) {
    const entry = join(root, 'node_modules/postgres', pin.entry);
    const outfile = join(directory, 'postgres-' + variant + (variant === 'cjs' ? '.cjs' : '.mjs'));
    let transformed = 0;
    const result = await build({ absWorkingDir: root, entryPoints: [entry], outfile, bundle: true,
      metafile: true, platform: variant === 'cf' ? 'neutral' : 'node',
      format: variant === 'cjs' ? 'cjs' : 'esm', target: 'es2022',
      external: ['node:*', 'cloudflare:sockets'], logLevel: 'silent',
      banner: { js: '// LOCAL DEFAULT-DISABLED EVALUATION: postgres.js 3.4.9 (Unlicense), v312 recovery statement admission.' },
      plugins: [{ name: 'recovery-statement-deadline', setup(builder) {
        builder.onLoad({ filter: /(?:index|connection|query)\.js$/ }, args => {
          const kind = ['index', 'connection', 'query'].find(name =>
            resolve(args.path) === resolve(dirname(entry), name + '.js'));
          if (!kind) return;
          transformed++;
          return { contents: sources[variant][kind], loader: 'js' };
        });
      } }] });
    if (transformed !== 3) throw new Error('Expected three pinned transforms');
    const inputs = {};
    for (const name of Object.keys(result.metafile.inputs).sort())
      inputs[name] = sha256(await readFile(resolve(root, name)));
    artifacts[variant] = { path: outfile, sha256: sha256(await readFile(outfile)), inputs };
  }
  return { directory, artifacts };
}
