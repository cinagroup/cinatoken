import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import postgres from 'postgres';

const runFile = promisify(execFile);
const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const fixtureRoot = resolve(repository, '.wrangler/staging/pg-native-dispatch-tests');

/** Starts ONLY a new, owned local cluster. Never accepts a database URL or an existing data directory. */
export async function startNativePostgres() {
  const configuredBin = process.env.GATEWAY_NATIVE_PG_BIN;
  assert.ok(configuredBin, 'Explicit GATEWAY_NATIVE_PG_BIN is required; no DATABASE_URL fallback');
  assert.doesNotMatch(configuredBin, /^[a-z]+:\/\//i);
  const bin = await realpath(resolve(configuredBin));
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const executable = name => join(bin, name + suffix);
  for (const name of ['postgres', 'initdb', 'pg_ctl']) assert.ok((await stat(executable(name))).isFile());
  // Do not allow ambient PGHOST/PGDATA/PGSERVICE/PGOPTIONS or passwords to redirect fixture commands.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^DATABASE_URL$/i.test(key)));
  async function command(name, args, timeout = 30_000) {
    return runFile(executable(name), args, { env, windowsHide: true, timeout, maxBuffer: 256 * 1024 });
  }
  const binaryVersion = (await command('postgres', ['--version'])).stdout.trim();
  await mkdir(fixtureRoot, { recursive: true });
  const canonicalRoot = await realpath(fixtureRoot);
  const owned = await mkdtemp(join(canonicalRoot, 'run-'));
  const data = join(owned, 'data'), log = join(owned, 'server.log'), passwordFile = join(owned, 'init-password');
  const username = 'fixture_' + randomUUID().replaceAll('-', '');
  const password = randomBytes(32).toString('hex');
  await writeFile(passwordFile, password + '\n', { flag: 'wx', mode: 0o600 });
  const portProbe = createServer();
  await new Promise((yes, no) => { portProbe.once('error', no); portProbe.listen(0, '127.0.0.1', yes); });
  const port = portProbe.address().port;
  await new Promise((yes, no) => portProbe.close(error => error ? no(error) : yes()));
  const clients = new Set();
  let closed = false, startAttempted = false;
  function client(label, { throughPort = port, prepare = true, settings = {} } = {}) {
    assert.ok(!closed); assert.ok(Number.isSafeInteger(throughPort) && throughPort > 0 && throughPort < 65536);
    assert.match(label, /^[a-z0-9_-]{1,50}$/);
    const sql = postgres({ host: '127.0.0.1', port: throughPort, database: 'postgres', username, password,
      ssl: false, sslnegotiation: null, fetch_types: false, prepare, max: 1, max_pipeline: 1,
      connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: 0, keep_alive: 0,
      debug: false, onnotice() {},
      connection: { application_name: 'cinatoken-native-' + label, ...settings } });
    clients.add(sql); return sql;
  }
  async function status() {
    try { await command('pg_ctl', ['-D', data, 'status'], 5_000); return 'running'; }
    catch (error) { if (error.code === 3) return 'stopped'; throw error; }
  }
  async function stop() {
    if (closed) return;
    await Promise.allSettled([...clients].map(sql => sql.end({ timeout: 1 })));
    if (startAttempted) {
      // Scope is the mkdtemp-owned data directory; never stop a service or an unrelated PID.
      if (await status() === 'running') await command('pg_ctl', ['-D', data, '-m', 'fast', '-w', '-t', '15', 'stop'], 20_000);
      assert.equal(await status(), 'stopped');
      await assert.rejects(stat(join(data, 'postmaster.pid')), error => error.code === 'ENOENT');
    }
    closed = true;
    return { stopped: true, cluster: basename(owned) };
  }
  async function cleanup() {
    await stop();
    const target = await realpath(owned);
    assert.equal(dirname(target), canonicalRoot); assert.equal(resolve(target), resolve(owned));
    assert.ok(basename(target).startsWith('run-'));
    await rm(target, { recursive: true });
  }
  try {
    await command('initdb', ['-D', data, '-U', username, '--pwfile=' + passwordFile,
      '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--no-locale', '--encoding=UTF8']);
    startAttempted = true;
    await command('pg_ctl', ['-D', data, '-l', log, '-w', '-t', '20', '-o',
      `-h 127.0.0.1 -p ${port} -c ssl=off -c max_connections=24 -c shared_buffers=16MB -c fsync=on -c synchronous_commit=on -c full_page_writes=on -c statement_timeout=15s -c idle_in_transaction_session_timeout=15s`, 'start']);
    const admin = client('admin');
    const [identity] = await admin.unsafe(`SELECT current_setting('data_directory') AS data_directory,
      current_setting('listen_addresses') AS listen_addresses, current_setting('port') AS port,
      current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit,
      current_setting('full_page_writes') AS full_page_writes, version(), pg_backend_pid() AS pid`);
    assert.equal(resolve(identity.data_directory), resolve(data));
    assert.equal(identity.listen_addresses, '127.0.0.1'); assert.equal(Number(identity.port), port);
    assert.equal(identity.fsync, 'on'); assert.equal(identity.synchronous_commit, 'on'); assert.equal(identity.full_page_writes, 'on');
    return { admin, client, port, binaryVersion, identity, owned, data, log, stop, cleanup,
      readLog: () => readFile(log, 'utf8') };
  } catch (error) {
    // initdb/pg_ctl can leave a child after Windows timeout/token failure. A missing
    // postmaster.pid does NOT prove a bootstrap --single process has exited.
    // On failed startup retain the entire fixture for explicit process-identity inspection.
    const failures = [error];
    if (startAttempted) { try { await stop(); } catch (stopError) { failures.push(stopError); } }
    throw new AggregateError(failures, 'Native startup unconfirmed; inspect owned child processes before cleanup: ' + owned);
  }
}
