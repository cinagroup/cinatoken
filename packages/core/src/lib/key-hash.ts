/**
 * 认证密钥的哈希查找辅助（审计 M2 第二/三阶段）。
 *
 * admin_api_keys.secret_key 与 api_keys.key 此前明文存库且以明文为索引键
 * 查找。两条热路径（管理 Bearer 认证、网关 sk 认证）改为哈希优先：
 * 各实现内部先按 `secret_key_hash`/`key_hash` 索引查找，miss 再回退明文
 * 列（迁移窗口内的旧行），命中即惰性回填哈希 —— 接口与服务层零改动。
 * 明文列保留至全量回填完成后由运维选择清空（届时查找自动只走哈希）。
 *
 * 前缀 `sha256:` 预留算法敏捷性：未来换 KDF 时以新前缀并存。
 */
const encoder = new TextEncoder();
const GATEWAY_KEY_STORAGE_PREFIX = 'hashref:';

function toHex(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
	return out;
}

export async function hashLookupKey(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
	return `sha256:${toHex(new Uint8Array(digest))}`;
}

export function previewGatewayApiKey(value: string): string {
	if (!value) return 'sk-…';
	if (value.length <= 12) return `${value.slice(0, 4)}…`;
	return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export function resolveGatewayApiKeyPreview(storedKey: string, storedPreview?: string | null): string {
	const preview = storedPreview?.trim();
	if (preview) return preview;
	if (storedKey.startsWith(GATEWAY_KEY_STORAGE_PREFIX) || storedKey.startsWith('sha256:')) {
		return 'sk-…';
	}
	return previewGatewayApiKey(storedKey);
}

export async function prepareGatewayApiKeyForStorage(secretKey: string): Promise<{
	keyHash: string;
	keyPreview: string;
	storageKey: string;
}> {
	const keyHash = await hashLookupKey(secretKey);
	return {
		keyHash,
		keyPreview: previewGatewayApiKey(secretKey),
		// `api_keys.key` is legacy NOT NULL + UNIQUE across all supported databases.
		// Keep that constraint without persisting the bearer secret.
		storageKey: `${GATEWAY_KEY_STORAGE_PREFIX}${keyHash}`,
	};
}
