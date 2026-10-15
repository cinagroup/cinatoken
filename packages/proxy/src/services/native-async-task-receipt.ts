import { assertSharedKeyEncryptionSecret } from '@octafuse/core';
import type { ApiKeyContext } from '../middleware/auth';

const DOMAIN = 'cinatoken.native-async-task-receipt.v1\n';
const MAX_TOKEN_BYTES = 8192;
export type NativeAsyncTaskReceipt = {
	v: 1;
	taskId: string;
	requestLogId: string;
	workspaceId: string;
	userId: string;
	apiKeyId: string;
	providerId: string;
	targetId: string;
	providerKeyId: string | null;
	modelId: string;
	routeGroup: string;
	budgetEpoch: number;
	reservedMicros: number;
	chargedCeiling: number;
	startMs: number;
	exp: number;
	/** The accepted asynchronous dispatch has already settled its unknown cost conservatively. */
	settledUpfront: true;
};
function encode(bytes: Uint8Array): string {
	let text = '';
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function decode(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid task receipt');
	const text = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4));
	return Uint8Array.from(text, (char) => char.charCodeAt(0));
}
async function key(secret: string | undefined): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(assertSharedKeyEncryptionSecret(secret)),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	);
}
function valid(value: unknown, now: number): value is NativeAsyncTaskReceipt {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const r = value as NativeAsyncTaskReceipt;
	return (
		r.v === 1 &&
		r.settledUpfront === true &&
		[
			'taskId',
			'requestLogId',
			'workspaceId',
			'userId',
			'apiKeyId',
			'providerId',
			'targetId',
			'modelId',
			'routeGroup',
		].every(
			(field) =>
				typeof r[field as keyof NativeAsyncTaskReceipt] === 'string' &&
				String(r[field as keyof NativeAsyncTaskReceipt]).length > 0 &&
				String(r[field as keyof NativeAsyncTaskReceipt]).length <= 600 &&
				!/[\u0000-\u001f\u007f]/u.test(String(r[field as keyof NativeAsyncTaskReceipt])),
		) &&
		(r.providerKeyId === null || (typeof r.providerKeyId === 'string' && r.providerKeyId.length <= 600)) &&
		[r.budgetEpoch, r.reservedMicros, r.startMs, r.exp].every((n) => Number.isSafeInteger(n) && n >= 0) &&
		Number.isFinite(r.chargedCeiling) &&
		r.chargedCeiling >= 0 &&
		r.startMs <= now + 60_000 &&
		r.exp > now &&
		r.exp <= r.startMs + 24 * 60 * 60 * 1000
	);
}
export async function signNativeAsyncTaskReceipt(
	receipt: NativeAsyncTaskReceipt,
	secret: string | undefined,
): Promise<string> {
	if (!valid(receipt, Date.now())) throw new Error('Invalid task receipt');
	const payload = encode(new TextEncoder().encode(JSON.stringify(receipt)));
	const signature = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(DOMAIN + payload));
	return payload + '.' + encode(new Uint8Array(signature));
}
export async function verifyNativeAsyncTaskReceipt(
	token: string | undefined,
	secret: string | undefined,
	owner: Pick<ApiKeyContext, 'workspaceId' | 'userId' | 'keyId'>,
	taskId: string,
	now = Date.now(),
): Promise<NativeAsyncTaskReceipt | null> {
	try {
		if (!token || token.length > MAX_TOKEN_BYTES) return null;
		const parts = token.split('.');
		if (parts.length !== 2) return null;
		const payload = decode(parts[0]!);
		const signature = decode(parts[1]!);
		if (
			signature.byteLength !== 32 ||
			!(await crypto.subtle.verify('HMAC', await key(secret), signature, new TextEncoder().encode(DOMAIN + parts[0]!)))
		)
			return null;
		const receipt: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload));
		if (
			!valid(receipt, now) ||
			receipt.taskId !== taskId ||
			receipt.workspaceId !== owner.workspaceId ||
			receipt.userId !== owner.userId ||
			receipt.apiKeyId !== owner.keyId
		)
			return null;
		return receipt;
	} catch {
		return null;
	}
}
