import { createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';

// Local evaluation only. No package resolution hook, install hook or runtime integration.
// postgres.js is Unlicense; this transformation is specific to the installed 3.4.9 sources.
export const sourcePins = Object.freeze({
  esm: Object.freeze({ entry: 'src/index.js', sha256: '4e21f5733e70d79cffc10d10d4ef01031de4a9ac862210e43f8870029fd103ed', connection: 'ee3a218d9aa6a6f2887c1a19da50009335fe84c11a5431d5cab72d6bc528632f' }),
  cjs: Object.freeze({ entry: 'cjs/src/index.js', sha256: 'd8fea1a5311c47e65004646bc81f57305ac64d48f99004a5b3ca27bcfc6babf8', connection: 'ce6d375809baad79963ef9b3773e6ac757bcf6da2362d4d85482bb14c2c751be' }),
  cf: Object.freeze({ entry: 'cf/src/index.js', sha256: 'aca9c247b7ddb2aedf90d20ce8e6f52ac6ebd95865056599ca05ed4dab4baad7', connection: '3efad812b825f76708f2e62e8dd00088900206e04afed2dc4b75b9aecd435fa9' }),
});
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const driverRoot = join(projectRoot, 'node_modules/postgres');

export function retireClosedTransactions(source, variant) {
  const pin = sourcePins[variant];
  if (!pin || sha256(source) !== pin.sha256) throw new Error('Unsupported postgres.js transaction source');
  const edits = [
    ["      , prepare = null", "      , prepare = null\n      , transactionClosed = null"],
    [
      "        scope(connection, fn),\n        new Promise((_, reject) => connection.onclose = reject)",
      // Install the close observer before entering user code. State belongs to this begin,
      // never to the mutable connection object, which the pool can reconnect/reassign.
      "        new Promise((_, reject) => connection.onclose = error => {\n" +
      "          transactionClosed = error\n" +
      "          while (queries.length)\n" +
      "            queries.shift().reject(error)\n" +
      "          reject(error)\n" +
      "        }),\n" +
      "        scope(connection, fn)",
    ],
    [
      "        q.catch(e => uncaughtError || (uncaughtError = e))\n        c.queue === full",
      "        q.catch(e => uncaughtError || (uncaughtError = e))\n" +
      "        if (transactionClosed)\n" +
      "          return q.reject(transactionClosed)\n" +
      "        c.queue === full",
    ],
  ];
  let result = source;
  for (const [before, after] of edits) {
    if (result.split(before).length !== 2) throw new Error('Non-unique postgres.js patch anchor');
    result = result.replace(before, after);
  }
  return result;
}

export function reserveAcceptedQueries(source, variant, guardDrain = true) {
  const pin = sourcePins[variant];
  if (!pin || sha256(source) !== pin.connection) throw new Error('Unsupported postgres.js connection source');
  const before = '      return write(toBuffer(q))\n' +
    '        && !q.describeFirst\n' +
    '        && !q.cursorFn\n' +
    '        && sent.length < max_pipeline\n' +
    '        && (!q.options.onexecute || q.options.onexecute(connection))';
  const after = '      const writable = write(toBuffer(q))\n' +
    '      return !q.describeFirst\n' +
    '        && !q.cursorFn\n' +
    '        && (!q.options.onexecute || q.options.onexecute(connection))\n' +
    '        && writable\n' +
    '        && sent.length < max_pipeline';
  if (source.split(before).length !== 2) throw new Error('Non-unique postgres.js reservation anchor');
  // A false write result still accepted bytes. Run the admission hook independently
  // of writable/pipeline capacity, but retain its falsy return so callers stop using
  // this connection for ordinary pipelining. Preserve describe-first/cursor handling.
  let result = source.replace(before, after);
  if (guardDrain) {
    const beforeDrain = '    !query && onopen(connection)';
    if (result.split(beforeDrain).length !== 2) throw new Error('Non-unique postgres.js drain anchor');
    // ReadyForQuery already services a reserved scope's queue. A delayed drain while
    // its callback is idle is not permission to hand its connection to root queries.
    result = result.replace(beforeDrain, '    !query && !connection.reserved && onopen(connection)');
  }
  return result;
}

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Non-unique lifecycle patch anchor');
  return source.replace(before, after);
}

/** Seal each callback scope, including savepoints, before its internal finalization.
 * Internal COMMIT/ROLLBACK is separate from user admission. A child also checks its
 * parent, so detached child continuations cannot roll back a later transaction.
 */
