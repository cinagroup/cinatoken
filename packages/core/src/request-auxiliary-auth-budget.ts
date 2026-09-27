/** Local safety ceiling, separate from inference permits and monetary budgets. */
export const MAX_REQUEST_AUXILIARY_AUTH_EXCHANGES = 3;

export type RequestAuxiliaryAuthBudgetSnapshot = Readonly<{
	limit: number;
	exchangesStarted: number;
}>;

export class RequestAuxiliaryAuthLimitError extends Error {
	constructor() {
		super('Request auxiliary authentication limit reached');
		this.name = 'RequestAuxiliaryAuthLimitError';
	}
}

export interface RequestAuxiliaryAuthBudget {
	assertAvailable(): void;
	/** Synchronous claim immediately before auth fetch; failures are not refunded. */
	consume(): void;
	snapshot(): RequestAuxiliaryAuthBudgetSnapshot;
}

/** Create at request ingress and pass through every model/credential fallback. */
export function createRequestAuxiliaryAuthBudget(
	limit = MAX_REQUEST_AUXILIARY_AUTH_EXCHANGES,
): RequestAuxiliaryAuthBudget {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REQUEST_AUXILIARY_AUTH_EXCHANGES) {
		throw new RangeError(`Auxiliary auth limit must be an integer between 1 and ${MAX_REQUEST_AUXILIARY_AUTH_EXCHANGES}`);
	}
	let exchangesStarted = 0;
	const assertAvailable = (): void => {
		if (exchangesStarted >= limit) throw new RequestAuxiliaryAuthLimitError();
	};
	return Object.freeze({
		assertAvailable,
		consume(): void { assertAvailable(); exchangesStarted += 1; },
		snapshot: (): RequestAuxiliaryAuthBudgetSnapshot => Object.freeze({ limit, exchangesStarted }),
	});
}
