/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { hashLookupKey, type GatewayRepositories } from "@octafuse/core";
import { keyId } from "./gateway-key-contract";

export class SimulatorKeyVerificationError extends Error {
	constructor(
		public readonly status: 400 | 404 | 422 | 503,
		public readonly code: string
	) {
		super("Gateway Key binding could not be verified");
	}
}

/** Only an immutable resource ID is accepted; a secret must never be placed in this URL. */
export function simulatorKeyId(value: unknown): string {
	try {
		const id = keyId(value);
		if (
			id.startsWith("sk-") ||
			id.startsWith("hashref:") ||
			id.startsWith("sha256:")
		)
			throw new Error();
		return id;
	} catch {
		throw new SimulatorKeyVerificationError(
			400,
			"invalid_simulator_key_binding"
		);
	}
}

function readSecret(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new SimulatorKeyVerificationError(
			400,
			"invalid_simulator_key_binding"
		);
	const body = value as Record<string, unknown>;
	const secret = body.secret;
	if (
		Object.keys(body).length !== 1 ||
		typeof secret !== "string" ||
		secret.length > 4096 ||
		!/^sk-[A-Za-z0-9_-]+$/u.test(secret)
	)
		throw new SimulatorKeyVerificationError(
			400,
			"invalid_simulator_key_binding"
		);
	return secret;
}

/** Identity comparison only: no authentication, rotation, plaintext recovery or legacy writeback. */
export async function verifySimulatorKeyBinding(
	repos: Pick<GatewayRepositories, "apiKeys">,
	idInput: unknown,
	input: unknown
) {
	const id = simulatorKeyId(idInput);
	const secret = readSecret(input);
	const row = await repos.apiKeys.getApiKeyById(id);
	if (!row)
		throw new SimulatorKeyVerificationError(404, "simulator_key_not_found");
	if (
		row.id !== id ||
		!row.user_id ||
		!row.workspace_id ||
		typeof row.key !== "string"
	)
		throw new SimulatorKeyVerificationError(
			503,
			"simulator_key_binding_unavailable"
		);
	let expected: string;
	if (row.key.startsWith("hashref:"))
		expected = row.key.slice("hashref:".length);
	else if (row.key.startsWith("sha256:")) expected = row.key;
	else expected = await hashLookupKey(row.key);
	if (!/^sha256:[a-f0-9]{64}$/u.test(expected))
		throw new SimulatorKeyVerificationError(
			503,
			"simulator_key_binding_unavailable"
		);
	const actual = await hashLookupKey(secret);
	let difference = actual.length ^ expected.length;
	for (let index = 0; index < Math.max(actual.length, expected.length); index++)
		difference |=
			(actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
	if (difference !== 0)
		throw new SimulatorKeyVerificationError(422, "simulator_key_mismatch");
	return {
		id,
		user_id: row.user_id,
		workspace_id: row.workspace_id,
		verified: true as const,
	};
}
