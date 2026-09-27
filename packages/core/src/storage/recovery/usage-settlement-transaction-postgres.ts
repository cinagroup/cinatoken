import { sql, type SQL } from 'drizzle-orm';
import { encodeUsageSettlement, decodeUsageSettlement, type UsageSettlement } from './usage-settlement-codec';
import { ownPostgresSettlementReference, type PostgresSettlementReference } from './usage-settlement-facts-postgres';
import { SettlementConflictError, type SettlementLeaseProof } from './settlement-recovery-types';

/** Internal opt-in for the existing PG critical writer, not a public route or policy decision. */
export type PostgresUsageRecoveryInput = Readonly<{ ref: PostgresSettlementReference; proof: SettlementLeaseProof; recordedAtIso: string }>;
export type PreparedPostgresUsageRecovery = Readonly<PostgresUsageRecoveryInput & { value: UsageSettlement }>;
type Transaction = { execute(query: SQL): PromiseLike<unknown> };
export function ownPostgresCommitProof(value: SettlementLeaseProof): SettlementLeaseProof {
  const token=value.token,revision=value.revision;
  if(typeof token!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/.test(token)
    ||!Number.isSafeInteger(revision)||revision<1||revision>=Number.MAX_SAFE_INTEGER)throw new TypeError('Invalid PostgreSQL settlement proof');
  return Object.freeze({token,revision});
}
// PostgreSQL text cannot represent NUL or lone UTF-16 surrogates. Keep their original JSON in
// the durable fact, but never silently drop/replace them while writing financial log columns.
// A future lossless log-encoding contract is required for these inputs; no public limit changes.
function requireRepresentableText(value: unknown): void {
  if(typeof value==='string'){
    for(let i=0;i<value.length;i++){
      const unit=value.charCodeAt(i);
      if(unit===0)throw new SettlementConflictError('Settlement text cannot be represented losslessly by PostgreSQL log columns');
      if(unit>=0xd800&&unit<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw new SettlementConflictError('Settlement text cannot be represented losslessly by PostgreSQL log columns');}
      else if(unit>=0xdc00&&unit<=0xdfff)throw new SettlementConflictError('Settlement text cannot be represented losslessly by PostgreSQL log columns');
    }
  }else if(value&&typeof value==='object')for(const child of Object.values(value))requireRepresentableText(child);
}
export async function preparePostgresUsageRecovery(params: UsageSettlement['params'],input: PostgresUsageRecoveryInput): Promise<PreparedPostgresUsageRecovery> {
  const ref=ownPostgresSettlementReference(input.ref),proof=ownPostgresCommitProof(input.proof),recordedAtIso=input.recordedAtIso;
  const {payloadSha256,dispatchClaimId,...intent}=ref;
  // Own the full DTO synchronously in encode before any await; do not reuse caller params.
  const encoded=await encodeUsageSettlement({version:1,intent,dispatchClaimId,recordedAtIso,params});
  if(encoded.sha256!==payloadSha256)throw new SettlementConflictError('Critical writer input does not match the immutable fact');
  const value=await decodeUsageSettlement(encoded.json,encoded.sha256);requireRepresentableText(value.params);
  return Object.freeze({ref,proof,recordedAtIso,value});
}
export async function beginPostgresUsageRecovery(tx: Transaction,value: PreparedPostgresUsageRecovery): Promise<void> {
  const {ref,proof}=value;
  // Receipt trigger locks the exact job, checks its live DB deadline AFTER lock acquisition,
  // rejects a pre-existing log, and records the original lease. No separate transaction.
  await tx.execute(sql`INSERT INTO cinatoken_gateway.request_usage_commit_receipts
    (request_id,payload_sha256,user_id,workspace_id,recorded_at,lease_token,lease_revision)
    VALUES (${ref.requestId},${ref.payloadSha256},${ref.userId},${ref.workspaceId},${value.recordedAtIso},${proof.token},${proof.revision})`);
}
export async function finishPostgresUsageRecovery(tx: Transaction,value: PreparedPostgresUsageRecovery): Promise<void> {
  const {ref,proof}=value;
  const rows=await tx.execute(sql`UPDATE cinatoken_gateway.request_usage_recovery_jobs
    SET state='committed',last_transition='committed',revision=revision+1,lease_token=NULL,lease_seconds=NULL,last_error=NULL
    WHERE request_id=${ref.requestId} AND payload_sha256=${ref.payloadSha256} AND user_id=${ref.userId} AND workspace_id=${ref.workspaceId}
      AND state='leased' AND revision=${proof.revision} AND lease_token=${proof.token} RETURNING request_id`);
  if(!Array.isArray(rows)||rows.length!==1)throw new SettlementConflictError('Settlement lease no longer owns final transaction');
  // Deferred receipt validation still runs at COMMIT. Do not SET CONSTRAINTS early or invoke
  // caller callbacks after this point. A thrown error rolls back ALL existing critical writes.
}
