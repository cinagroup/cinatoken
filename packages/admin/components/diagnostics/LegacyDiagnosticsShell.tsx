"use client";

/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider, useTranslation } from "react-i18next";
import { PlaygroundScreen } from "@cinatoken/web/src/cinatoken/admin/playground/PlaygroundScreen";
import { playgroundMessages } from "@cinatoken/web/src/cinatoken/admin/playground/playground-messages";
import { validatePlaygroundSearch } from "@cinatoken/web/src/cinatoken/admin/playground/playground-contracts";
import { SimulatorScreen } from "@cinatoken/web/src/cinatoken/admin/simulator/SimulatorScreen";
import { adminSimulatorMessages } from "@cinatoken/web/src/cinatoken/admin/simulator/simulator-messages";
import { validateSimulatorSearch } from "@cinatoken/web/src/cinatoken/admin/simulator/simulator-search";
import { UiPortalContainer } from "@cinatoken/web/src/components/ui/portal-container";
import { subscribeCinaAuthSessionChanges } from "@/lib/cinaauth/session-events";
import { ADMIN_SESSION_EXPIRED_EVENT_NAME } from "@/lib/admin-session-events";
import {
	createToolsConsoleSession,
	toolsConsoleReader,
	type ToolsConsoleState,
} from "@/app/gateway/tools/tools-console";
import "@/app/gateway/tools/tools-web-compat.generated.css";

const bridgeMessages = {
	en: {
		checking: "Verifying console access…",
		unverified: "Console access could not be verified.",
		retry: "Retry",
	},
	zh: {
		checking: "正在验证控制台权限…",
		unverified: "暂时无法验证控制台权限。",
		retry: "重试",
	},
	ja: {
		checking: "コンソール権限を確認中…",
		unverified: "コンソール権限を確認できません。",
		retry: "再試行",
	},
	ko: {
		checking: "콘솔 권한 확인 중…",
		unverified: "콘솔 권한을 확인할 수 없습니다.",
		retry: "다시 시도",
	},
};
type Feature = "playground" | "simulator";

/** Legacy URLs use exactly the same browser screen and transport as the Web entry. */
export default function LegacyDiagnosticsShell(props: { feature: Feature }) {
	const requested = useLocale();
	const locale =
		requested in bridgeMessages
			? (requested as keyof typeof bridgeMessages)
			: "en";
	return (
		<DiagnosticsLocale
			key={locale + props.feature}
			locale={locale}
			feature={props.feature}
		/>
	);
}

function DiagnosticsLocale(props: {
	locale: keyof typeof bridgeMessages;
	feature: Feature;
}) {
	const [i18n] = useState(() => {
		const instance = createInstance();
		void instance.init({
			lng: props.locale,
			fallbackLng: "en",
			initAsync: false,
			interpolation: { escapeValue: false },
			resources: Object.fromEntries(
				Object.entries(bridgeMessages).map(([locale, bridge]) => [
					locale,
					{
						translation: {
							cinatoken: {
								bridge,
								admin: {
									playground:
										playgroundMessages[
											locale as keyof typeof playgroundMessages
										],
								},
								adminSimulator:
									adminSimulatorMessages[
										locale as keyof typeof adminSimulatorMessages
									],
							},
						},
					},
				])
			),
		});
		return instance;
	});
	return (
		<I18nextProvider i18n={i18n}>
			<DiagnosticsConsole feature={props.feature} />
		</I18nextProvider>
	);
}

function DiagnosticsConsole(props: { feature: Feature }) {
	const { t } = useTranslation();
	const [client] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false },
					mutations: { retry: false, gcTime: 0 },
				},
			})
	);
	const [status, setStatus] = useState<ToolsConsoleState>({
		state: "checking",
	});
	const [host, setHost] = useState<HTMLDivElement | null>(null);
	const [search, setSearch] = useState(() =>
		Object.fromEntries(
			new URLSearchParams(
				typeof window === "undefined" ? "" : window.location.search
			)
		)
	);
	const sessionRef = useRef<ReturnType<
		typeof createToolsConsoleSession
	> | null>(null);
	const revalidate = useCallback(
		() => sessionRef.current?.revalidate() ?? Promise.resolve(),
		[]
	);
	useEffect(() => {
		const session = createToolsConsoleSession(toolsConsoleReader(), (value) => {
			client.clear();
			setStatus(value);
		});
		sessionRef.current = session;
		void session.revalidate();
		const check = () => {
			void session.revalidate();
		};
		const expire = () => session.invalidate();
		const visibility = () =>
			document.visibilityState === "hidden" ? expire() : check();
		const unsubscribe = subscribeCinaAuthSessionChanges(check);
		window.addEventListener("focus", check);
		window.addEventListener("pagehide", expire);
		window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT_NAME, expire);
		document.addEventListener("visibilitychange", visibility);
		return () => {
			unsubscribe();
			window.removeEventListener("focus", check);
			window.removeEventListener("pagehide", expire);
			window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT_NAME, expire);
			document.removeEventListener("visibilitychange", visibility);
			session.dispose();
			if (sessionRef.current === session) sessionRef.current = null;
			client.clear();
		};
	}, [client]);
	const updateSearch = (value: ReturnType<typeof validatePlaygroundSearch>) => {
		const next = new URL(window.location.href);
		for (const name of ["mode", "routeId", "tool", "provider"])
			next.searchParams.delete(name);
		for (const [name, entry] of Object.entries(value))
			if (entry) next.searchParams.set(name, entry);
		window.history.replaceState(window.history.state, "", next);
		setSearch(Object.fromEntries(next.searchParams));
	};
	return (
		<div
			ref={setHost}
			className="cinatoken-tools-host"
			data-cinatoken-diagnostics-next-host={props.feature}
		>
			<UiPortalContainer value={host ?? undefined}>
				<QueryClientProvider client={client}>
					{status.state === "ready" ? (
						<ReadyScreen
							feature={props.feature}
							status={status}
							search={search}
							updateSearch={updateSearch}
							revalidate={revalidate}
						/>
					) : (
						<div className="space-y-3" aria-busy={status.state === "checking"}>
							<p role={status.state === "checking" ? "status" : "alert"}>
								{t(
									"cinatoken.bridge." +
										(status.state === "checking" ? "checking" : "unverified")
								)}
							</p>
							<button
								type="button"
								disabled={status.state === "checking"}
								onClick={() => void revalidate()}
								className="rounded-lg border px-3 py-2"
							>
								{t("cinatoken.bridge.retry")}
							</button>
						</div>
					)}
				</QueryClientProvider>
			</UiPortalContainer>
		</div>
	);
}

function ReadyScreen(props: {
	feature: Feature;
	status: Extract<ToolsConsoleState, { state: "ready" }>;
	search: Record<string, string>;
	updateSearch: (value: ReturnType<typeof validatePlaygroundSearch>) => void;
	revalidate: () => Promise<void>;
}) {
	const session = {
		scopeKey: props.status.scopeKey,
		reconciliationKey: props.status.reconciliationKey,
		subject: props.status.subject,
		enabled: true,
		revalidate: props.revalidate,
	};
	if (props.feature === "playground")
		return (
			<PlaygroundScreen
				key={session.scopeKey}
				session={session}
				search={validatePlaygroundSearch(props.search)}
				onSearchChange={props.updateSearch}
			/>
		);
	return (
		<SimulatorScreen
			key={session.scopeKey}
			session={session}
			search={validateSimulatorSearch(props.search)}
		/>
	);
}
