import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:https";
import { connect } from "node:net";

assert.equal(process.platform, "linux");
assert.deepEqual(process.argv.slice(2), ["--execute-owned-linux"]);
assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
const startedAt = new Date().toISOString();
const deadline = Date.now() + 180_000;
const ca = readFileSync("/tls/qa-root-ca.crt");
const authority = new X509Certificate(ca);
assert.equal(authority.ca, true);
const manifestBytes = readFileSync("/release/manifest.json");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(`${sha256(manifestBytes)}\n`, readFileSync("/release/manifest.sha256", "utf8"));
assert.equal(sha256(manifestBytes), process.env.G7_MANIFEST_SHA);
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.releaseId, process.env.G7_RELEASE_SHA);
const assetMap = new Map(manifest.files.map((file) => [`/web-assets/${file.path}`, file]));
const agent = new Agent({ ca, rejectUnauthorized: true, keepAlive: false });
const rows = [];
let sequence = 0;
let failure;
async function call(label, path, method = "GET", headers = {}, options = {}) {
  assert.ok(Date.now() < deadline, "Shared wire deadline exceeded");
  assert.ok(path.startsWith("/") && !path.startsWith("//"));
  const result = await new Promise((accept, reject) => {
    const req = request({
      hostname: "app.test", port: 443, servername: "app.test", path, method, headers,
      agent, timeout: 8_000, ...options,
    }, (response) => {
      const TLSAuthorized = req.socket.authorized === true;
      const peerCertificateSha256 = req.socket.getPeerCertificate().fingerprint256;
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > (options.maxBytes ?? 2 * 1024 * 1024)) req.destroy(new Error("Response byte bound exceeded"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("aborted", () => reject(new Error("Response aborted")));
      response.on("end", () => accept({
        status: response.statusCode, headers: response.headers, bytes,
        body: Buffer.concat(chunks), TLSAuthorized, peerCertificateSha256,
      }));
    });
    req.on("timeout", () => req.destroy(new Error("Bounded HTTPS timeout")));
    req.on("error", reject);
    req.end();
  });
  assert.equal(result.TLSAuthorized, true, label);
  rows.push({ id: ++sequence, label, method, path, status: result.status, bytes: result.bytes,
    TLSAuthorized: result.TLSAuthorized, peerCertificateSha256: result.peerCertificateSha256,
    setCookieCount: result.headers["set-cookie"]?.length ?? 0 });
  return result;
}
const noCookie = (r) => assert.equal(r.headers["set-cookie"], undefined);
const noStore = (r) => assert.match(r.headers["cache-control"] ?? "", /(?:^|[ ,])no-store(?:$|[ ,])/);
const json = (r) => { assert.match(r.headers["content-type"] ?? "", /application\/json/); return JSON.parse(r.body.toString()); };
async function certificateNegative(label, options, allowedCodes) {
  let rejected;
  try { await call(label, "/en", "GET", {}, { ...options, agent: false }); }
  catch (error) { rejected = error; }
  assert.ok(rejected, label);
  assert.ok(allowedCodes.includes(rejected.code), `Unexpected TLS failure ${rejected.code}`);
  rows.push({ id: ++sequence, label, outcome: "verified TLS rejection", errorCode: rejected.code });
}
async function rawPortNegative(host, port) {
  const outcome = await new Promise((accept, reject) => {
    const socket = connect({ host, port });
    socket.setTimeout(1_500);
    socket.once("connect", () => { socket.destroy(); reject(new Error(`Raw service reachable: ${host}:${port}`)); });
    socket.once("error", (error) => { socket.destroy(); accept({ errorCode: error.code }); });
    socket.once("timeout", () => { socket.destroy(); accept({ blockedAtDeadline: true }); });
  });
  if (outcome.errorCode) assert.ok(["ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED", "ETIMEDOUT"].includes(outcome.errorCode));
  rows.push({ id: ++sequence, label: `QA cannot reach ${host}:${port}`, outcome: "raw port inaccessible", ...outcome });
}
try {
  // Startup retries have their own explicit bounded budget, and do not discard a failing final assertion.
  let ready = false;
  const startup = [];
  for (let attempt = 0; attempt < 30 && !ready; attempt++) {
    try {
      const response = await call("startup probe", "/api/public/catalog/models");
      const body = json(response);
      ready = response.status === 200 && body.data?.length === 1 && body.data[0].id === "qa/g7-model";
      startup.push({ attempt, status: response.status, ready });
    } catch (error) { startup.push({ attempt, errorName: error.name, errorCode: error.code }); }
    if (!ready) await new Promise((accept) => setTimeout(accept, 250));
  }
  writeFileSync("/receipts/wire-startup.json", `${JSON.stringify(startup, null, 2)}\n`, { flag: "wx" });
  assert.equal(ready, true, "Actual Admin to Proxy to PostgreSQL catalog must become ready");
  await certificateNegative("untrusted CA is rejected", { ca: [] }, ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT"]);
  await certificateNegative("wrong SNI fails certificate hostname validation", { ca, servername: "attacker.test" }, ["ERR_TLS_CERT_ALTNAME_INVALID"]);
  const missingSNI = await call("missing SNI rejected by default ingress", "/en", "GET", {}, { agent: false, ca, servername: "" });
  assert.equal(missingSNI.status, 421);
  noCookie(missingSNI);
  for (const [label, headers, expected] of [
    ["same HTTPS Origin", { origin: "https://app.test", "sec-fetch-site": "same-origin" }, 410],
    ["spoofed forwarding overwritten", { origin: "https://app.test", "sec-fetch-site": "same-origin", "x-forwarded-proto": "http", "x-forwarded-host": "attacker.test", forwarded: "proto=http;host=attacker.test" }, 410],
    ["ambiguous forwarding overwritten", { origin: "https://app.test", "sec-fetch-site": "same-origin", "x-forwarded-proto": "http,https" }, 410],
    ["missing Origin", {}, 403],
    ["cross Origin preserved", { origin: "https://attacker.test" }, 403],
    ["explicit cross-site", { origin: "https://app.test", "sec-fetch-site": "cross-site" }, 403],
    ["unknown Host", { host: "attacker.test", origin: "https://app.test" }, 421],
  ]) {
    const response = await call(label, "/api/auth/login", "POST", headers);
    assert.equal(response.status, expected, label);
    noCookie(response);
  }
  const register = await call("registration redirect", "/api/auth/cinaauth/register?intent=portal&callbackURL=%2Faccount%2Fkeys");
  assert.equal(register.status, 302);
  const location = new URL(register.headers.location);
  assert.equal(location.origin, "https://app.test");
  assert.equal(location.pathname, "/api/auth/cinaauth/login");
  assert.equal(location.searchParams.get("intent"), "portal");
  assert.equal(location.searchParams.get("callbackURL"), "/account/keys");
  noStore(register);
  const invalid = await call("invalid callback restores HTTPS", "/api/auth/cinaauth/callback?state=invalid");
  assert.equal(invalid.status, 302);
  const fallback = new URL(invalid.headers.location);
  assert.equal(fallback.origin, "https://app.test");
  assert.equal(fallback.searchParams.get("auth_error"), "invalid_transaction");
  noCookie(invalid);
  for (const [host, port] of [["gateway-web", 8080], ["gateway-web-ssr", 8791], ["gateway-admin", 8789], ["gateway-proxy", 8787], ["pg", 5432]]) await rawPortNegative(host, port);
  const markerHeaders = { cookie: "g7_anonymous=controlled-marker", authorization: "Bearer controlled-marker", "X-CinaToken-Workspace": "controlled-workspace" };
  const modelSlug = `~${Buffer.from("qa/g7-model").toString("base64url")}`;
  for (const [path, kind] of [
    ["/api/public/catalog/models", "models"],
    ["/api/public/catalog/providers", "providers"],
    [`/api/public/catalog/model/qa/${modelSlug}`, "model"],
    ["/api/v1/models", "proxy-models"],
    ["/api/v1/providers", "proxy-providers"],
  ]) {
    const response = await call(`actual PG-backed ${kind}`, path, "GET", markerHeaders);
    assert.equal(response.status, 200, path);
    noCookie(response);
    const data = json(response);
    assert.equal(data.data?.length ?? 1, 1);
    if (kind === "models" || kind === "model") assert.equal(Array.isArray(data.data) ? data.data[0].id : data.data.id, "qa/g7-model");
    assert.doesNotMatch(response.body.toString(), /controlled-marker|controlled-workspace|enc:v2:|g7-upstream-model/);
  }
  const privateApi = await call("Admin API remains API before SPA", "/api/admin/__g7_missing");
  assert.equal(privateApi.status, 401);
  assert.equal(json(privateApi).message, "Unauthorized");
  const proxyMissing = await call("unknown Proxy API remains JSON404", "/v1/__g7_missing");
  assert.equal(proxyMissing.status, 404);
  json(proxyMissing);
  const paths = ["", "/models?q=G7", `/models/qa/${modelSlug}`, "/providers", "/compare?models=qa%2Fg7-model", "/chat?model=qa%2Fg7-model", "/rankings?range=30d", "/benchmarks?range=90d"];
  for (const locale of ["en", "zh", "ja", "ko"]) for (const path of paths) for (const method of ["GET", "HEAD"]) {
    const route = `/${locale}${path}`;
    const response = await call("real PG-backed SSR", route, method, markerHeaders);
    assert.equal(response.status, 200, `${method} ${route}`);
    noStore(response); noCookie(response);
    assert.equal(response.headers["cross-origin-opener-policy"], "same-origin");
    if (method === "HEAD") assert.equal(response.bytes, 0);
    else {
      const html = response.body.toString();
      assert.match(html, new RegExp(`<html lang="${locale}"`));
      assert.match(/<main\b[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "", /<h1\b/);
      assert.match(html, /rel="canonical" href="https:\/\/app\.test\//);
      assert.equal((html.match(/rel="alternate"/g) ?? []).length, 5);
      assert.doesNotMatch(html, /controlled-marker|controlled-workspace|gateway-(?:admin|proxy|web)|enc:v2:|id="cinatoken-public-[BS]:/);
      const bootstrap = JSON.parse(/<script[^>]*id="cinatoken-public-bootstrap"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "null");
      assert.equal(bootstrap.locale, locale);
      assert.equal(bootstrap.pathname, route.split("?")[0]);
      assert.equal(bootstrap.status, 200);
      assert.equal(bootstrap.records.length, path ? 1 : 0);
      if (path) {
        const record = bootstrap.records[0].result;
        assert.equal(record.status, "success");
        // Real PG stats may be empty because no inference has occurred; models/provider/detail must be nonempty.
        if (!path.startsWith("/rankings") && !path.startsWith("/benchmarks")) {
          assert.equal(record.data.data?.length ?? 1, 1);
          assert.equal(Array.isArray(record.data.data) ? record.data.data[0].id : record.data.data.id, path === "/providers" ? "qa" : "qa/g7-model");
        }
      }
      const nonce = /'nonce-([^']+)'/.exec(response.headers["content-security-policy"] ?? "")?.[1];
      assert.ok(nonce);
      for (const script of html.matchAll(/<script\b([^>]*)>/g)) assert.ok(script[1].includes(`nonce="${nonce}"`));
      const linked = [...html.matchAll(/(?:src|href)="(\/web-assets\/[^"?]+)"/g)];
      assert.ok(linked.length >= 2);
      for (const asset of linked) assert.ok(assetMap.has(asset[1]), `Unverified linked asset ${asset[1]}`);
    }
  }
  for (const method of ["GET", "HEAD"]) for (const path of ["/robots.txt", "/sitemap.xml", "/en/not-a-page", "/fr/models"]) {
    const response = await call("SSR metadata/status", path, method);
    assert.equal(response.status, path.includes(".txt") || path.includes(".xml") ? 200 : 404);
    noStore(response); noCookie(response);
    if (method === "HEAD") assert.equal(response.bytes, 0);
    else if (path === "/robots.txt") assert.ok(response.body.toString().includes("Sitemap: https://app.test/sitemap.xml"));
    else if (path === "/sitemap.xml") assert.ok(response.body.toString().includes(`https://app.test/en/models/qa/${modelSlug}`));
  }
  for (const file of manifest.files) for (const method of ["GET", "HEAD"]) {
    const response = await call(`frozen ${file.source} resource`, `/web-assets/${file.path}`, method, {}, { maxBytes: Math.max(file.bytes, 1) });
    assert.equal(response.status, 200, `${method} ${file.path}`);
    noCookie(response);
    if (method === "HEAD") assert.equal(response.bytes, 0);
    else { assert.equal(response.bytes, file.bytes); assert.equal(sha256(response.body), file.sha256); }
  }
  const missingAsset = await call("missing resource never becomes SPA", "/web-assets/assets/g7-missing.js");
  assert.equal(missingAsset.status, 404);
} catch (error) { failure = { name: error.name, code: error.code, message: error.message.slice(0, 2_000) }; }
finally { agent.destroy(); }
writeFileSync("/receipts/wire-result.json", `${JSON.stringify({
  schema: "web-platform-g7-tls-pg-wire-v1", startedAt, endedAt: new Date().toISOString(), actualExit: failure ? 1 : 0,
  caFingerprint: authority.fingerprint256, sourceSHA: process.env.G7_RELEASE_SHA, manifestSha256: sha256(manifestBytes), rows, failure,
  expectedOriginalNineWireCases: 9, expectedPublicSSRRequests: 64, expectedResourceFiles: manifest.files.length,
  completedPublicSSRRequests: rows.filter((row) => row.label === "real PG-backed SSR").length,
  completedResourceRequests: rows.filter((row) => row.label?.startsWith("frozen ")).length,
  laterStages: { signedOIDC: "pending", authenticatedWrites: "pending", subjectWorkspaceIsolation: "pending", proxySSEAbortWS: "pending", retainedGrayRollback: "pending", realCinaAuthIdentity: "pending" },
  fullG7Verified: false, productionRequests: 0,
}, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ actualExit: failure ? 1 : 0, completedRows: rows.length, report: "/receipts/wire-result.json" }));
process.exitCode = failure ? 1 : 0;
