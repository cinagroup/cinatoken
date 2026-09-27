import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';
import { sourcePins, sha256 } from './postgres-transaction-retirement.mjs';
import { ownedCancellationSources } from './postgres-owned-cancellation.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
export const POSTGRES_OWNED_SCAN_DEADLINE_FENCE = 'postgres-js-3.4.9-owned-scan-deadline-v311';

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Non-unique recovery deadline anchor');
  return source.replace(before, after);
}

/** A separate, default-disabled successor to the frozen v307 transform. Only
 * owned scan Queries carrying admission_deadline acquire this extra gate.
 * No installed package, shared pool, or historical v307 artifact is changed.
 */
export function ownedScanDeadlineSources(original, variant) {
  const transformed = ownedCancellationSources(original, variant);
  let { index, connection } = transformed;
  index = replaceOnce(index,
    "      ownedRecoveryScanFence: 'postgres-js-3.4.9-owned-scan-v307',\n",
    "      ownedRecoveryScanFence: 'postgres-js-3.4.9-owned-scan-v307',\n" +
    `      ownedRecoveryDeadlineFence: '${POSTGRES_OWNED_SCAN_DEADLINE_FENCE}',\n`);

  connection = replaceOnce(connection, '  async function createSocket() {', `  // A rejected admission is NOT a server cancellation or a physical close receipt.
  // Reject the original Query and quarantine this connection until its existing
  // close path runs. In CF, v304 still requires fulfilled raw.closed for reuse.
  function recoveryAdmissionClosed(q) {
    try {
      const deadline = q.options.admission_deadline
      if (deadline === undefined) return false
      if (q.options.owned_cancel !== true || !deadline ||
          typeof deadline.snapshot !== 'function') return true
      const state = deadline.snapshot()
      return !state || state.status !== 'open' ||
        !Number.isSafeInteger(state.remainingMs) || state.remainingMs < 1
    } catch { return true }
  }

  function rejectRecoveryAdmission(q, preserveQuery = false) {
    dispatching.delete(q)
    // After Parse/Describe, the same inbound buffer can still contain NoData.
    // Keep its Query available to the parser until the socket is closed.
    if (!preserveQuery) {
      if (query === q) query = null
      else sent.remove(q)
    }
    q.reject(Errors.generic('RECOVERY_ADMISSION_CLOSED', 'Recovery scan admission closed before dispatch'))
    cancelRetiring = true
    const retiringSocket = socket
    // Let the pool finish its synchronous queue move before a synthetic close
    // callback can run. No further Query is admitted on this connection.
    queueMicrotask(() => {
      if (socket === retiringSocket && retiringSocket) {
        try { retiringSocket.destroy() } catch { /* Retain the quarantined slot. */ }
      }
    })
    return true
  }

  async function createSocket() {`);
  connection = replaceOnce(connection,
    '      const encoded = toBuffer(q)\n      dispatching.delete(q)\n      if (poolShutdown) return true\n      if (q.ownedPreDispatchCancelled) return write(Sync)\n      const writable = write(encoded)',
    '      const encoded = toBuffer(q)\n' +
    '      const admissionClosed = recoveryAdmissionClosed(q)\n' +
    '      dispatching.delete(q)\n' +
    '      if (poolShutdown) return true\n' +
    '      if (q.ownedPreDispatchCancelled) return write(Sync)\n' +
    '      if (admissionClosed) return rejectRecoveryAdmission(q)\n' +
    '      // With a deadline, flush in this call stack: an ordinary small write\n' +
    '      // otherwise waits for setImmediate after the final admission check.\n' +
    '      const writable = q.options.admission_deadline === undefined\n' +
    '        ? write(encoded) : write(encoded, () => {})');
  connection = replaceOnce(connection,
    '      const binding = query\n      dispatching.add(binding)\n      let encoded\n      try { encoded = prepared(binding) }',
    '      const binding = query\n      dispatching.add(binding)\n' +
    '      const beforeClosed = recoveryAdmissionClosed(binding)\n' +
    '      if (poolShutdown || query !== binding) { dispatching.delete(binding); return }\n' +
    '      if (binding.ownedPreDispatchCancelled) { dispatching.delete(binding); binding.describeFirst = false; write(Sync); return }\n' +
    '      if (beforeClosed) { rejectRecoveryAdmission(binding, true); return }\n' +
    '      let encoded\n      try { encoded = prepared(binding) }');
  connection = replaceOnce(connection,
    '      dispatching.delete(binding)\n      if (poolShutdown || query !== binding) return\n      if (binding.ownedPreDispatchCancelled) {\n        binding.describeFirst = false\n        write(Sync)\n        return\n      }\n      write(encoded)',
    '      const afterClosed = recoveryAdmissionClosed(binding)\n' +
    '      dispatching.delete(binding)\n' +
    '      if (poolShutdown || query !== binding) return\n' +
    '      if (binding.ownedPreDispatchCancelled) {\n        binding.describeFirst = false\n        write(Sync)\n        return\n      }\n' +
    '      if (afterClosed) { rejectRecoveryAdmission(binding, true); return }\n' +
    '      write(encoded, binding.options.admission_deadline === undefined ? undefined : () => {})');
  return { index, connection, query: transformed.query };
}

export async function buildOwnedScanDeadlineCandidates() {
  const pkg = JSON.parse(await readFile(join(root, 'node_modules/postgres/package.json'), 'utf8'));
  if (pkg.version !== '3.4.9' || esbuildVersion !== '0.27.3')
    throw new Error('Unsupported recovery deadline build versions');
  const sources = {};
  for (const [variant, pin] of Object.entries(sourcePins)) {
    const directory = dirname(join(root, 'node_modules/postgres', pin.entry));
    const original = {};
    for (const kind of ['index', 'connection', 'query'])
      original[kind] = await readFile(join(directory, kind + '.js'), 'utf8');
    sources[variant] = ownedScanDeadlineSources(original, variant);
  }
  await mkdir(join(root, '.wrangler/staging'), { recursive: true });
  const directory = await mkdtemp(join(root, '.wrangler/staging/postgres-owned-scan-deadline-v311-'));
  const artifacts = {};
  for (const [variant, pin] of Object.entries(sourcePins)) {
    const entry = join(root, 'node_modules/postgres', pin.entry);
    const outfile = join(directory, 'postgres-' + variant + (variant === 'cjs' ? '.cjs' : '.mjs'));
    let transformed = 0;
    const result = await build({ absWorkingDir: root, entryPoints: [entry], outfile, bundle: true,
      metafile: true, platform: variant === 'cf' ? 'neutral' : 'node',
      format: variant === 'cjs' ? 'cjs' : 'esm', target: 'es2022',
      external: ['node:*', 'cloudflare:sockets'], logLevel: 'silent',
      banner: { js: '// LOCAL DEFAULT-DISABLED EVALUATION: postgres.js 3.4.9 (Unlicense), v311 owned scan admission.' },
      plugins: [{ name: 'owned-scan-deadline', setup(builder) {
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
