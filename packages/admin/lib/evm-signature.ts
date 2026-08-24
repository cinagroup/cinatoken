import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

export type EvmAddress = `0x${string}`;

const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string): Uint8Array {
	if (value.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(value)) {
		throw new Error('Invalid hexadecimal value');
	}
	return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

/** Return the EIP-55 checksum form and reject invalid mixed-case checksums. */
export function normalizeEvmAddress(value: string): EvmAddress {
	if (!/^0x[0-9a-f]{40}$/iu.test(value)) throw new Error('Invalid EVM address');
	const lowercase = value.slice(2).toLowerCase();
	const hash = bytesToHex(keccak_256(encoder.encode(lowercase)));
	let checksummed = '';
	for (let index = 0; index < lowercase.length; index += 1) {
		const character = lowercase[index];
		checksummed += Number.parseInt(hash[index], 16) >= 8 ? character.toUpperCase() : character;
	}
	const normalized = `0x${checksummed}` as EvmAddress;
	const body = value.slice(2);
	if (body !== body.toLowerCase() && body !== body.toUpperCase() && value !== normalized) {
		throw new Error('Invalid EIP-55 checksum');
	}
	return normalized;
}

function ethereumMessageHash(message: string): Uint8Array {
	const body = encoder.encode(message);
	const prefix = encoder.encode(`\u0019Ethereum Signed Message:\n${body.length}`);
	const bytes = new Uint8Array(prefix.length + body.length);
	bytes.set(prefix);
	bytes.set(body, prefix.length);
	return keccak_256(bytes);
}

function compactSignature(signature: string): { compact: Uint8Array; recovery: number } {
	if (!/^0x[0-9a-f]+$/iu.test(signature)) throw new Error('Invalid EVM signature');
	const bytes = hexToBytes(signature.slice(2));
	if (bytes.length === 65) {
		const recovery = bytes[64] >= 27 ? bytes[64] - 27 : bytes[64];
		if (recovery !== 0 && recovery !== 1) throw new Error('Invalid recovery bit');
		return { compact: bytes.slice(0, 64), recovery };
	}
	if (bytes.length === 64) {
		const recovery = bytes[32] >> 7;
		const compact = bytes.slice();
		compact[32] &= 0x7f;
		return { compact, recovery };
	}
	throw new Error('Invalid EVM signature length');
}

/** Verify an EOA personal_sign signature without loading a full chain client. */
export function verifyEvmMessage(input: {
	address: string;
	message: string;
	signature: string;
}): boolean {
	try {
		const expected = normalizeEvmAddress(input.address);
		const { compact, recovery } = compactSignature(input.signature);
		const publicKey = secp256k1.Signature.fromCompact(compact)
			.addRecoveryBit(recovery)
			.recoverPublicKey(ethereumMessageHash(input.message))
			.toRawBytes(false);
		const recovered = normalizeEvmAddress(`0x${bytesToHex(keccak_256(publicKey.slice(1)).slice(-20))}`);
		return recovered === expected;
	} catch {
		return false;
	}
}
