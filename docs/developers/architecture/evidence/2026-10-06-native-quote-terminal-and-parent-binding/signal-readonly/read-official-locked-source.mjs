import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = 'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-request-signal-readonly-yCKd6V';
const primary = path.join(root, 'official-locked-source');
fs.mkdirSync(primary);
const tag = 'v1.20260828.1';
const sources = [
  'src/workerd/io/compatibility-date.capnp',
  'src/workerd/io/worker-entrypoint.c++',
  'src/workerd/api/streams/standard.c++',
  'src/workerd/api/streams/readable.c++',
];
const results = await Promise.all(sources.map(async source => {
  const url = `https://raw.githubusercontent.com/cloudflare/workerd/${tag}/${source}`;
  const beganAt = new Date().toISOString();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 2 * 1024 * 1024) throw new Error('Source size exceeds bound');
    const output = path.join(primary, path.basename(source));
    fs.writeFileSync(output, bytes, { flag: 'wx' });
    return { url, lockedTag: tag, source, beganAt, endedAt: new Date().toISOString(), httpStatus: response.status,
      acceptedOfficialLockedSource: response.status === 200, output: { path: output.replaceAll('\\', '/'), bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex') },
      headers: { contentType: response.headers.get('content-type'), etag: response.headers.get('etag') },
      authenticationUsed: false, productOrCIRequest: false };
  } catch (error) {
    return { url, lockedTag: tag, source, beganAt, endedAt: new Date().toISOString(), httpStatus: null,
      acceptedOfficialLockedSource: false, errorName: error.name, errorCode: error.cause?.code ?? null,
      authenticationUsed: false, productOrCIRequest: false };
  }
}));
const result = { schema: 'cinatoken-official-workerd-locked-source-read-v1', at: new Date().toISOString(),
  closed: true, actualSourceReadExit: results.every(row => row.acceptedOfficialLockedSource) ? 0 : 1,
  results, testOrAppExecution: false, packageUpgrades: 0, sourceWritesToRepo: 0, productionRequests: 0,
  gatePassDerived: false };
fs.writeFileSync(path.join(root, 'official-locked-source-read.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ actualSourceReadExit: result.actualSourceReadExit, results: results.map(row => ({ source: row.source,
  httpStatus: row.httpStatus, acceptedOfficialLockedSource: row.acceptedOfficialLockedSource, output: row.output,
  errorName: row.errorName, errorCode: row.errorCode })) }));
process.exitCode = result.actualSourceReadExit;
