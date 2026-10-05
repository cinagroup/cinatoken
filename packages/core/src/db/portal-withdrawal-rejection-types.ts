/** Administrative rejection never refunds a claimed or signed chain job. */
export type RejectRequestedWithdrawalResult =
	| { kind: 'rejected'; withdrawalId: string }
	| { kind: 'conflict' }
	| { kind: 'not-found' };
