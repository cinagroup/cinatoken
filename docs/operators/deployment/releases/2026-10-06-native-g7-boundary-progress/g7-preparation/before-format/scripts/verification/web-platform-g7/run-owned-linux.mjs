import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRelease } from "../../../packages/web/scripts/package-release.mjs";
import { admit, APP_ORIGIN, assertOwned, assertTopology, OWNER_LABEL, PUBLIC_API_ORIGIN } from "./admission.mjs";

const input = admit(process.argv.slice(2), process.env, process.platform);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const qaDirectory = dirname(fileURLToPath(import.meta.url));
assert.equal(existsSync(input.out), false, "Never overwrite an earlier receipt directory");
mkdirSync(input.out, { recursive: false });
const privateDirectory = mkdtempSync(join(tmpdir(), "cinatoken-g7-private-"));
chmodSync(privateDirectory, 0o700);
const tlsDirectory = join(privateDirectory, "tls");
mkdirSync(tlsDirectory);
const owner = `g7-${randomUUID().replaceAll("-", "")}`;
const names = Object.fromEntries(["pg", "migrate", "seed", "proxy", "admin", "ssr", "web", "ingress", "qa"].map((role) => [role, `${owner}-${role}`]));
const networks = Object.fromEntries(["client", "app", "db"].map((role) => [role, `${owner}-${role}`]));
const volume = `${owner}-pgdata`;
const secrets = Object.fromEntries(["database", "encryption", "provider", "master", "oidc", "bridge", "transaction"].map((key) => [key, randomBytes(32).toString("hex")]));
const startedAt = new Date().toISOString();
const deadline = Date.now() + 720_000;
const receipts = [];
const created = { containers: [], networks: [], volume: false };
const cleanup = { containers: [], networks: [], volumes: [], errors: [], verifiedAbsent: false };
let commandId = 0;
let failure;
let release;
let imageIDs;
let database;
let observations;
let wire;
let cleanupPhase = false;
let cleanupDeadline;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function save(name, value) {
  writeFileSync(join(input.out, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}
function redact(bytes) {
  let text = bytes.toString();
  for (const secret of Object.values(secrets)) text = text.replaceAll(secret, "[REDACTED-G7-EPHEMERAL]");
  return Buffer.from(text);
}
function command(program, args, { timeout = 90_000, allowFailure = false, cwd = repository } = {}) {
  if (!cleanupPhase) assert.ok(Date.now() < deadline, "Owned runtime shared deadline exceeded");
  else {
    assert.ok(Date.now() < cleanupDeadline, "Owned cleanup deadline exceeded; absence is not proven");
    timeout = Math.min(timeout, 15_000, cleanupDeadline - Date.now());
  }
  const label = `${String(++commandId).padStart(3, "0")}-${program}`;
  const begin = new Date().toISOString();
  const result = spawnSync(program, args, {
    cwd, encoding: null, timeout, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, DOCKER_HOST: undefined, DOCKER_CONTEXT: undefined },
  });
  const stdout = Buffer.from(result.stdout ?? []);
  const stderr = Buffer.from(result.stderr ?? []);
  const storedStdout = redact(stdout);
  const storedStderr = redact(stderr);
  writeFileSync(join(input.out, `${label}.stdout.log`), storedStdout, { flag: "wx" });
  writeFileSync(join(input.out, `${label}.stderr.log`), storedStderr, { flag: "wx" });
  const receipt = {
    schema: "web-platform-g7-child-command-closed-v1", program, args, begin, endedAt: new Date().toISOString(),
    closed: true, actualExit: result.status, signal: result.signal, errorCode: result.error?.code ?? null,
    timedOut: result.error?.code === "ETIMEDOUT", timeoutMs: timeout,
    stdout: { file: `${label}.stdout.log`, bytes: storedStdout.length, sha256: sha256(storedStdout), redacted: !storedStdout.equals(stdout) },
    stderr: { file: `${label}.stderr.log`, bytes: storedStderr.length, sha256: sha256(storedStderr), redacted: !storedStderr.equals(stderr) },
  };
  save(`${label}.result.json`, receipt);
  receipts.push(receipt);
  if (!allowFailure) assert.ok(result.status === 0 && result.signal === null && !result.error, `${label} failed: exit=${result.status}, signal=${result.signal}, error=${result.error?.code}`);
  return { ...result, stdout: stdout.toString(), stderr: stderr.toString(), receipt };
}
const docker = (args, options) => command("docker", ["--host", "unix:///var/run/docker.sock", ...args], options);
const parsed = (result) => JSON.parse(result.stdout.trim());
const parsedLast = (result) => JSON.parse(result.stdout.trim().split("\n").at(-1));
function envFile(role, entries) {
  const file = join(privateDirectory, `${role}.env`);
  for (const [key, value] of Object.entries(entries)) assert.ok(/^[A-Z0-9_]+$/.test(key) && !String(value).includes("\n"));
  writeFileSync(file, Object.entries(entries).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  return file;
}
const databaseEnv = {
  DATABASE_DRIVER: "postgres", DATABASE_URL: `postgres://postgres:${secrets.database}@pg:5432/g7`,
  SHARED_KEY_ENCRYPTION_SECRET: secrets.encryption, AUTO_MIGRATE: "false",
};
function mount(source, destination, writable = false) {
  assert.ok(!source.includes(",") && !destination.includes(","));
  return ["--mount", `type=bind,src=${source},dst=${destination}${writable ? "" : ",readonly"}`];
}
function create(role, image, attached, args = [], aliases = {}, writable = []) {
  const name = names[role];
  created.containers.push(name); // Includes a daemon creation interrupted before its CLI result.
  docker(["create", "--name", name, "--label", `${OWNER_LABEL}=${owner}`, "--network", attached[0],
    ...(aliases[attached[0]] ? ["--network-alias", aliases[attached[0]]] : []), ...args, image]);
  for (const network of attached.slice(1)) docker(["network", "connect", ...(aliases[network] ? ["--alias", aliases[network]] : []), network, name]);
  const value = parsed(docker(["inspect", name]))[0];
  assertOwned(value.Config.Labels, owner);
  assertTopology(value, attached, writable);
  docker(["start", name]);
}
function completedContainer(name) {
  const result = docker(["wait", name], { timeout: 90_000 });
  const actualExit = Number(result.stdout.trim());
  assert.ok(Number.isInteger(actualExit));
  const inspect = parsed(docker(["inspect", name]))[0];
  assertOwned(inspect.Config.Labels, owner);
  assert.equal(inspect.State.Running, false);
  assert.equal(inspect.State.ExitCode, actualExit);
  save(`${name}-${commandId}.container-closed.json`, { schema: "web-platform-g7-container-closed-v1", name, actualExit, running: inspect.State.Running, finishedAt: inspect.State.FinishedAt, OOMKilled: inspect.State.OOMKilled, error: inspect.State.Error });
  docker(["logs", name]);
  assert.equal(actualExit, 0, `Container ${name} failed`);
}
try {
  const head = command("git", ["rev-parse", "HEAD"]).stdout.trim();
  assert.equal(head, input.sha);
  assert.equal(command("git", ["status", "--porcelain", "--untracked-files=no"]).stdout.trim(), "");
  release = verifyRelease(repository, input.sha);
  assert.equal(release.manifest.schemaVersion, 3);
  assert.ok(release.server);
  assert.equal(release.manifest.buildContract.sourceSha256, release.manifest.sourceDelivery.archives.find((archive) => archive.path === release.manifest.sourceDelivery.currentArchive).buildContract.sourceSha256);
  const checked = [
    ...readdirSync(qaDirectory).filter((name) => !name.startsWith(".")).map((name) => `scripts/verification/web-platform-g7/${name}`),
    ".github/workflows/web-platform-g7.yml", "Dockerfile.admin", "Dockerfile.proxy", "Dockerfile.migrate", "Dockerfile.web", "Dockerfile.web-ssr",
    "docker/web/nginx.conf.template", "docker/web/admin-proxy.conf", "docker/web/entrypoint.sh", "docker/web/public-server.mjs", "package-lock.json",
  ];
  save("source-inputs.json", { sourceSHA: head, files: checked.map((path) => { const bytes = readFileSync(join(repository, path)); return { path, bytes: bytes.length, sha256: sha256(bytes) }; }), manifestSha256: release.manifestSha256 });
  const references = { pg: "postgres:16-alpine", ingress: "nginx:stable-alpine", admin: `cinatoken-g7-admin:${head}`, proxy: `cinatoken-g7-proxy:${head}`, migrate: `cinatoken-g7-migrate:${head}`, web: `cinatoken-g7-web:${head}`, ssr: `cinatoken-g7-ssr:${head}` };
  imageIDs = Object.fromEntries(Object.entries(references).map(([role, ref]) => {
    const [image] = parsed(docker(["image", "inspect", ref]));
    assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
    assert.equal(image.Os, "linux");
    return [role, image.Id];
  }));
  save("image-inputs.json", { references, imageIDs, platform: docker(["version", "--format", "{{json .Server}}"]).stdout.trim() });
  command("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=G7 Owned Ephemeral Root", "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", join(tlsDirectory, "qa-root-ca.key"), "-out", join(tlsDirectory, "qa-root-ca.crt")]);
  command("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=app.test", "-addext", "subjectAltName=DNS:app.test", "-keyout", join(tlsDirectory, "app.test.key"), "-out", join(tlsDirectory, "app.test.csr")]);
  const extensions = join(tlsDirectory, "leaf.ext");
  writeFileSync(extensions, "subjectAltName=DNS:app.test\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n", { flag: "wx" });
  command("openssl", ["x509", "-req", "-days", "2", "-in", join(tlsDirectory, "app.test.csr"), "-CA", join(tlsDirectory, "qa-root-ca.crt"), "-CAkey", join(tlsDirectory, "qa-root-ca.key"), "-CAcreateserial", "-extfile", extensions, "-out", join(tlsDirectory, "app.test.crt")]);
  command("openssl", ["verify", "-CAfile", join(tlsDirectory, "qa-root-ca.crt"), "-verify_hostname", "app.test", join(tlsDirectory, "app.test.crt")]);
  for (const network of Object.values(networks)) {
    created.networks.push(network);
    docker(["network", "create", "--internal", "--label", `${OWNER_LABEL}=${owner}`, network]);
    const [value] = parsed(docker(["network", "inspect", network]));
    assertOwned(value.Labels, owner); assert.equal(value.Internal, true); assert.equal(value.Driver, "bridge");
  }
  created.volume = true;
  docker(["volume", "create", "--label", `${OWNER_LABEL}=${owner}`, volume]);
  create("pg", imageIDs.pg, [networks.db], ["--env-file", envFile("pg", { POSTGRES_USER: "postgres", POSTGRES_PASSWORD: secrets.database, POSTGRES_DB: "g7" }), "--mount", `type=volume,src=${volume},dst=/var/lib/postgresql/data`], { [networks.db]: "pg" }, ["/var/lib/postgresql/data"]);
  let pgReady = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = docker(["exec", names.pg, "pg_isready", "-U", "postgres", "-d", "g7"], { allowFailure: true, timeout: 5_000 });
    if (result.status === 0 && !result.error && result.signal === null) { pgReady = true; break; }
    await new Promise((accept) => setTimeout(accept, 500));
  }
  assert.equal(pgReady, true, "Owned PostgreSQL readiness bounded");
  create("migrate", imageIDs.migrate, [networks.db], ["--env-file", envFile("migrate", databaseEnv)]);
  completedContainer(names.migrate);
  // A second actual migration run must preserve the same complete ledger.
  docker(["start", names.migrate]); completedContainer(names.migrate);
  const seedEnv = envFile("seed", { ...databaseEnv, G7_PROVIDER_KEY: secrets.provider, G7_MASTER_KEY: secrets.master });
  created.containers.push(names.seed);
  docker(["create", "--name", names.seed, "--label", `${OWNER_LABEL}=${owner}`, "--network", networks.db, "--env-file", seedEnv,
    ...mount(qaDirectory, "/qa"), "--entrypoint", "node", imageIDs.proxy, "/qa/database.mjs", "--seed"]);
  const [seedInspect] = parsed(docker(["inspect", names.seed]));
  assertOwned(seedInspect.Config.Labels, owner); assertTopology(seedInspect, [networks.db]);
  docker(["start", names.seed]);
  completedContainer(names.seed);
  database = parsedLast(docker(["logs", names.seed]));
  assert.equal(database.actualExit, 0);
  save("database-seed.json", database);
  create("proxy", imageIDs.proxy, [networks.app, networks.db], ["--env-file", envFile("proxy", { ...databaseEnv, PORT: "8787", REQUEST_BODY_LOGGING: "off" }), ...mount(qaDirectory, "/qa")], { [networks.app]: "gateway-proxy" });
  const adminEnv = { ...databaseEnv, PORT: "8789", HOSTNAME: "0.0.0.0", CINATOKEN_PUBLIC_API_ORIGIN: PUBLIC_API_ORIGIN,
    CINATOKEN_APP_ORIGIN: APP_ORIGIN, CINAAUTH_ISSUER: "https://auth.test", CINAAUTH_ACCOUNT_ORIGIN: "https://accounts.test",
    CINATOKEN_OIDC_CLIENT_ID: "g7-controlled-local", CINATOKEN_OIDC_CLIENT_SECRET: secrets.oidc,
    CINATOKEN_OIDC_BRIDGE_SECRET: secrets.bridge, CINATOKEN_OIDC_TRANSACTION_SECRET: secrets.transaction };
  assert.equal(adminEnv.CINATOKEN_PUBLIC_API_ORIGIN, PUBLIC_API_ORIGIN);
  assert.equal(adminEnv.CINATOKEN_APP_ORIGIN, APP_ORIGIN);
  create("admin", imageIDs.admin, [networks.app, networks.db], ["--env-file", envFile("admin", adminEnv), ...mount(qaDirectory, "/qa")], { [networks.app]: "gateway-admin" });
  create("ssr", imageIDs.ssr, [networks.app], ["--env-file", envFile("ssr", { CINATOKEN_WEB_PUBLIC_ENABLED: "true", CINATOKEN_WEB_PUBLIC_ORIGIN: APP_ORIGIN, CINATOKEN_ADMIN_UPSTREAM: "http://gateway-admin:8789" })], { [networks.app]: "gateway-web-ssr" });
  const switches = [...readFileSync(join(repository, "docker/web/entrypoint.sh"), "utf8").matchAll(/\$\{(CINATOKEN_WEB_(?:PUBLIC|ACCOUNT|ADMIN_[A-Z_]+)_ENABLED):=false\}/g)].map((match) => match[1]);
  assert.equal(new Set(switches).size, 29);
  create("web", imageIDs.web, [networks.app], ["--env-file", envFile("web", { ...Object.fromEntries(switches.map((flag) => [flag, "true"])), CINATOKEN_ADMIN_UPSTREAM: "http://gateway-admin:8789", CINATOKEN_WEB_SSR_UPSTREAM: "http://gateway-web-ssr:8791" })], { [networks.app]: "gateway-web" });
  assert.equal(docker(["exec", names.web, "cat", "/usr/share/web-release/manifest.sha256"]).stdout.trim(), release.manifestSha256);
  assert.equal(docker(["exec", names.ssr, "cat", "/app/.release/web/input/manifest.sha256"]).stdout.trim(), release.manifestSha256);
  create("ingress", imageIDs.ingress, [networks.client, networks.app], [
    ...mount(join(qaDirectory, "ingress.conf"), "/etc/nginx/conf.d/default.conf"),
    ...mount(join(tlsDirectory, "app.test.crt"), "/tls/app.test.crt"), ...mount(join(tlsDirectory, "app.test.key"), "/tls/app.test.key"),
  ], { [networks.client]: "app.test" });
  docker(["exec", names.ingress, "nginx", "-t"]);
  // Output mount is the only writable QA bind; no DB credentials or CA private key are supplied.
  chmodSync(input.out, 0o777);
  created.containers.push(names.qa);
  docker(["create", "--name", names.qa, "--label", `${OWNER_LABEL}=${owner}`, "--network", networks.client,
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp",
    "--env", `G7_MANIFEST_SHA=${release.manifestSha256}`, "--env", `G7_RELEASE_SHA=${head}`,
    ...mount(qaDirectory, "/qa"), ...mount(join(tlsDirectory, "qa-root-ca.crt"), "/tls/qa-root-ca.crt"),
    ...mount(join(release.directory, "manifest.json"), "/release/manifest.json"), ...mount(join(release.directory, "manifest.sha256"), "/release/manifest.sha256"),
    ...mount(input.out, "/receipts", true), "--entrypoint", "node", imageIDs.ssr, "/qa/wire.mjs", "--execute-owned-linux"]);
  const [qaInspect] = parsed(docker(["inspect", names.qa]));
  assertOwned(qaInspect.Config.Labels, owner); assertTopology(qaInspect, [networks.client], ["/receipts"]);
  docker(["start", names.qa]);
  const wait = docker(["wait", names.qa], { timeout: 240_000 });
  const qaExit = Number(wait.stdout.trim());
  assert.ok(Number.isInteger(qaExit));
  const [qaClosed] = parsed(docker(["inspect", names.qa]));
  assert.equal(qaClosed.State.Running, false); assert.equal(qaClosed.State.ExitCode, qaExit);
  save("qa-container-closed.json", { schema: "web-platform-g7-container-closed-v1", actualExit: qaExit, running: false, finishedAt: qaClosed.State.FinishedAt, OOMKilled: qaClosed.State.OOMKilled });
  docker(["logs", names.qa]);
  wire = JSON.parse(readFileSync(join(input.out, "wire-result.json"), "utf8"));
  assert.equal(wire.actualExit, qaExit);
  assert.equal(qaExit, 0);
  assert.equal(wire.completedPublicSSRRequests, 64);
  assert.equal(wire.completedResourceRequests, 2 * release.manifest.files.length);
  observations = Object.fromEntries(["proxy", "admin"].map((role) => [role, parsedLast(docker(["exec", names[role], "node", "/qa/database.mjs", "--observe"]))]));
  for (const [role, observation] of Object.entries(observations)) {
    assert.equal(observation.actualExit, 0, role);
    assert.equal(observation.observation.schemaSha256, database.observation.schemaSha256);
    assert.equal(observation.migrationCorpusSha256, database.migrationCorpusSha256);
    assert.deepEqual(observation.observation.counts, database.observation.counts);
  }
  save("database-runtime-observations.json", observations);
} catch (error) { failure = { name: error.name, message: redact(Buffer.from(error.message)).toString().slice(0, 3_000) }; }
finally {
  cleanupPhase = true;
  cleanupDeadline = Date.now() + 120_000;
  // Each operation is observed separately. Failures remain errors, and only exact owned resources can be removed.
  const attempt = (work) => { try { work(); } catch (error) { cleanup.errors.push(redact(Buffer.from(error.message)).toString()); } };
  for (const name of [...created.containers].reverse()) attempt(() => {
    const found = docker(["container", "ls", "-aq", "--filter", `name=^/${name}$`]);
    if (found.stdout.trim()) {
      const [value] = parsed(docker(["inspect", name])); assertOwned(value.Config.Labels, owner);
      docker(["logs", name], { allowFailure: false, timeout: 15_000 });
      docker(["rm", "--force", "--volumes", name], { timeout: 30_000 });
    }
    const absent = docker(["container", "ls", "-aq", "--filter", `name=^/${name}$`]);
    assert.equal(absent.stdout.trim(), ""); cleanup.containers.push({ name, verifiedAbsent: true });
  });
  for (const name of [...created.networks].reverse()) attempt(() => {
    const found = docker(["network", "ls", "-q", "--filter", `name=^${name}$`]);
    if (found.stdout.trim()) {
      const [value] = parsed(docker(["network", "inspect", name])); assertOwned(value.Labels, owner);
      docker(["network", "rm", name], { timeout: 30_000 });
    }
    assert.equal(docker(["network", "ls", "-q", "--filter", `name=^${name}$`]).stdout.trim(), ""); cleanup.networks.push({ name, verifiedAbsent: true });
  });
  if (created.volume) attempt(() => {
    const found = docker(["volume", "ls", "-q", "--filter", `name=^${volume}$`]);
    if (found.stdout.trim()) {
      const [value] = parsed(docker(["volume", "inspect", volume])); assertOwned(value.Labels, owner);
      docker(["volume", "rm", volume], { timeout: 30_000 });
    }
    assert.equal(docker(["volume", "ls", "-q", "--filter", `name=^${volume}$`]).stdout.trim(), ""); cleanup.volumes.push({ name: volume, verifiedAbsent: true });
  });
  attempt(() => {
    for (const type of ["container", "network", "volume"]) assert.equal(docker([type, "ls", type === "container" ? "-aq" : "-q", "--filter", `label=${OWNER_LABEL}=${owner}`]).stdout.trim(), "", `Owned ${type} remains`);
    cleanup.verifiedAbsent = cleanup.errors.length === 0;
  });
  chmodSync(input.out, 0o755);
  save("cleanup.json", cleanup);
  save("result.json", {
    schema: "web-platform-g7-owned-linux-tls-pg-closed-v1", startedAt, endedAt: new Date().toISOString(),
    sourceSHA: input.sha, owner, actualExit: failure || cleanup.errors.length ? 1 : 0, failure, cleanup,
    manifestSha256: release?.manifestSha256, imageIDs, database, observations,
    wireActualExit: wire?.actualExit ?? null, commandCount: receipts.length,
    stages: { realLinuxDockerTLSPGCatalog: failure || cleanup.errors.length ? "failed" : "passed", signedOIDC: "pending", authenticatedWrites: "pending", subjectWorkspaceIsolation: "pending", proxySSEAbortWS: "pending", retainedGrayRollback: "pending", realCinaAuthIdentity: "pending" },
    restrictedRuntimeACLVerified: false, nativePG18Verified: false, fullG7Verified: false, fullG8Verified: false, productionRequests: 0,
    privateMaterial: "Ephemeral credentials and private keys were kept outside the uploaded receipt tree; logs may be explicitly redacted.",
  });
}
process.exitCode = failure || cleanup.errors.length ? 1 : 0;
console.log(JSON.stringify({ actualExit: process.exitCode, out: input.out, cleanupVerifiedAbsent: cleanup.verifiedAbsent, fullG7Verified: false }));
