/** Recovery ownership only. Never confers upstream dispatch or financial-policy authority. */
export type SettlementLeaseProof = Readonly<{ token: string; revision: number }>;
export function copySettlementLease(proof: SettlementLeaseProof): SettlementLeaseProof {
	const { token, revision } = proof;
	if (typeof token !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(token)
		|| !Number.isSafeInteger(revision) || revision < 1) throw new TypeError('Invalid settlement lease proof');
	return Object.freeze({ token, revision });
}
export class SettlementConflictError extends Error {
	constructor(message: string) { super(message); this.name = 'SettlementConflictError'; }
}
export class SettlementSnapshotInvalidError extends Error {
	constructor() { super('Stored settlement snapshot is invalid'); this.name = 'SettlementSnapshotInvalidError'; }
}
export class SettlementRecoveryClaimUncertainError extends Error {
	constructor() { super('Recovery claim acknowledgement uncertain; wait for lease recovery'); this.name = 'SettlementRecoveryClaimUncertainError'; }
}