export function retireCompletedScopes(source, variant) {
  let result = retireClosedTransactions(source, variant);
  const edits = [
    ['async function scope(c, fn, name) {', 'async function scope(c, fn, name, parentActive = () => true) {'],
    ['      const sql = Sql(handler)\n      sql.savepoint = savepoint',
      '      const sql = Sql(handler)\n' +
      '          , control = Sql(q => handler(q, true))\n' +
      "          , scopeError = Errors.generic('TRANSACTION_ENDED', 'Transaction callback scope has ended')\n" +
      '      let scopeClosed = false\n' +
      '      const active = () => !scopeClosed && parentActive()\n' +
      '      sql.savepoint = savepoint'],
    ['      sql.prepare = x => prepare = x.replace(/[^a-z0-9$-_. ]/gi)',
      '      sql.prepare = x => {\n' +
      '        if (transactionClosed || !active()) throw transactionClosed || scopeError\n' +
      '        return prepare = x.replace(/[^a-z0-9$-_. ]/gi)\n' +
      '      }'],
    ['      name && await sql`savepoint ${ sql(name) }`',
      '      if (transactionClosed || !active()) throw transactionClosed || scopeError\n' +
      '      name && await control`savepoint ${ control(name) }`\n' +
      '      if (transactionClosed || !active()) throw transactionClosed || scopeError'],
    ['        })\n\n        if (uncaughtError)',
      '        }).finally(() => { scopeClosed = true })\n\n        if (uncaughtError)'],
    ['          ? sql`rollback to ${ sql(name) }`\n          : sql`rollback`',
      '          ? control`rollback to ${ control(name) }`\n          : control`rollback`'],
    ["          ? await sql`prepare transaction '${ sql.unsafe(prepare) }'`\n          : await sql`commit`",
      "          ? await control`prepare transaction '${ control.unsafe(prepare) }'`\n          : await control`commit`"],
    ['      function savepoint(name, fn) {\n',
      '      function savepoint(name, fn) {\n        if (transactionClosed || !active()) throw transactionClosed || scopeError\n'],
    ["        return scope(c, fn, 's' + savepoints++ + (name ? '_' + name : ''))",
      "        return scope(c, fn, 's' + savepoints++ + (name ? '_' + name : ''), active)"],
    ['      function handler(q) {\n        q.catch(e => uncaughtError || (uncaughtError = e))\n        if (transactionClosed)\n          return q.reject(transactionClosed)',
      '      function handler(q, internal = false) {\n' +
      '        if (transactionClosed || !(internal ? parentActive() : active())) {\n' +
      '          q.catch(() => {})\n' +
      '          return q.reject(transactionClosed || scopeError)\n' +
      '        }\n' +
      '        q.catch(e => uncaughtError || (uncaughtError = e))'],
  ];
  for (const [before, after] of edits) result = replaceOnce(result, before, after);
  return result;
}

/** A synchronous write exception gives no safe replay boundary. Detach the buffer
 * before calling the transport, fail active/sent/initial work, poison admission and
 * destroy only this connection. Keep it poisoned until actual close and reconnect.
 * This does NOT attest server SQL cancellation or application capacity release.
 */
export function retireWriteFailures(source, variant) {
  let result = reserveAcceptedQueries(source, variant);
  const edits = [
    ['    , nextWriteTimer = null', '    , nextWriteTimer = null\n    , writeFailure = null'],
    ['  function execute(q) {\n', '  function execute(q) {\n    if (writeFailure) return queryError(q, writeFailure)\n'],
    ['      const writable = write(toBuffer(q))\n', '      const writable = write(toBuffer(q))\n      if (writeFailure) return false\n'],
    ['  function write(x, fn) {\n', '  function write(x, fn) {\n    if (writeFailure) return false\n'],
    ['    const x = socket.write(chunk, fn)\n    nextWriteTimer !== null && clearImmediate(nextWriteTimer)\n    chunk = nextWriteTimer = null\n    return x',
      '    const pending = chunk\n' +
      '    nextWriteTimer !== null && clearImmediate(nextWriteTimer)\n' +
      '    chunk = nextWriteTimer = null\n' +
      '    if (writeFailure) return false\n' +
      '    if (!pending) return true\n' +
      '    try {\n' +
      '      return socket.write(pending, fn)\n' +
      '    } catch (cause) {\n' +
      "      writeFailure = cause instanceof Error ? cause : new Error('Socket write failed')\n" +
      '      if (connection.queue && queues.full && connection.queue !== queues.full) {\n' +
      '        connection.queue.remove(connection)\n' +
      '        queues.full.push(connection)\n' +
      '        connection.queue = queues.full\n' +
      '        idleTimer.cancel()\n' +
      '      }\n' +
      '      error(writeFailure)\n' +
      '      try { socket && socket.destroy() } catch (_) { /* No close receipt: stays quarantined. */ }\n' +
      '      return false\n' +
      '    }'],
    ['    !query && !connection.reserved && onopen(connection)', '    !writeFailure && !query && !connection.reserved && onopen(connection)'],
    ['  function data(x) {\n', '  function data(x) {\n    if (writeFailure) return\n'],
    ['    socket || (socket = await createSocket())', '    if (!socket) {\n      socket = await createSocket()\n      writeFailure = null\n    }'],
    ['    clearImmediate(nextWriteTimer)\n    socket.removeListener', '    clearImmediate(nextWriteTimer)\n    chunk = nextWriteTimer = null\n    socket.removeListener'],
  ];
  for (const [before, after] of edits) result = replaceOnce(result, before, after);
  return result;
}

