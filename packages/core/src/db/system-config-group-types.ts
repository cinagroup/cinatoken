/** Raw snapshots remain server-side. Only the key/revision vector is public metadata. */
export interface ConfigSnapshot { key: string; value: string | null; revision: string | null }
export interface ConfigRevisionEntry { key: string; revision: string | null }
export type ConfigRevisionVector = readonly ConfigRevisionEntry[];
export type ToolConfigFamily = 'web-search' | 'web-fetch' | 'web-deep-search' | 'ai-detection';
export type ToolConfigProvider = 'bocha' | 'tavily' | 'cleversee' | 'tencent_wsa' | 'firecrawl' | 'jina' | 'tencent_tms';
export type ConfigGroupAuditAction = 'save' | 'save_activate' | 'activate' | 'legacy_save' | 'reveal';
export type ToolConfigAuditField = 'catalog' | 'active' | 'legacy_migration' | 'metered' | 'standard' | 'charged' | 'billingUnitChars' | 'region' | 'bizType' | 'apiKey' | 'secretId' | 'secretKey' | 'email';
export type ToolConfigCredentialField = 'apiKey' | 'secretId' | 'secretKey' | 'email';
export interface ConfigGroupChangedField { provider: ToolConfigProvider | null; field: ToolConfigAuditField }
export interface ConfigGroupCredentialAudit {
	provider: ToolConfigProvider;
	field: ToolConfigCredentialField;
	operation: 'keep' | 'set' | 'clear' | 'reveal';
	configuredBefore: boolean;
	configuredAfter: boolean;
}
/** Callers must redact reason against all known old/new credentials before this boundary. */
export interface ConfigGroupSafeAudit {
	auditId: string;
	actorKind: 'console' | 'admin_key';
	actorId: string;
	reason: string;
	action: ConfigGroupAuditAction;
	provider: ToolConfigProvider | null;
	changedFields: readonly ConfigGroupChangedField[];
	activeBefore: ToolConfigProvider | null;
	activeAfter: ToolConfigProvider | null;
	credentials: readonly ConfigGroupCredentialAudit[];
	source: 'admin_api' | 'legacy_admin';
	nowIso: string;
}
export interface ConfigGroupApplyInput {
	family: ToolConfigFamily;
	readSet: ConfigRevisionVector;
	writes: readonly { key: string; value: string }[];
	safeAudit: ConfigGroupSafeAudit;
}
export type ConfigGroupApplyResult =
	| { outcome: 'applied'; auditId: string; revisionVector: ConfigRevisionVector }
	| { outcome: 'unchanged' | 'conflict'; auditId: null; revisionVector: ConfigRevisionVector };
export interface ConfigGroupAuditRow extends Omit<ConfigGroupSafeAudit, 'auditId' | 'nowIso'> {
	id: string;
	family: ToolConfigFamily;
	revisionBefore: ConfigRevisionVector;
	revisionAfter: ConfigRevisionVector;
	createdAt: string;
}
export interface ConfigGroupAuditPageOptions { limit: number; before?: { createdAt: string; id: string } }
