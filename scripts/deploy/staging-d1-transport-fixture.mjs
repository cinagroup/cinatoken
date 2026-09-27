// Pure operator fixture: fixed read-only SQL, synthetic values, no network or credentials.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const D1_TRANSPORT_SQL = 'SELECT length(value) AS codepoints,length(CAST(value AS BLOB)) AS utf8_bytes FROM (SELECT ? AS value)';
export function d1TransportProbe(kind, size, count = 1, encoding = 'utf8') {
  assert.ok(['ascii', 'unicode'].includes(kind));
  assert.ok([16384, 65536, 262144, 786432].includes(size));
  assert.ok(count === 1 || (count === 3 && size === 262144));
  assert.ok(encoding === 'utf8' || (encoding === 'ascii-escaped' && kind === 'unicode'));
  const unit = kind === 'unicode' ? '漢' : 'x', width = Buffer.byteLength(unit);
  const value = unit.repeat(Math.floor(size / width)) + 'x'.repeat(size % width);
  assert.equal(Buffer.byteLength(value), size);
  const batch = Array.from({ length: count }, () => ({ sql: D1_TRANSPORT_SQL, params: [value] }));
  let body = JSON.stringify({ batch });
  if (encoding === 'ascii-escaped') body = body.replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  assert.deepEqual(JSON.parse(body), { batch });
  assert.ok(Buffer.byteLength(body) < 2 * 1024 * 1024);
  return { label: kind + '-' + size + 'x' + count + '-' + encoding, kind, size, count, encoding, body,
    wireBytes: Buffer.byteLength(body), bodySha256: createHash('sha256').update(body).digest('hex'),
    expected: Array.from({ length: count }, () => [{ codepoints: value.length, utf8_bytes: size }]) };
}
export function d1TransportMatrix() {
  return [
    ...[16384, 65536, 262144, 786432].flatMap(size => ['ascii', 'unicode'].map(kind => d1TransportProbe(kind, size))),
    ...[262144, 786432].map(size => d1TransportProbe('unicode', size, 1, 'ascii-escaped')),
    ...['ascii', 'unicode'].map(kind => d1TransportProbe(kind, 262144, 3)),
  ];
}