/** Builds local candidates only; installed package and all lockfiles remain untouched.
 * The entry + connection are pinned, and all other bundled inputs are hashed in the result.
 * CF output is compile/parity evidence, NOT a workerd/Hyperdrive execution test.
 */
export async function buildRetirementCandidates({ reservation = 'complete', lifecycle = 'closed', writeFailure = 'original' } = {}) {
  if (!['none','hook-only','complete'].includes(reservation)) throw new Error('Unsupported reservation candidate');
  if (!['closed','completed'].includes(lifecycle) || !['original','retire'].includes(writeFailure)) throw new Error('Unsupported lifecycle candidate');
  if (writeFailure === 'retire' && reservation !== 'complete') throw new Error('Write retirement requires complete reservation');
  const extended = lifecycle !== 'closed' || writeFailure !== 'original';
  const pkg = JSON.parse(await readFile(join(driverRoot, 'package.json'), 'utf8'));
  if (pkg.version !== '3.4.9' || esbuildVersion !== '0.27.3') throw new Error('Unsupported candidate build versions');
  const sources = {};
  // Validate every branch before generating any bundle.
  for (const [variant, pin] of Object.entries(sourcePins)) {
    const entry = join(driverRoot, pin.entry);
    const connection = await readFile(join(dirname(entry), 'connection.js'), 'utf8');
    sources[variant] = { index: (lifecycle === 'completed' ? retireCompletedScopes : retireClosedTransactions)(await readFile(entry, 'utf8'), variant),
      connection: writeFailure === 'retire' ? retireWriteFailures(connection, variant)
        : reservation === 'none' ? connection : reserveAcceptedQueries(connection, variant, reservation === 'complete') };
    if (sha256(connection) !== pin.connection)
      throw new Error('Unsupported postgres.js connection source');
  }
  const parent = join(projectRoot, '.wrangler/staging');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, extended ? `postgres-lifecycle-v300-${lifecycle}-${writeFailure}-` : `postgres-reservation-v298-${reservation}-`));
  const artifacts = {};
  for (const [variant, pin] of Object.entries(sourcePins)) {
    const entry = join(driverRoot, pin.entry), outfile = join(directory, `postgres-${variant}.${variant === 'cjs' ? 'cjs' : 'mjs'}`);
    let transformed = 0;
    const result = await build({
      absWorkingDir: projectRoot, entryPoints: [entry], outfile, bundle: true,
      format: variant === 'cjs' ? 'cjs' : 'esm', platform: variant === 'cf' ? 'neutral' : 'node',
      external: ['node:*', 'cloudflare:sockets'], target: 'es2022', metafile: true,
      legalComments: 'inline', logLevel: 'silent',
      banner: { js: `// LOCAL EVALUATION ONLY: postgres.js 3.4.9 (Unlicense); transaction candidate ${extended ? `v300 ${lifecycle} ${writeFailure}` : `v298 ${reservation}`}.` },
      plugins: [{ name: 'pinned-transaction-close', setup(builder) {
        builder.onLoad({ filter: /(?:index|connection)\.js$/ }, args => {
          const kind = resolve(args.path) === resolve(entry) ? 'index'
            : resolve(args.path) === resolve(dirname(entry), 'connection.js') ? 'connection' : null;
          if (!kind) return undefined;
          transformed++;
          return { contents: sources[variant][kind], loader: 'js' };
        });
      } }],
    });
    if (transformed !== 2) throw new Error('Candidate transforms were not each applied once');
    const inputs = {};
    for (const name of Object.keys(result.metafile.inputs).sort())
      inputs[name] = sha256(await readFile(resolve(projectRoot, name)));
    artifacts[variant] = { path: outfile, sha256: sha256(await readFile(outfile)), inputs };
  }
  return { directory, artifacts, reservation, lifecycle, writeFailure, versions: { postgres: pkg.version, esbuild: esbuildVersion } };
}
