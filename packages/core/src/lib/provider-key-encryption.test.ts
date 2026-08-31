import assert from "node:assert/strict";
import test from "node:test";
import {
	createEncryptedProvidersRepository,
	decryptProviderApiKeyReadOnly,
} from "./provider-key-encryption";
import { isEncryptedSharedKeySecret } from "./shared-key-encryption";
import type { ProvidersRepository } from "../storage/gateway-repository-interfaces";
import type { ProviderRow } from "../types";
import type { ProviderAdminRow } from "../storage/repository-dtos";

const SECRET = "test-only-shared-key-encryption-secret-32-bytes";

type StoredProvider = { id: string; name: string; api_key: string };

function makeRepository(initial: StoredProvider[]) {
	const store = new Map(initial.map((row) => [row.id, { ...row }]));
	const patches: Array<{ id: string; body: Record<string, unknown> }> = [];
	const repository = {
		patches,
		async listProviders(): Promise<ProviderAdminRow[]> {
			return [...store.values()].map((row) => ({ ...row } as ProviderAdminRow));
		},
		async getProvidersByIds(ids: string[]): Promise<ProviderRow[]> {
			return [...new Set(ids)].sort().flatMap((id) => {
				const row = store.get(id);
				return row ? [{ ...row } as unknown as ProviderRow] : [];
			});
		},
		async providerIdExists(id: string) {
			return store.has(id);
		},
		async insertProvider(params: {
			id: string;
			name: string;
			endpoints: string | null;
			description: unknown;
			apiKey?: string;
			status?: string;
			sharedChannelType?: string | null;
		}) {
			store.set(params.id, {
				id: params.id,
				name: params.name,
				api_key: params.apiKey ?? "",
			});
		},
		async updateProviderByPatch(id: string, body: Record<string, unknown>) {
			patches.push({ id, body: { ...body } });
			const row = store.get(id);
			if (!row) return 0;
			if (typeof body.api_key === "string") row.api_key = body.api_key;
			return 1;
		},
		async deleteProviderById(id: string) {
			return store.delete(id) ? 1 : 0;
		},
		async getProviderById(id: string): Promise<ProviderRow | null> {
			const row = store.get(id);
			return row ? ({ ...row } as unknown as ProviderRow) : null;
		},
		async getProviderRowById(id: string): Promise<ProviderAdminRow | null> {
			const row = store.get(id);
			return row ? ({ ...row } as ProviderAdminRow) : null;
		},
		async getProviderProtocolBases() {
			return null;
		},
		async getProviderApiKeyPlaintext(id: string) {
			const row = store.get(id);
			return row ? { api_key: row.api_key } : null;
		},
	} as unknown as ProvidersRepository & { patches: typeof patches };
	return { repository, store };
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

async function encryptLegacyProviderApiKey(
	providerId: string,
	plaintext: string
): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(SECRET)
	);
	const key = await crypto.subtle.importKey(
		"raw",
		digest,
		{ name: "AES-GCM" },
		false,
		["encrypt"]
	);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv,
			additionalData: new TextEncoder().encode(
				`cinatoken:provider-key:${providerId}`
			),
		},
		key,
		new TextEncoder().encode(plaintext)
	);
	return `enc:v1:${bytesToBase64(iv)}:${bytesToBase64(
		new Uint8Array(ciphertext)
	)}`;
}

test("read-only provider key helper returns plaintext exactly without a secret", async () => {
	const plaintext = "  sk-legacy-原样保留\n";
	assert.equal(
		await decryptProviderApiKeyReadOnly("plaintext-provider", plaintext, undefined),
		plaintext
	);
	assert.equal(
		await decryptProviderApiKeyReadOnly("empty-provider", "", undefined),
		""
	);
});

test("read-only provider key helper decrypts v2 with the provider purpose domain", async () => {
	const { repository, store } = makeRepository([]);
	const wrapped = createEncryptedProvidersRepository(repository, SECRET);
	await wrapped.insertProvider({
		id: "readonly-v2",
		name: "Read-only v2",
		endpoints: null,
		description: null,
		apiKey: "sk-readonly-v2",
	});
	const envelope = store.get("readonly-v2")?.api_key;
	assert.ok(envelope);

	assert.equal(
		await decryptProviderApiKeyReadOnly("readonly-v2", envelope, SECRET),
		"sk-readonly-v2"
	);
	await assert.rejects(
		decryptProviderApiKeyReadOnly("different-provider", envelope, SECRET),
		/Shared key decryption failed/
	);
	assert.equal(repository.patches.length, 0);
});

test("read-only provider key helper decrypts v1 without triggering an online upgrade", async () => {
	const envelope = await encryptLegacyProviderApiKey(
		"readonly-v1",
		"sk-readonly-v1"
	);
	const { repository, store } = makeRepository([
		{ id: "readonly-v1", name: "Read-only v1", api_key: envelope },
	]);

	assert.equal(
		await decryptProviderApiKeyReadOnly(
			"readonly-v1",
			store.get("readonly-v1")?.api_key ?? "",
			SECRET
		),
		"sk-readonly-v1"
	);
	assert.equal(repository.patches.length, 0);
	assert.equal(store.get("readonly-v1")?.api_key, envelope);
});

