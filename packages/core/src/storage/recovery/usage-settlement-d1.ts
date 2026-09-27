import type { D1DatabaseClient } from '../database-client';
import { insertRequestUsageAndChargeTxD1 } from '../../db/d1/critical-writes.impl';
import { guardrailBudgetUnits } from '../../db/guardrail-budget-types';
import { roundGatewayMoney } from '../../lib/money-precision';
import { decodeUsageSettlement, encodeUsageSettlement, settlementId, type UsageSettlement } from './usage-settlement-codec';
import { copySettlementLease, SettlementConflictError, SettlementSnapshotInvalidError, type SettlementLeaseProof } from './settlement-recovery-types';

export type SettlementReference = Readonly<{ requestId: string; userId: string; apiKeyId: string; workspaceId: string; payloadSha256: string }>;
export function ownSettlementReference(ref: SettlementReference): SettlementReference {
	const copy = { requestId: ref.requestId, userId: ref.userId, apiKeyId: ref.apiKeyId, workspaceId: ref.workspaceId, payloadSha256: ref.payloadSha256 };
	if (![copy.requestId, copy.userId, copy.apiKeyId, copy.workspaceId].every(settlementId)
		|| typeof copy.payloadSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(copy.payloadSha256)) throw new TypeError('Invalid settlement reference');
	return Object.freeze(copy);
}
type StoredRow = {
	request_id: string; attempt_index: number; user_id: string; api_key_id: string; workspace_id: string;
	operation: string; context_sha256: string; dispatch_claim_id: string; payload_version: number;
	payload_json: string; payload_sha256: string; recorded_at: string;
};

/** Disabled prototype: caller must supply an authorized tenant reference. No routes, timers or provider I/O. */
export function createUsageSettlementRepositoryD1(client: D1DatabaseClient) {
	async function load(ref: SettlementReference): Promise<UsageSettlement> {
		const row = await client.raw.prepare(`SELECT * FROM request_usage_settlements
			WHERE request_id=? AND user_id=? AND api_key_id=? AND workspace_id=? AND payload_sha256=?`)
			.bind(ref.requestId, ref.userId, ref.apiKeyId, ref.workspaceId, ref.payloadSha256).first<StoredRow>();
		if (!row) throw new SettlementConflictError('Settlement missing or identity conflict');
		let value: UsageSettlement;
		try { value = await decodeUsageSettlement(row.payload_json, ref.payloadSha256); }
		catch { throw new SettlementSnapshotInvalidError(); }
		const i = value.intent;
		if (i.requestId !== ref.requestId || i.userId !== ref.userId || i.apiKeyId !== ref.apiKeyId || i.workspaceId !== ref.workspaceId
			|| row.attempt_index !== i.attemptIndex || row.operation !== i.operation || row.context_sha256 !== i.contextSha256
			|| row.dispatch_claim_id !== value.dispatchClaimId || row.recorded_at !== value.recordedAtIso || row.payload_version !== value.version) throw new SettlementConflictError('Stored settlement identity conflict');
		return value;
	}
	async function committed(ref: SettlementReference, value: UsageSettlement): Promise<boolean> {
		// LEFT JOIN distinguishes no receipt from a receipt with a missing/tampered log.
		const row = await client.raw.prepare(`SELECT r.payload_sha256, r.recorded_at,
			l.id, l.user_id, l.api_key_id, l.workspace_id, l.model_id, l.provider_id, l.request_operation,
			l.charged_cost, l.budget_charged_micros, l.created_at
			FROM request_usage_commit_receipts r LEFT JOIN api_key_request_logs l ON l.id=r.request_id
			WHERE r.request_id=?`)
			.bind(ref.requestId).first<{
				payload_sha256: string; recorded_at: string; id: string | null; user_id: string | null;
				api_key_id: string | null; workspace_id: string | null; model_id: string | null; provider_id: string | null;
				request_operation: string | null; charged_cost: number | null; budget_charged_micros: number | null; created_at: string | null;
			}>();
		if (!row) return false;
		const p = value.params, log = p.requestLog;
		if (row.payload_sha256 !== ref.payloadSha256 || row.recorded_at !== value.recordedAtIso || row.id !== ref.requestId
			|| row.user_id !== ref.userId || row.api_key_id !== ref.apiKeyId || row.workspace_id !== ref.workspaceId
			|| row.model_id !== log.modelId || row.provider_id !== log.providerId || row.request_operation !== value.intent.operation
			|| row.charged_cost === null || roundGatewayMoney(Number(row.charged_cost)) !== roundGatewayMoney(p.chargedCost)
			|| row.budget_charged_micros !== (p.shouldChargeBudget ? guardrailBudgetUnits(roundGatewayMoney(p.chargedCost)) : 0)
			|| row.created_at !== value.recordedAtIso) throw new SettlementConflictError('Settlement receipt or committed log conflict');
		return true;
	}
	return {
		async persist(input: UsageSettlement): Promise<SettlementReference> {
			// encode copies before yielding; do not reread the caller's mutable object afterwards.
			const encoded = await encodeUsageSettlement(input);
			const value = await decodeUsageSettlement(encoded.json, encoded.sha256), i = value.intent;
			const ref = ownSettlementReference({ requestId: i.requestId, userId: i.userId, apiKeyId: i.apiKeyId, workspaceId: i.workspaceId, payloadSha256: encoded.sha256 });
			try {
				await client.raw.prepare(`INSERT INTO request_usage_settlements
					(request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,dispatch_claim_id,payload_version,payload_json,payload_sha256,recorded_at)
					VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING`)
					.bind(i.requestId, i.attemptIndex, i.userId, i.apiKeyId, i.workspaceId, i.operation, i.contextSha256,
						value.dispatchClaimId, value.version, encoded.json, encoded.sha256, value.recordedAtIso).run();
			} catch {
				// A persisted result grants no new inference. Exact readback can reconcile lost ACK.
			}
			await load(ref);
			return ref;
		},
		async commit(reference: SettlementReference, ownership?: SettlementLeaseProof): Promise<'committed'> {
			const ref = ownSettlementReference(reference), lease = ownership ? copySettlementLease(ownership) : undefined;
			const value = await load(ref);
			if (await committed(ref, value)) return 'committed';
			let failure: unknown, failed = false;
			try {
				await insertRequestUsageAndChargeTxD1(client, value.params, { payloadSha256: ref.payloadSha256, recordedAtIso: value.recordedAtIso, lease });
			} catch (error) { failure = error; failed = true; }
			// Required even if the old reserved-budget path returned normally: a legacy
			// log with the same id/amount is NOT proof this immutable event was committed.
			if (await committed(ref, value)) return 'committed';
			if (failed) throw failure;
			throw new SettlementConflictError('Settlement commit not confirmed by an atomic receipt');
		},
	};
}
