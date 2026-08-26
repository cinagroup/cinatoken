/**
 * providers.api_key 的信封加密包装器（审计 M2 第一阶段）。
 *
 * 上游供应商密钥此前明文存库 —— 库泄露即同时泄露全部 OpenAI/Anthropic/…
 * 凭据（比已加密的共享市场密钥更糟）。复用 shared-key-encryption 的
 * AES-GCM 信封（v2 = HKDF 派生，AAD 绑定 provider id）：
 *  - 新写入/补丁更新一律封为 `enc:v2:`；
 *  - 读取在仓库边界解密，调用方（推理路由 / 管理 reveal）无感知；
 *  - 明文旧行首次读取即地加密（与共享密钥同款在线迁移）。
 * env 沿用 SHARED_KEY_ENCRYPTION_SECRET（同一 KEK 材料，v2 的 HKDF
 * salt/info 将其与共享密钥用途域分离）。
 */
import type { ProvidersRepository } from '../storage/gateway-repository-interfaces';
import {
	assertSharedKeyEncryptionSecret,
	encryptSharedKeySecret,
	decryptSharedKeySecret,
	isEncryptedSharedKeySecret,
	isLegacyV1Envelope,
} from './shared-key-encryption';

type ProviderRowLike = { id: string; api_key?: string | null };
type PatchBody = Record<string, unknown>;

function providerContext(providerId: string): string {
	return `cinatoken:provider-key:${providerId}`;
}

/** 补丁白名单只认 snake_case（PROVIDER_PATCH_COLS）；apiKey 拼写本就会被实现丢弃。 */
function patchSecretValue(body: PatchBody): string | null {
	const value = body.api_key;
	return typeof value === 'string' && value.length > 0 ? value : null;
}

export function createEncryptedProvidersRepository(
	repository: ProvidersRepository,
	secret: string,
): ProvidersRepository {
	assertSharedKeyEncryptionSecret(secret);

	const reveal = async <T extends ProviderRowLike>(row: T | null): Promise<T | null> => {
		if (!row) return null;
		const stored = row.api_key;
		if (!stored) return row;
		const context = providerContext(row.id);
		if (!isEncryptedSharedKeySecret(stored)) {
			// 明文旧行：首次读取即地加密
			const encrypted = await encryptSharedKeySecret(stored, secret, context);
			await repository.updateProviderByPatch(row.id, { api_key: encrypted });
			return row;
		}
		const plaintext = await decryptSharedKeySecret(stored, secret, context);
		if (isLegacyV1Envelope(stored) && repository.updateProviderByPatch) {
			const upgraded = await encryptSharedKeySecret(plaintext, secret, context);
			await repository.updateProviderByPatch(row.id, { api_key: upgraded });
		}
		return { ...row, api_key: plaintext };
	};

	const revealMany = async <T extends ProviderRowLike>(rows: T[]): Promise<T[]> =>
		Promise.all(rows.map((row) => reveal(row) as Promise<T>));

	return {
		...repository,
		async insertProvider(params) {
			const apiKey = params.apiKey;
			if (typeof apiKey === 'string' && apiKey.length > 0) {
				await repository.insertProvider({
					...params,
					apiKey: await encryptSharedKeySecret(apiKey, secret, providerContext(params.id)),
				});
				return;
			}
			await repository.insertProvider(params);
		},
		async updateProviderByPatch(id, body) {
			const secretValue = patchSecretValue(body);
			if (secretValue === null) return repository.updateProviderByPatch(id, body);
			const patched = { ...body, api_key: await encryptSharedKeySecret(secretValue, secret, providerContext(id)) };
			return repository.updateProviderByPatch(id, patched);
		},
		async listProviders() {
			return revealMany(await repository.listProviders());
		},
		async getProviderById(id) {
			return reveal(await repository.getProviderById(id));
		},
		async getProviderRowById(id) {
			return reveal(await repository.getProviderRowById(id));
		},
		async getProviderApiKeyPlaintext(providerId) {
			const row = await repository.getProviderApiKeyPlaintext(providerId);
			const revealed = await reveal(row ? { id: providerId, api_key: row.api_key } : null);
			if (!revealed?.api_key) return null;
			return { api_key: revealed.api_key };
		},
	};
}
