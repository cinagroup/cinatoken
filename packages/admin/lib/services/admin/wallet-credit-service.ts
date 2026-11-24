import type { GatewayRepositories } from "@octafuse/core";
import { isWalletCreditKind } from "@octafuse/core";
import {
	assertWalletCreditParams,
	assertWalletCreditReference,
	WalletCreditValidationError,
	WalletCreditConflictError,
	WalletCreditLegacyUnverifiedError,
	WalletCreditConcurrentMutationError,
	WalletCreditUserNotFoundError,
} from "@octafuse/core/db/wallet-credit";
import {
	grantWalletCredit,
	readWalletCreditReceipt,
} from "@octafuse/core/services/user-service";
import { badRequest, conflict, notFound } from "./errors";

export function normalizeAdminWalletCreditInput(
	input: unknown,
	verified = false,
) {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw badRequest("Expected a wallet credit object");
	const value = input as Record<string, unknown>;
	if (
		verified &&
		Object.keys(value).some(
			(key) =>
				![
					"amount",
					"kind",
					"external_ref",
					"reason",
					"require_receipt_version",
				].includes(key),
		)
	)
		throw badRequest("Unexpected wallet credit field");
	if (
		(verified || value.require_receipt_version !== undefined) &&
		value.require_receipt_version !== 1
	)
		throw badRequest("require_receipt_version must be 1");
	if (typeof value.amount !== "number")
		throw badRequest("amount must be a number");
	const kind = typeof value.kind === "string" ? value.kind.trim() : "";
	if (!isWalletCreditKind(kind)) throw badRequest("Invalid wallet credit kind");
	let externalRef =
		typeof value.external_ref === "string" ? value.external_ref : "";
	if (!verified) externalRef = externalRef.trim();
	if (
		value.reason !== undefined &&
		value.reason !== null &&
		typeof value.reason !== "string"
	)
		throw badRequest("reason must be a string");
	const reason =
		typeof value.reason === "string" ? value.reason.trim() : undefined;
	if (reason && (reason.length > 2000 || /[\p{Cc}\p{Cf}]/u.test(reason)))
		throw badRequest("Invalid wallet credit reason");
	try {
		assertWalletCreditParams({
			userId: "validated-by-resolver",
			externalRef,
			amount: value.amount,
			kind,
		});
	} catch (error) {
		throw mapWalletCreditError(error);
	}
	return { amount: value.amount, kind, externalRef, reason };
}

export function mapWalletCreditError(error: unknown): unknown {
	if (error instanceof WalletCreditValidationError)
		return badRequest(error.message);
	if (error instanceof WalletCreditUserNotFoundError)
		return notFound("User not found");
	if (
		error instanceof WalletCreditConflictError ||
		error instanceof WalletCreditLegacyUnverifiedError ||
		error instanceof WalletCreditConcurrentMutationError
	)
		return conflict(error.message);
	return error;
}

type WalletCreditDependencies = {
	grant: typeof grantWalletCredit;
	read: typeof readWalletCreditReceipt;
};
const defaults: WalletCreditDependencies = {
	grant: grantWalletCredit,
	read: readWalletCreditReceipt,
};
export async function applyAdminWalletCredit(
	repos: GatewayRepositories,
	userId: string,
	input: unknown,
	actorId: string,
	verified = false,
	deps = defaults,
) {
	const normalized = normalizeAdminWalletCreditInput(input, verified);
	try {
		return await deps.grant(repos, {
			userId,
			...normalized,
			actorType: "admin",
			actorId,
			source: "admin_wallet",
		});
	} catch (error) {
		throw mapWalletCreditError(error);
	}
}
export async function readAdminWalletCredit(
	repos: GatewayRepositories,
	userId: string,
	externalRef: unknown,
	deps = defaults,
) {
	try {
		assertWalletCreditReference(externalRef);
		return await deps.read(repos, { userId, externalRef });
	} catch (error) {
		throw mapWalletCreditError(error);
	}
}
