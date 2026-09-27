/** Ordering uses provider identity and weight; it never needs an upstream credential. */
export type RouteOrderCandidate = Readonly<{
	providerId: string;
	routeWeight: number;
}>;

export type RouteOrderContext = {
	/** userId|baseModelId|routeGroup|protocol — 不含 capability */
	affinityKey: string;
	/** baseModelId|routeGroup|protocol|priority — RR 用 */
	tierKey: string;
};

export type RouteOrderStrategy = <T extends RouteOrderCandidate>(routes: readonly T[], ctx: RouteOrderContext) => T[];
