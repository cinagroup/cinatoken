// Synthetic admission-only fixture. No provider, model, route, or spend authority.
import assert from 'node:assert/strict';

export function imageIngressFixture(runId, keyHash, expiresAt) {
  assert.match(runId, /^c02-ingress-[a-f0-9-]{36}$/);
  assert.match(keyHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(new Date(expiresAt).toISOString(), expiresAt);
  const user = runId + '-user', workspace = runId + '-workspace', key = runId + '-key';
  const marker = JSON.stringify({ staging_fixture: runId, purpose: 'images-ingress-only' });
  return {
    ids: { runId, user, workspace, key },
    seed: [
      { sql: 'INSERT INTO users (id,email,budget_max,metadata) VALUES (?,?,0,?)',
        params: [user, runId + '@example.invalid', marker] },
      { sql: `INSERT INTO workspaces (id,scope_type,personal_owner_user_id,name,slug,settings_json)
          VALUES (?,'personal',?,'C02 ingress synthetic','c02-ingress',?)`, params: [workspace, user, marker] },
      { sql: `INSERT INTO api_keys (id,key,key_hash,key_preview,user_id,workspace_id,name,metadata,expires_at,limit_micros)
          VALUES (?,?,?,'sk-…',?,?,'C02 ingress synthetic',?,?,0)`,
        params: [key, 'hashref:' + keyHash, keyHash, user, workspace, marker, expiresAt] },
    ],
    revoke: { sql: "UPDATE api_keys SET status = 'revoked' WHERE id = ? AND user_id = ? AND workspace_id = ? AND key_hash = ?",
      params: [key, user, workspace, keyHash] },
    // Exact ownership predicates; never bulk-delete tenants or truncate tables.
    cleanup: [
      { sql: 'DELETE FROM api_keys WHERE id = ? AND user_id = ? AND workspace_id = ? AND key_hash = ?',
        params: [key, user, workspace, keyHash] },
      { sql: 'DELETE FROM workspaces WHERE id = ? AND personal_owner_user_id = ? AND settings_json = ?', params: [workspace, user, marker] },
      { sql: 'DELETE FROM users WHERE id = ? AND metadata = ?', params: [user, marker] },
    ],
  };
}

export const MiB = 1024 ** 2;
export const boundary = 'cinatoken-c02-ingress-boundary';
export const missingModel = 'c02-ingress-no-such-model';
function* fill(bytes) {
  assert.ok(Number.isSafeInteger(bytes) && bytes >= 0);
  const page = Buffer.alloc(64 * 1024, 65);
  while (bytes > 0) { const size = Math.min(bytes, page.length); yield page.subarray(0, size); bytes -= size; }
}
export function jsonWire(bytes) {
  const prefix = Buffer.from(JSON.stringify({ model: missingModel, prompt: 'synthetic boundary' }).slice(0, -1) + ',"padding":"');
  const suffix = Buffer.from('"}');
  assert.ok(bytes >= prefix.length + suffix.length);
  return { bytes, type: 'application/json', *chunks() { yield prefix; yield* fill(bytes - prefix.length - suffix.length); yield suffix; } };
}
export function multipartWire(fileBytes) {
  const fields = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${missingModel}\r\n--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nsynthetic boundary\r\n`);
  const headers = fileBytes.map((_, i) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="${i}.png"\r\nContent-Type: image/png\r\n\r\n`));
  const suffix = Buffer.from(`--${boundary}--\r\n`);
  const bytes = fields.length + headers.reduce((n, h) => n + h.length + 2, 0) + suffix.length + fileBytes.reduce((a, b) => a + b, 0);
  return { bytes, type: `multipart/form-data; boundary=${boundary}`, *chunks() {
    yield fields;
    for (let i = 0; i < fileBytes.length; i++) { yield headers[i]; yield* fill(fileBytes[i]); yield Buffer.from('\r\n'); }
    yield suffix;
  } };
}
export function multipartTotalWire(bytes) {
  const overhead = multipartWire([0, 0, 0]).bytes;
  assert.ok(bytes >= overhead + 40 * MiB && bytes <= overhead + 60 * MiB);
  return multipartWire([20 * MiB, 20 * MiB, bytes - overhead - 40 * MiB]);
}
