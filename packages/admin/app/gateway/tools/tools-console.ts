/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createCinaTokenApi } from "@cinatoken/web/src/cinatoken/api";

export type ToolsConsoleIdentity = { userId: string; subject: string };

export type ToolsConsoleState =
	| { state: "checking" | "unverified" }
	| {
			state: "ready";
			subject: string;
			scopeKey: string;
			reconciliationKey: string;
	  };

/** The browser cannot infer a Console identity from a locally valid cookie. */
export function toolsConsoleReader(request: typeof fetch = fetch) {
	const api = createCinaTokenApi(request);
	return async (signal: AbortSignal): Promise<ToolsConsoleIdentity> => {
		const [result, me] = await Promise.all([
			api.authCheck({ signal }),
			api.me({ signal }),
		]);
		signal.throwIfAborted();
		if (
			!result.authenticated ||
			result.verification !== "verified" ||
			result.principalType !== "console" ||
			!result.subject ||
			result.subject.length > 600 ||
			me.subject !== result.subject ||
			result.subject.trim() !== result.subject ||
			/[\p{Cc}\p{Cf}]/u.test(result.subject)
		)
			throw new Error("Tools Console identity unavailable");
		return { userId: me.userId, subject: result.subject };
	};
}

/** Rechecks discard the mounted editor before a response can establish a new scope. */
export function createToolsConsoleSession(
	read: (signal: AbortSignal) => Promise<ToolsConsoleIdentity>,
	publish: (state: ToolsConsoleState) => void
) {
	let epoch = 0;
	let disposed = false;
	let controller: AbortController | null = null;
	function invalidate(state: "checking" | "unverified" = "unverified") {
		++epoch;
		controller?.abort();
		controller = null;
		if (!disposed) publish({ state });
	}
	return {
		invalidate,
		async revalidate(): Promise<void> {
			if (disposed) return;
			invalidate("checking");
			const generation = epoch;
			const abort = new AbortController();
			controller = abort;
			try {
				const { userId, subject } = await read(abort.signal);
				if (disposed || abort.signal.aborted || generation !== epoch) return;
				publish({
					state: "ready",
					subject,
					scopeKey: JSON.stringify([userId, subject, generation]),
					// The shared Web Console uses exactly [portal userId, subject, epoch].
					// Its normalizer removes epoch so an unknown write stays locked when
					// this tab switches between legacy Next and the Web entry.
					reconciliationKey: JSON.stringify([userId, subject, generation]),
				});
			} catch {
				if (!disposed && !abort.signal.aborted && generation === epoch)
					publish({ state: "unverified" });
			} finally {
				if (controller === abort) controller = null;
			}
		},
		dispose() {
			invalidate();
			disposed = true;
		},
	};
}
