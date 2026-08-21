/**
 * 用户门户 / 共享密钥市场数据类型。
 *
 * 覆盖六张新表（migration 0027）：
 * - `portal_sessions` 普通用户门户会话
 * - `shared_keys` 卖家上架的个人上游 API Key（仅限官方渠道白名单）
 * - `shared_key_earnings` 按请求结算的卖家收益流水（幂等于 `api_key_request_logs.id`）
 * - `user_earnings` 卖家账本（余额/锁定的提现金额/累计贡献值/钱包）
 * - `withdrawals` 链上 CINA-C 自动提现单
 * - `nft_mints` cinachain CinaBadge 位阶徽章铸造记录
 */

/** 允许共享密钥注入的官方渠道（`providers.shared_channel_type` 与 `shared_keys.channel_type` 共用）。 */
export type SharedKeyChannelType = 'openai' | 'anthropic' | 'zhipu' | 'deepseek';

export const SHARED_KEY_CHANNEL_TYPES: readonly SharedKeyChannelType[] = [
	'openai',
	'anthropic',
	'zhipu',
	'deepseek',
];

export function isSharedKeyChannelType(value: unknown): value is SharedKeyChannelType {
	return typeof value === 'string' && (SHARED_KEY_CHANNEL_TYPES as readonly string[]).includes(value);
}

/**
 * `shared_keys.status`：
 * - `validating` 上架校验中（调官方 /models 验证）
 * - `active` 参与调度
 * - `paused` 卖家暂停
 * - `invalid` 上游 401/403 或校验失败，自动停用
 * - `disabled` 管理员停用
 */
export type SharedKeyStatus = 'validating' | 'active' | 'paused' | 'invalid' | 'disabled';

export interface SharedKeyRow {
	id: string;
	sellerUserId: string;
	channelType: SharedKeyChannelType | string;
	/** 明文；仓储层之外一律使用掩码/指纹。 */
	apiKey: string;
	keyFingerprint: string;
	label: string | null;
	status: SharedKeyStatus | string;
	/** 平台/管理员调节的层间优先级（越高越先）。 */
	sellerPriority: number;
	/** 同 priority 层内权重，固定降序调度。 */
	weight: number;
	/** 卖家要价（每 1M token，BILLING_CURRENCY 计价）。 */
	inputPrice: number;
	outputPrice: number;
	cacheReadPrice: number | null;
	cacheWritePrice: number | null;
	validatedAt: string | null;
	lastUsedAt: string | null;
	lastFailureAt: string | null;
	failureReason: string | null;
	servedInputTokens: number;
	servedOutputTokens: number;
	earnedTotal: number;
	createdAt: string;
	updatedAt: string;
}

export interface InsertSharedKeyParams {
	id: string;
	sellerUserId: string;
	channelType: SharedKeyChannelType;
	apiKey: string;
	keyFingerprint: string;
	label?: string | null;
	weight: number;
	inputPrice: number;
	outputPrice: number;
	cacheReadPrice?: number | null;
	cacheWritePrice?: number | null;
	nowIso: string;
}

export interface UpdateSharedKeyPatch {
	label?: string | null;
	status?: SharedKeyStatus;
	weight?: number;
	sellerPriority?: number;
	inputPrice?: number;
	outputPrice?: number;
	cacheReadPrice?: number | null;
	cacheWritePrice?: number | null;
	failureReason?: string | null;
}

export interface SharedKeyEarningRow {
	id: string;
	/** 幂等键：`api_key_request_logs.id`。 */
	requestLogId: string;
	sharedKeyId: string;
	sellerUserId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** 卖家应得（卖家单价 × token 量）。 */
	grossAmount: number;
	/** 平台佣金 = gross × commission。 */
	platformFee: number;
	netAmount: number;
	currency: string;
	createdAt: string;
}

export interface InsertSharedKeyEarningParams {
	id: string;
	requestLogId: string;
	sharedKeyId: string;
	sellerUserId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	grossAmount: number;
	platformFee: number;
	netAmount: number;
	currency: string;
	nowIso: string;
}

export interface UserEarningsRow {
	userId: string;
	balance: number;
	/** 提现中锁定金额。 */
	lockedAmount: number;
	lifetimeEarned: number;
	lifetimeWithdrawn: number;
	/** NFT 分档依据：累计净收益。 */
	contributionValue: number;
	walletAddress: string | null;
	walletVerifiedAt: string | null;
	highestBadgeTier: number;
	updatedAt: string;
}

export type WithdrawalStatus =
	| 'requested'
	| 'processing'
	| 'submitted'
	| 'confirmed'
	| 'failed';

export interface WithdrawalRow {
	id: string;
	userId: string;
	amount: number;
	fee: number;
	netAmount: number;
	currency: string;
	walletAddress: string;
	status: WithdrawalStatus | string;
	/** 链上到账的 CINA-C 数量（amount × 汇率）。 */
	tokenAmount: number | null;
	txHash: string | null;
	chainId: number | null;
	failureReason: string | null;
	createdAt: string;
	updatedAt: string;
	confirmedAt: string | null;
}

export interface InsertWithdrawalParams {
	id: string;
	userId: string;
	amount: number;
	fee: number;
	netAmount: number;
	currency: string;
	walletAddress: string;
	tokenAmount: number;
	nowIso: string;
}

export type NftMintStatus = 'pending' | 'submitted' | 'confirmed' | 'failed';

export interface NftMintRow {
	id: string;
	userId: string;
	/** CinaBadge tokenId（cinatoken 专属位阶从 200 起）。 */
	badgeTokenId: number;
	tierName: string;
	walletAddress: string;
	status: NftMintStatus | string;
	txHash: string | null;
	chainId: number | null;
	/** 铸造时的 contribution_value 快照。 */
	valueSnapshot: number;
	failureReason: string | null;
	createdAt: string;
	confirmedAt: string | null;
}

export interface InsertNftMintParams {
	id: string;
	userId: string;
	badgeTokenId: number;
	tierName: string;
	walletAddress: string;
	valueSnapshot: number;
	nowIso: string;
}

export interface PortalSessionRow {
	tokenHash: string;
	subject: string;
	email: string;
	createdAt: string;
	expiresAt: string;
}
