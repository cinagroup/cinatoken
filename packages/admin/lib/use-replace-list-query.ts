"use client";

import type { DependencyList } from "react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";

const subscribeBrowserReady = () => () => {};
const browserReadySnapshot = () => true;
const serverReadySnapshot = () => false;

/** URL-backed form state is initialized once after the server hydration snapshot. */
export function useListPageBrowserReady() {
	return useSyncExternalStore(
		subscribeBrowserReady,
		browserReadySnapshot,
		serverReadySnapshot
	);
}

/**
 * 列表页筛选变更时把当前条件写回 URL（`router.replace`，无滚动）。
 * 首次提交只记录查询值；相同值及 Strict Mode effect 重放均不覆盖深链。
 */
export function useReplaceListPageQuery(
	buildParams: () => URLSearchParams,
	_deps: DependencyList
) {
	const router = useRouter();
	const pathname = usePathname();
	const previousQuery = useRef<{ pathname: string; query: string } | null>(
		null
	);
	// Existing callers retain their signature; the serialized query is the complete
	// value dependency, so callback identity and unrelated renders cannot rewrite it.
	const query = buildParams().toString();

	useEffect(() => {
		const previous = previousQuery.current;
		if (previous == null) {
			previousQuery.current = { pathname, query };
			return;
		}
		if (previous.pathname === pathname && previous.query === query) return;
		previousQuery.current = { pathname, query };
		router.replace(query ? `${pathname}?${query}` : pathname, {
			scroll: false,
		});
	}, [pathname, router, query]);
}
