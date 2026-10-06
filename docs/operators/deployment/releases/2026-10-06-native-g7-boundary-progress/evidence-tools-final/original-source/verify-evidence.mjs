import fs from 'node:fs';
import { tempDestination, verify } from './evidence-lib.mjs';
const [reportPath, newReceipt, sourceMode = 'with-source'] = process.argv.slice(2);
if (!reportPath || !newReceipt || !['with-source', 'stored-only'].includes(sourceMode)) throw new Error('Use: node verify-evidence.mjs REPORT.json new-verification-receipt.json [with-source|stored-only]');
const result = verify(reportPath, { verifySource: sourceMode === 'with-source' });
fs.writeFileSync(tempDestination(newReceipt), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify(result)}\n`);
