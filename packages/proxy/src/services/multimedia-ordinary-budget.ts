export type MultimediaChargedCostEstimate = {
	chargedCost: number;
	pricingAuditJson: string;
};

export type ConservativeMultimediaBudgetEstimate<T extends MultimediaChargedCostEstimate> = {
	estimate: T;
	/** Null means at least one eligible route has no provable finite charged ceiling. */
	estimatedChargedCost: number | null;
};

export function multimediaEstimateHasProvablePricing(
	estimate: MultimediaChargedCostEstimate,
): boolean {
	if (!Number.isFinite(estimate.chargedCost) || estimate.chargedCost < 0) return false;
	try {
		const audit = JSON.parse(estimate.pricingAuditJson) as unknown;
		return audit != null
			&& typeof audit === 'object'
			&& !Array.isArray(audit)
			&& !Object.hasOwn(audit, 'error');
	} catch {
		return false;
	}
}

/**
 * Select the highest existing route precheck while retaining whether every
 * eligible route proved a finite ceiling. An audited zero is explicitly free;
 * a zero carrying a pricing error is unknown and must fail closed for finite budgets.
 */
export function selectConservativeMultimediaBudgetEstimate<
	T extends MultimediaChargedCostEstimate,
>(estimates: readonly T[]): ConservativeMultimediaBudgetEstimate<T> | null {
	if (estimates.length === 0) return null;
	let estimate = estimates[0]!;
	let allProvable = multimediaEstimateHasProvablePricing(estimate);
	for (const candidate of estimates.slice(1)) {
		if (candidate.chargedCost >= estimate.chargedCost) estimate = candidate;
		allProvable &&= multimediaEstimateHasProvablePricing(candidate);
	}
	return {
		estimate,
		estimatedChargedCost: allProvable ? estimate.chargedCost : null,
	};
}

/** Guardrail is marked first so its failure leaves the ordinary lease releasable. */
export async function markMultimediaBudgetsBeforeDispatch(params: {
	markGuardrail(): Promise<void>;
	markOrdinary(): Promise<void>;
	terminateOrdinary(): Promise<void>;
	terminateGuardrail(): Promise<void>;
}): Promise<void> {
	try {
		await params.markGuardrail();
		await params.markOrdinary();
	} catch (error) {
		await params.terminateOrdinary().catch(() => undefined);
		await params.terminateGuardrail().catch(() => undefined);
		throw error;
	}
}
