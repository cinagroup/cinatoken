"use client";

/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider, useTranslation } from "react-i18next";
import { AdminPolicyWorkbench } from "@cinatoken/web/src/cinatoken/admin/policy-workbench/AdminPolicyWorkbench";
import {
	readPolicyWorkbenchSearch,
	serializePolicyWorkbenchSearch,
	type PolicyWorkbenchFeature,
} from "@cinatoken/web/src/cinatoken/admin/policy-workbench/policy-workbench-search";
import { adminDomainIdentity } from "@cinatoken/web/src/cinatoken/admin/domain-write-recovery";
import {
	policyWorkbenchLocales,
	policyWorkbenchMessages,
	type PolicyWorkbenchLocale,
} from "@cinatoken/web/src/cinatoken/admin/policy-workbench/policy-workbench-messages";
import type { DataPolicyFilters } from "@cinatoken/web/src/cinatoken/admin/data-policies/data-policy-search";
import { UiPortalContainer } from "@cinatoken/web/src/components/ui/portal-container";
import { subscribeCinaAuthSessionChanges } from "@/lib/cinaauth/session-events";
import { ADMIN_SESSION_EXPIRED_EVENT_NAME } from "@/lib/admin-session-events";
import {
	createToolsConsoleSession,
	toolsConsoleReader,
	type ToolsConsoleState,
} from "@/app/gateway/tools/tools-console";
import "@/app/gateway/tools/tools-web-compat.generated.css";

type Feature = PolicyWorkbenchFeature;

function currentSearch(): Record<string, unknown> {
	return readPolicyWorkbenchSearch(
		typeof window === "undefined" ? "" : window.location.search
	);
}

/** Legacy URLs use exactly the same browser screen and transport as the Web entry. */
export default function LegacyPolicyWorkbenchShell(props: {
	feature: Feature;
}) {
	const requested = useLocale();
	const locale = policyWorkbenchLocales.includes(
		requested as PolicyWorkbenchLocale
	)
		? (requested as PolicyWorkbenchLocale)
		: "en";
	return (
		<PolicyWorkbenchLocaleProvider
			key={locale + props.feature}
			locale={locale}
			feature={props.feature}
		/>
	);
}

function PolicyWorkbenchLocaleProvider(props: {
	locale: PolicyWorkbenchLocale;
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
				policyWorkbenchLocales.map((locale) => [
					locale,
					{ translation: policyWorkbenchMessages(locale) },
				])
			),
		});
		return instance;
	});
	return (
		<I18nextProvider i18n={i18n}>
			<PolicyWorkbenchConsole feature={props.feature} />
		</I18nextProvider>
	);
}

function PolicyWorkbenchConsole(props: { feature: Feature }) {
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
	const [search, setSearch] = useState(currentSearch);
	useEffect(() => {
		const update = () => setSearch(currentSearch());
		window.addEventListener("popstate", update);
		return () => window.removeEventListener("popstate", update);
	}, []);
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
	const updateSearch = (value: DataPolicyFilters) => {
		const next = new URL(window.location.href);
		next.search = serializePolicyWorkbenchSearch(value);
		window.history.replaceState(window.history.state, "", next);
		setSearch(currentSearch());
	};
	return (
		<div
			ref={setHost}
			className="cinatoken-tools-host"
			data-cinatoken-policy-next-host={props.feature}
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
	search: Record<string, unknown>;
	updateSearch: (value: DataPolicyFilters) => void;
	revalidate: () => Promise<void>;
}) {
	const { t } = useTranslation();
	const identity = adminDomainIdentity(props.status.reconciliationKey);
	if (!identity || identity.subject !== props.status.subject)
		return <p role="alert">{t("cinatoken.bridge.unverified")}</p>;
	const session = {
		scopeKey: props.status.scopeKey,
		reconciliationKey: props.status.reconciliationKey,
		subject: identity.subject,
		userId: identity.userId,
		canWrite: true,
		revalidate: props.revalidate,
	};
	return (
		<AdminPolicyWorkbench
			key={session.scopeKey}
			feature={props.feature}
			session={session}
			search={props.search}
			onSearchChange={props.updateSearch}
		/>
	);
}
