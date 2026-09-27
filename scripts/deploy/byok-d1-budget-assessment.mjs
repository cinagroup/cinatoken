import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hex = /^[a-f0-9]{64}$/;
const run = /^c02-byok-[a-f0-9]{12}$/;
const identityKeys = ['runId', 'candidateSha256', 'priorManifestSha256', 'scopeSha256'];
const usageKeys = ['workersRequests', 'workersCpuMs', 'd1RowsRead', 'd1RowsWritten', 'd1StorageMicroGbMonths'];
const directKeys = ['logsMicros', 'modelsMicros', 'kmsMicros', 'otherCloudMicros', 'newSubscriptionsMicros'];
const phases = ['execution', 'containment', 'retention'];
const CAP = 2000000n;
const CARRIED = 1200000n;
const exact = (value, keys) => {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
const amount = value => {
  // Decimal integer strings only. No float, exponent, sign, rounding down, or
  // precision loss at Number.MAX_SAFE_INTEGER. Bounds also keep work finite.
  assert.ok(typeof value === 'string' && /^(0|[1-9][0-9]{0,23})$/.test(value));
  return BigInt(value);
};
const ceil = (n, d) => (n + d - 1n) / d;

export const BYOK_BUDGET_RATE_CARD = Object.freeze({
  id: 'cloudflare-standard-workers-d1-2026-09-21',
  currency: 'USD',
  workersSource: 'https://developers.cloudflare.com/workers/platform/pricing/',
  d1Source: 'https://developers.cloudflare.com/d1/platform/pricing/',
  includedAllowancesDeducted: false,
});

/** Pure arithmetic under the published Standard tariffs, NOT a price guarantee
 * or proof of a query's maximum usage. Every supplied quantity must bound total
 * usage, including service-bound CPU and D1 index writes. Storage is expressed
 * as millionths of a GB-month over a FINITE, separately proved horizon.
 * Shared free allowances are deliberately ignored. Round each line UP to one
 * micro-dollar; do not net refunds, credits, reservations or unrelated invoices.
 * Logs / model / KMS / other products and subscriptions are NOT priced here.
 */
export function priceByokD1UsageUpperBound(input) {
  exact(input, usageKeys);
  const q = Object.fromEntries(usageKeys.map(k => [k, amount(input[k])]));
  const costs = {
    workersRequests: ceil(q.workersRequests * 3n, 10n),
    workersCpuMs: ceil(q.workersCpuMs, 50n),
    d1RowsRead: ceil(q.d1RowsRead, 1000n),
    d1RowsWritten: q.d1RowsWritten,
    d1StorageMicroGbMonths: ceil(q.d1StorageMicroGbMonths * 3n, 4n),
  };
  return {
    rateCardId: BYOK_BUDGET_RATE_CARD.id,
    currency: 'USD',
    costsMicros: Object.fromEntries(Object.entries(costs).map(([k, v]) => [k, String(v)])),
    totalMicros: String(Object.values(costs).reduce((a, b) => a + b, 0n)),
    includedAllowancesDeducted: false,
    usageBoundsVerified: false,
  };
}

/** Assess candidate-scoped inputs without network, files, budget mutation, or
 * admission callbacks. Evidence hashes IDENTIFY upstream proof obligations;
 * they do not verify provenance, freshness, coverage, or enforce usage limits.
 *
 * A caller cannot turn this result into cumulativeBudgetReserved: even a fully
 * fitting calculation has costBoundsVerified/reservationCreated=false. A future
 * trusted provider must verify each underlying bound, the complete historical
 * and outstanding ledger, and reserve atomically BEFORE invoking an operator.
 * Never treat an after-response usage check or a HTTP timeout as a pre-send cap.
 */
export function assessByokD1Budget(input) {
  const data = structuredClone(input);
  exact(data, ['identity', 'firstRoundUsdCap', 'capReset', 'currency', 'history', 'outstanding', 'phases']);
  exact(data.identity, identityKeys);
  assert.match(data.identity.runId, run);
  for (const k of identityKeys.slice(1)) assert.match(data.identity[k], hex);
  assert.equal(data.firstRoundUsdCap, 2);
  assert.equal(data.capReset, false);
  assert.equal(data.currency, 'USD');
  const missing = [], obligations = [];
  function evidence(value, label) {
    if (value === null) missing.push(label + '.evidence');
    else { assert.match(value, hex); obligations.push({domain: label, evidenceSha256: value}); }
  }
  function bound(value, label) {
    if (value === null) { missing.push(label); return null; }
    return amount(value);
  }
  exact(data.history, ['carriedReserveMicros', 'incurredUpperBoundMicros', 'evidenceSha256']);
  assert.equal(amount(data.history.carriedReserveMicros), CARRIED);
  const historical = bound(data.history.incurredUpperBoundMicros, 'history.incurredUpperBoundMicros');
  evidence(data.history.evidenceSha256, 'history');
  // Keep the historical/delayed reserve even when visible billed costs are zero.
  // Raising it for larger incurred costs is allowed; releasing it is not.
  const heldHistory = historical === null ? null : historical > CARRIED ? historical : CARRIED;
  exact(data.outstanding, ['entries', 'evidenceSha256']);
  evidence(data.outstanding.evidenceSha256, 'outstanding');
  assert.ok(Array.isArray(data.outstanding.entries) && data.outstanding.entries.length <= 100);
  const ids = new Set();
  let heldOutstanding = 0n;
  for (const entry of data.outstanding.entries) {
    exact(entry, ['runId', 'reservedMicros', 'evidenceSha256']);
    assert.match(entry.runId, run);
    assert.ok(entry.runId !== data.identity.runId && !ids.has(entry.runId));
    ids.add(entry.runId);
    heldOutstanding += amount(entry.reservedMicros);
    evidence(entry.evidenceSha256, 'outstanding.' + entry.runId);
  }
  exact(data.phases, phases);
  const calculated = {};
  for (const phase of phases) {
    const p = data.phases[phase];
    exact(p, ['usage', 'directCosts', 'evidenceSha256']);
    exact(p.usage, usageKeys);
    exact(p.directCosts, directKeys);
    evidence(p.evidenceSha256, phase);
    let known = true;
    for (const k of usageKeys) if (bound(p.usage[k], phase + '.usage.' + k) === null) known = false;
    let direct = 0n;
    for (const k of directKeys) {
      const n = bound(p.directCosts[k], phase + '.directCosts.' + k);
      if (n === null) known = false;
      else direct += n;
    }
    // Do not silently price an omitted cost or an indefinite retention horizon
    // as zero. No phase subtotal is usable until ALL its dimensions are known.
    const priced = known ? priceByokD1UsageUpperBound(p.usage) : null;
    calculated[phase] = {
      usage: priced,
      totalMicros: known ? String(BigInt(priced.totalMicros) + direct) : null,
    };
  }
  const amountsKnown = heldHistory !== null && phases.every(p => calculated[p].totalMicros !== null);
  const required = amountsKnown ? heldHistory + heldOutstanding + phases.reduce((n, p) => n + BigInt(calculated[p].totalMicros), 0n) : null;
  const fits = required === null ? null : required <= CAP;
  const report = {
    version: 1,
    identity: data.identity,
    inputSha256: hash(data),
    rateCard: {...BYOK_BUDGET_RATE_CARD},
    firstRoundUsdCap: 2, capReset: false, currency: 'USD',
    capMicros: String(CAP), carriedReserveMicros: String(CARRIED),
    heldHistoryMicros: heldHistory === null ? null : String(heldHistory),
    heldOutstandingMicros: String(heldOutstanding), phases: calculated,
    totalRequiredMicros: required === null ? null : String(required),
    // This is unallocated capacity in the supplied calculation, NOT a balance.
    arithmeticUnallocatedMicros: fits === true ? String(CAP - required) : null,
    arithmeticFits: fits, missing, proofObligations: obligations,
    result: missing.length ? 'INCOMPLETE_BUDGET_INPUTS' : fits ? 'CALCULATED_REQUIRES_PROOF_AND_RESERVATION' : 'OVER_BUDGET',
    costBoundsVerified: false, reservationCreated: false,
    cumulativeBudgetReserved: false, fullPreflightPassed: false,
    mayDeploy: false, actualBalanceVerified: false,
  };
  return {...report, evidenceSha256: hash(report)};
}
