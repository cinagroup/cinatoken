import type { PostgresDatabaseClient } from '../database-client';
import { insertRequestUsageAndChargeTxPg } from '../../db/postgres/critical-writes.impl';
import { createUsageSettlementFactsRepositoryPostgres, ownPostgresSettlementReference, type PostgresSettlementReference } from './usage-settlement-facts-postgres';
import { ownPostgresCommitProof } from './usage-settlement-transaction-postgres';
import { SettlementConflictError, type SettlementLeaseProof } from './settlement-recovery-types';

/** Disabled local prototype. Caller authorization/financial policy and production wiring remain gates. */
export function createUsageSettlementRepositoryPostgres(client: PostgresDatabaseClient) {
  if(client.driver!=='postgres')throw new TypeError('PostgreSQL settlement authority required');
  const facts=createUsageSettlementFactsRepositoryPostgres(client);
  async function confirmed(ref: PostgresSettlementReference): Promise<boolean> {
    const rows=await client.raw.unsafe<{payload_sha256:string;matched:boolean}[]>(`SELECT payload_sha256,
      cinatoken_gateway.usage_commit_matches(request_id,$2) AS matched
      FROM cinatoken_gateway.request_usage_commit_receipts WHERE request_id=$1`,[ref.requestId,ref.payloadSha256]);
    if(rows.length===0)return false;
    if(rows.length!==1||rows[0].payload_sha256!==ref.payloadSha256||rows[0].matched!==true)throw new SettlementConflictError('PostgreSQL receipt or committed result conflict');
    return true;
  }
  return {
    async commit(reference: PostgresSettlementReference,ownership: SettlementLeaseProof): Promise<'committed'> {
      const ref=ownPostgresSettlementReference(reference),proof=ownPostgresCommitProof(ownership);
      const value=await facts.load(ref);
      // Read-only confirmation of a previous matching transaction is safe even for an old proof;
      // it grants neither a lease nor another financial write.
      if(await confirmed(ref))return 'committed';
      let failure:unknown,failed=false;
      try{await insertRequestUsageAndChargeTxPg(client,value.params,{ref,proof,recordedAtIso:value.recordedAtIso});}
      catch(error){failure=error;failed=true;}
      // Never blindly resubmit the write on a lost COMMIT ACK, and never adopt an unreceipted log.
      if(await confirmed(ref))return 'committed';
      if(failed)throw failure;
      throw new SettlementConflictError('PostgreSQL settlement commit unconfirmed');
    },
  };
}
