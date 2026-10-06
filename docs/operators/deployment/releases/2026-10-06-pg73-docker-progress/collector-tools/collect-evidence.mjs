import fs from 'node:fs';
import { collect, prepare, tempDestination } from './evidence-lib.mjs';
const [mode, configFile, output] = process.argv.slice(2);
if (!['audit', 'collect'].includes(mode) || !configFile) throw new Error('Use: node collect-evidence.mjs audit|collect CONFIG.json [new audit report path]');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
if (mode === 'audit') {
  const plan = prepare(config);
  if (output) fs.writeFileSync(tempDestination(output), `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ entries: plan.entries.length, exclusions: plan.exclusions.length, blockers: plan.blockers, receipts: plan.receipts.length })}\n`);
  if (plan.blockers.length) process.exitCode = 1;
} else {
  const result = collect(config);
  process.stdout.write(`${JSON.stringify({ report: result.reportPath, reportBytes: result.bytes, reportSha256: result.sha256, totals: result.report.totals, gatePassDerived: false })}\n`);
}
