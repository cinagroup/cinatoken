import { createHash } from 'node:crypto';
import {
	createPrivateCompleteTextHolderV365,
	type PrivateCompleteTextHolderPortsV365,
} from './private-complete-text-holder-v365';
import type {
	CommittedCompleteTextResultFactV367,
	CompleteTextHolderEvidenceV367,
} from './postgres-complete-text-result-facts-v367';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

type FetchInvokedEvidence = Extract<CompleteTextHolderEvidenceV367,
	{ kind: 'fetch_invoked' }>;

export type HolderFetchFactInputV384 = Readonly<{
	grantId: string;
	holderRunId: string;
	expectedEpoch: number;
	evidenceNonce: string;
	evidence: FetchInvokedEvidence;
}>;

export type ObservedPrivateTextHolderPortsV384 = PrivateCompleteTextHolderPortsV365 &
	Readonly<{
		/** Must be a direct v367 holder-result LOGIN with COMMIT and close ACK. */
		appendFetchInvokedFact(input: HolderFetchFactInputV384):
			Promise<CommittedCompleteTextResultFactV367>;
	}>;

/** Stable across an uncertain fact ACK; replaying it never grants another POST. */
export function fetchInvokedEvidenceNonceV384(grantId: string,
	holderRunId: string, sendStartId: string): string {
	if (!UUID.test(grantId) || !UUID.test(holderRunId) || !UUID.test(sendStartId)) {
		throw new TypeError('Observed holder fact identity invalid');
	}
	const bytes = createHash('sha256')
		.update('cinatoken.complete_text.fetch_invoked.v384\0')
		.update(grantId).update('\0').update(holderRunId).update('\0')
		.update(sendStartId).digest();
	const uuid = Uint8Array.from(bytes.subarray(0, 16));
	uuid[6] = (uuid[6]! & 0x0f) | 0x50;
	uuid[8] = (uuid[8]! & 0x3f) | 0x80;
	const hex = Buffer.from(uuid).toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
		+ `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Review-only holder composition. A v365 send-start remains possible-send even
 * when fetch or fact ACK fails. This records invocation, never usage or a bill.
 * Existing v365 callers do not construct this wrapper.
 */
export function createObservedPrivateCompleteTextHolderV384(
	ports: ObservedPrivateTextHolderPortsV384,
) {
	if (typeof ports?.appendFetchInvokedFact !== 'function') {
		throw new TypeError('Dedicated holder fact port required');
	}
	let start: Readonly<{
		grantId: string; holderRunId: string; sendStartId: string;
		expectedEpoch: number; uploadSha256: string;
	}> | null = null;
	return createPrivateCompleteTextHolderV365({
		...ports,
		async recordSendStart(grantId, holderRunId, expectedEpoch, uploadSha256) {
			const result = await ports.recordSendStart(grantId, holderRunId,
				expectedEpoch, uploadSha256);
			if (result && typeof result === 'object') {
				const row = result as Record<string, unknown>;
				if (row.status === 'start_recorded' && row.commitAcknowledged === true
					&& typeof row.sendStartId === 'string' && UUID.test(row.sendStartId)
					&& row.grantId === grantId && row.holderRunId === holderRunId
					&& row.leaseEpoch === expectedEpoch && row.uploadSha256 === uploadSha256
					&& SHA256.test(uploadSha256)) {
					start = Object.freeze({ grantId, holderRunId, expectedEpoch,
						uploadSha256, sendStartId: row.sendStartId });
				}
			}
			return result;
		},
		fetchUpstream(url, init) {
			if (!start) throw new TypeError('Committed holder send-start required');
			const current = start;
			start = null;
			const factFailureAbort = new AbortController();
			const originalSignal = init?.signal;
			const forwarded = { ...init,
				signal: originalSignal
					? AbortSignal.any([originalSignal, factFailureAbort.signal])
					: factFailureAbort.signal };
			// Invoke fetch first. A synchronous throw leaves only the committed
			// possible-send start; it does not create an invocation fact.
			const response = (ports.fetchUpstream ?? fetch)(url, forwarded);
			const evidenceNonce = fetchInvokedEvidenceNonceV384(current.grantId,
				current.holderRunId, current.sendStartId);
			const evidenceSha256 = createHash('sha256').update(
				`{"observation": "fetch_invoked", "uploadSha256": "${current.uploadSha256}"}`,
			).digest('hex');
			let append: Promise<CommittedCompleteTextResultFactV367>;
			try {
				append = Promise.resolve(ports.appendFetchInvokedFact(Object.freeze({
					grantId: current.grantId, holderRunId: current.holderRunId,
					expectedEpoch: current.expectedEpoch, evidenceNonce,
					evidence: Object.freeze({ kind: 'fetch_invoked',
						observation: 'fetch_invoked',
						uploadSha256: current.uploadSha256 }),
				})));
			} catch (error) { append = Promise.reject(error); }
			const received = Promise.resolve(response);
			const committedFact = append.then(receipt => {
				if (receipt.status !== 'fact_recorded'
					&& receipt.status !== 'already_recorded') {
					throw new TypeError('Holder fact receipt status invalid');
				}
				if (receipt.commitAcknowledged !== true
					|| receipt.sourceKind !== 'holder'
					|| receipt.kind !== 'fetch_invoked'
					|| receipt.grantId !== current.grantId
					|| receipt.evidenceNonce !== evidenceNonce
					|| !UUID.test(receipt.factId)
					|| receipt.evidenceSha256 !== evidenceSha256) {
					throw new TypeError('Holder fact receipt identity invalid');
				}
				return receipt;
			}).catch(error => {
				factFailureAbort.abort();
				// fetch may have returned headers before the fact ACK failed. The
				// Response has not been handed to the caller; release its body.
				void received.then(value => value.body?.cancel()).catch(() => {});
				throw error;
			});
			// A transport rejection must not outrun a fact append already in
			// flight. Wait for its COMMIT/close observation before surfacing it.
			return Promise.allSettled([received, committedFact]).then(outcomes => {
				const fact = outcomes[1]!;
				if (fact.status === 'rejected') throw fact.reason;
				const wire = outcomes[0]!;
				if (wire.status === 'rejected') throw wire.reason;
				return wire.value;
			});
		},
	});
}
