/** 共享类型：仓储接口与 D1/PG 实现共用，避免循环依赖。 */
export type BudgetFilter = "positive" | "zero_or_negative" | "null";

export interface InsertKeyParams {
	id: string;
	key: string;
	userId: string;
	workspaceId: string;
	name?: string | null;
	status?: string;
	metadata?: string | null;
	expiresAt?: string | null;
	limitMicros?: number | null;
	limitReset?: GatewayKeyLimitReset;
	includeByokInLimit?: boolean;
}

export type GatewayKeyLimitReset = "daily" | "weekly" | "monthly" | null;

export interface ManagementGatewayKeyRow {
	id: string;
	key_hash: string;
	key_preview: string;
	user_id: string;
	workspace_id: string;
	name: string | null;
	status: string;
	expires_at: string | null;
	limit_micros: number | null;
	limit_reset: GatewayKeyLimitReset;
	include_byok_in_limit: boolean;
	limit_epoch: number;
	created_at: string;
	updated_at: string;
	usage: number;
	usage_daily: number;
	usage_weekly: number;
	usage_monthly: number;
}

export interface ManagementGatewayKeyListParams {
	accountType: "personal" | "organization";
	personalOwnerUserId: string | null;
	organizationId: string | null;
	workspaceId: string;
	includeDisabled: boolean;
	offset: number;
}

export interface ManagementGatewayKeyLookupParams {
	accountType: "personal" | "organization";
	personalOwnerUserId: string | null;
	organizationId: string | null;
	keyHash: string;
}

export interface ManagementGatewayKeyPatch {
	name?: string;
	status?: "active" | "disabled";
	limitMicros?: number | null;
	limitReset?: GatewayKeyLimitReset;
	includeByokInLimit?: boolean;
}