test("read-only provider key helper requires the encryption secret for envelopes", async () => {
	const { repository, store } = makeRepository([]);
	const wrapped = createEncryptedProvidersRepository(repository, SECRET);
	await wrapped.insertProvider({
		id: "readonly-secret-required",
		name: "Secret required",
		endpoints: null,
		description: null,
		apiKey: "sk-secret-required",
	});
	const envelope = store.get("readonly-secret-required")?.api_key;
	assert.ok(envelope);

	await assert.rejects(
		decryptProviderApiKeyReadOnly(
			"readonly-secret-required",
			envelope,
			undefined
		),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.equal(
				error.message,
				"SHARED_KEY_ENCRYPTION_SECRET must contain at least 32 characters"
			);
			assert.equal(error.message.includes(envelope), false);
			assert.equal(error.message.includes("sk-secret-required"), false);
			assert.equal(error.message.includes(SECRET), false);
			return true;
		}
	);
	assert.equal(repository.patches.length, 0);
});

test("audit M2: provider api keys encrypt on insert and decrypt at the boundary", async () => {
	const { repository, store } = makeRepository([]);
	const wrapped = createEncryptedProvidersRepository(repository, SECRET);

	await wrapped.insertProvider({
		id: "p1",
		name: "OpenAI",
		endpoints: null,
		description: null,
		apiKey: "sk-upstream-secret",
	});
	const stored = store.get("p1");
	assert.equal(isEncryptedSharedKeySecret(stored?.api_key ?? ""), true);
	assert.equal((stored?.api_key ?? "").includes("sk-upstream-secret"), false);

	const revealed = await wrapped.getProviderById("p1");
	assert.equal(revealed?.api_key, "sk-upstream-secret");
	// 存库内容保持密文（读取不回写明文）
	assert.equal(
		isEncryptedSharedKeySecret(store.get("p1")?.api_key ?? ""),
		true
	);
});

test("audit M2: legacy plaintext provider keys migrate in place on first read", async () => {
	const { repository, store } = makeRepository([
		{ id: "p2", name: "Anthropic", api_key: "sk-legacy-plain" },
	]);
	const wrapped = createEncryptedProvidersRepository(repository, SECRET);

	const revealed = await wrapped.getProviderApiKeyPlaintext("p2");
	assert.equal(revealed?.api_key, "sk-legacy-plain");
	assert.equal(
		isEncryptedSharedKeySecret(store.get("p2")?.api_key ?? ""),
		true
	);
});

test("audit M2: patch updates encrypt api_key in place", async () => {
	const { repository, store } = makeRepository([
		{ id: "p3", name: "Gemini", api_key: "" },
	]);
	const wrapped = createEncryptedProvidersRepository(repository, SECRET);

	await wrapped.updateProviderByPatch("p3", { api_key: "sk-new-key" });
	const stored = store.get("p3")?.api_key ?? "";
	assert.equal(isEncryptedSharedKeySecret(stored), true);
	assert.equal(stored.includes("sk-new-key"), false);
	const revealed = await wrapped.getProviderRowById("p3");
	assert.equal(revealed?.api_key, "sk-new-key");
});

test("audit M2: list reveals decrypt every row; empty keys pass through", async () => {
	const { repository } = makeRepository([
		{ id: "a", name: "A", api_key: "" },
		{ id: "b", name: "B", api_key: "sk-b" },
	]);
	const wrapped = createEncryptedProvidersRepository(repository, SECRET);
	const rows = await wrapped.listProviders();
	assert.deepEqual(
		rows.map((row) => row.api_key),
		["", "sk-b"]
	);
});

test("audit M2: bounded provider batch reads decrypt rows and cap online key upgrades", async () => {
	const { repository, store } = makeRepository([
		{ id: "legacy", name: "Legacy", api_key: "sk-legacy-batch" },
		...Array.from({ length: 7 }, (_, index) => ({
			id: `legacy-${index}`,
			name: `Legacy ${index}`,
			api_key: `sk-legacy-batch-${index}`,
		})),
	]);
	const wrapped = createEncryptedProvidersRepository(repository, SECRET);
	await wrapped.insertProvider({
		id: "modern",
		name: "Modern",
		endpoints: null,
		description: null,
		apiKey: "sk-modern-batch",
	});

	const rows = await wrapped.getProvidersByIds([
		"modern",
		"missing",
		"legacy",
		...Array.from({ length: 7 }, (_, index) => `legacy-${index}`),
	]);
	assert.equal(rows.length, 9);
	assert.equal(rows.find((row) => row.id === "legacy")?.api_key, "sk-legacy-batch");
	assert.equal(rows.find((row) => row.id === "modern")?.api_key, "sk-modern-batch");
	assert.equal(repository.patches.length, 4);
	assert.equal(
		isEncryptedSharedKeySecret(store.get("legacy")?.api_key ?? ""),
		true
	);
	assert.equal(
		[...store.values()].filter((row) =>
			isEncryptedSharedKeySecret(row.api_key)
		).length,
		5,
		"the modern row plus at most four legacy rows are encrypted in one batch"
	);
	assert.equal(
		isEncryptedSharedKeySecret(store.get("modern")?.api_key ?? ""),
		true
	);
});
