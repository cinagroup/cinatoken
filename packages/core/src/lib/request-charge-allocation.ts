/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export type RequestChargeSource = {
	charged_cost: number;
	charged_wallet_cost?: number | null;
};
export type RequestChargeSplit =
	| { status: "known"; period: number; wallet: number }
	| { status: "missing" | "inconsistent" };

/** Avoid manufacturing a zero from missing data or sub-micro/unsafe amounts. */
function micros(value: number): number | null {
	const rounded = Math.round(value * 1_000_000);
	if (!Number.isSafeInteger(rounded) || value < 0) return null;
	if (rounded === 0 && value !== 0) return null;
	const tolerance = Math.min(
		1e-12,
		Number.EPSILON * Math.max(1, Math.abs(value)) * 4,
	);
	if (Math.abs(value - rounded / 1_000_000) > tolerance) return null;
	return rounded === 0 ? 0 : rounded;
}

/** Only display amounts representable by the recorded six-decimal money format. */
export function requestChargeAmount(
	value: number | undefined,
): number | undefined {
	if (value === undefined) return undefined;
	const checked = micros(value);
	if (checked === null) return undefined;
	const amount = checked / 1_000_000;
	return micros(amount) === checked ? amount : undefined;
}

/** The period share is a recorded charge allocation, not proof of a budget debit. */
export function requestChargeSplit(
	log: RequestChargeSource,
): RequestChargeSplit {
	if (log.charged_wallet_cost == null) return { status: "missing" };
	const total = micros(log.charged_cost);
	const wallet = micros(log.charged_wallet_cost);
	if (total === null || wallet === null || wallet > total)
		return { status: "inconsistent" };
	const periodAmount = (total - wallet) / 1_000_000;
	const walletAmount = wallet / 1_000_000;
	// A safe integer difference can still lose a micro-unit when converted back
	// to an IEEE-754 main-unit number. Do not present that as a known split.
	if (
		micros(periodAmount) !== total - wallet ||
		micros(walletAmount) !== wallet
	)
		return { status: "inconsistent" };
	return {
		status: "known",
		period: periodAmount,
		wallet: walletAmount,
	};
}
