"use client";

/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider, useTranslation } from "react-i18next";
import { AdminTools } from "@cinatoken/web/src/cinatoken/admin/tools/AdminTools";
import { createAdminToolsApi } from "@cinatoken/web/src/cinatoken/admin/tools/tools-api";
import { adminToolMessages } from "@cinatoken/web/src/cinatoken/admin/tools/messages";
import { UiPortalContainer } from "@cinatoken/web/src/components/ui/portal-container";
import { subscribeCinaAuthSessionChanges } from "@/lib/cinaauth/session-events";
import { ADMIN_SESSION_EXPIRED_EVENT_NAME } from "@/lib/admin-session-events";
import {
	createToolsConsoleSession,
	toolsConsoleReader,
	type ToolsConsoleState,
} from "./tools-console";
import "./tools-web-compat.generated.css";

const legacyToolsApi = createAdminToolsApi();

export default function LegacyToolsShell() {
	const requested = useLocale();
	const locale =
		requested in adminToolMessages
			? (requested as keyof typeof adminToolMessages)
			: "en";
	return <ToolsLocale key={locale} locale={locale} />;
}

function ToolsLocale({ locale }: { locale: keyof typeof adminToolMessages }) {
	const [i18n] = useState(() => {
		const instance = createInstance();
		void instance.init({
			lng: locale,
			fallbackLng: "en",
			initAsync: false,
			interpolation: { escapeValue: false },
			resources: Object.fromEntries(
				Object.entries(adminToolMessages).map(([language, tools]) => [
					language,
					{ translation: { cinatoken: { adminTools: tools } } },
				])
			),
		});
		return instance;
	});
	return (
		<I18nextProvider i18n={i18n}>
			<ToolsConsole />
		</I18nextProvider>
	);
}

function ToolsConsole() {
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
	return (
		<div
			ref={setHost}
			className="cinatoken-tools-host"
			data-cinatoken-tools-next-host
		>
			<UiPortalContainer value={host ?? undefined}>
				<QueryClientProvider client={client}>
					{status.state === "ready" ? (
						<AdminTools
							api={legacyToolsApi}
							scopeKey={status.scopeKey}
							reconciliationKey={status.reconciliationKey}
							consoleSubject={status.subject}
							canWrite
							revalidate={revalidate}
						/>
					) : (
						<div className="space-y-3" aria-busy={status.state === "checking"}>
							<p role={status.state === "checking" ? "status" : "alert"}>
								{t(
									"cinatoken.adminTools." +
										(status.state === "checking" ? "loading" : "accessDenied")
								)}
							</p>
							<button
								type="button"
								disabled={status.state === "checking"}
								onClick={() => void revalidate()}
								className="rounded-lg border px-3 py-2"
							>
								{t("cinatoken.adminTools.refresh")}
							</button>
						</div>
					)}
				</QueryClientProvider>
			</UiPortalContainer>
		</div>
	);
}
