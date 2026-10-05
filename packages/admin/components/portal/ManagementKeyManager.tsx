"use client";

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useTransition,
} from "react";
import { useTranslations } from "next-intl";
import { usePortalWorkspace } from "@/components/portal/PortalWorkspaceContext";
import { readPortalJson } from "@/lib/portal-fetch";

type ManagementKeyRow = {
	id: string;
	label: string;
	name: string;
	status: "active" | "revoked";
	account_type: "personal" | "organization";
	expires_at: string | null;
	last_used_at: string | null;
	created_at: string;
};

export default function ManagementKeyManager() {
	const t = useTranslations("portal.managementKeys");
	const { context, isSwitching } = usePortalWorkspace();
	const [isMutating, startMutation] = useTransition();
	const workspaceId = context?.currentWorkspace.id ?? "";
	const role = context?.currentWorkspace.role ?? "member";
	if (!workspaceId || isSwitching)
		return (
			<div className="console-muted py-8 text-center text-sm">
				{t("loading")}
			</div>
		);
	return (
		<WorkspaceManagementKeys
			key={JSON.stringify([workspaceId, role])}
			isMutating={isMutating}
			startMutation={startMutation}
		/>
	);
}

function WorkspaceManagementKeys({
	isMutating,
	startMutation,
}: {
	isMutating: boolean;
	startMutation: ReturnType<typeof useTransition>[1];
}) {
	const t = useTranslations("portal.managementKeys");
	const { context, isSwitching } = usePortalWorkspace();
	const workspaceId = context?.currentWorkspace.id ?? "";
	const workspaceName = context?.currentWorkspace.name ?? "";
	const role = context?.currentWorkspace.role ?? "member";
	const canManage = role === "owner" || role === "admin";
	const scopeRef = useRef<AbortController | null>(null);
	const activeReadRef = useRef<AbortController | null>(null);
	const copyRequestRef = useRef<AbortController | null>(null);
	useEffect(() => {
		const scope = new AbortController();
		scopeRef.current = scope;
		const reads = activeReadRef;
		const copies = copyRequestRef;
		return () => {
			scope.abort();
			reads.current?.abort();
			copies.current?.abort();
		};
	}, []);
	const [rows, setRows] = useState<ManagementKeyRow[]>([]);
	const [name, setName] = useState("");
	const [expiresAt, setExpiresAt] = useState("");
	const [secret, setSecret] = useState("");
	const [copied, setCopied] = useState(false);
	const request = useMemo(
		() => ({ workspaceId, canManage, failureMessage: t("loadFailed") }),
		[canManage, t, workspaceId]
	);
	const [settledRequest, setSettledRequest] = useState<typeof request | null>(
		null
	);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const isLoading = canManage && (settledRequest !== request || isRefreshing);
	const [error, setError] = useState("");

	const load = useCallback(
		async (signal: AbortSignal) => {
			if (!workspaceId || !canManage) return null;
			try {
				const response = await fetch("/api/user/management-keys", {
					cache: "no-store",
					signal,
				});
				const result = await readPortalJson<ManagementKeyRow[]>(response);
				if (signal.aborted) return null;
				if (!response.ok || !result?.success) {
					return { rows: [], error: result?.message ?? request.failureMessage };
				}
				return { rows: result.data ?? [], error: "" };
			} catch (cause) {
				if (
					signal.aborted ||
					(cause instanceof DOMException && cause.name === "AbortError")
				) {
					return null;
				}
				return { rows: [], error: request.failureMessage };
			}
		},
		[canManage, request, workspaceId]
	);
	const applyLoad = useCallback(
		(outcome: Awaited<ReturnType<typeof load>>, signal: AbortSignal) => {
			if (!outcome || signal.aborted) return;
			setRows(outcome.rows);
			setError(outcome.error);
			setSettledRequest(request);
			setIsRefreshing(false);
		},
		[request]
	);

	useEffect(() => {
		const controller = new AbortController();
		activeReadRef.current = controller;
		void load(controller.signal).then((outcome) =>
			applyLoad(outcome, controller.signal)
		);
		const reads = activeReadRef;
		return () => {
			controller.abort();
			reads.current?.abort();
		};
	}, [applyLoad, load]);

	const refresh = async () => {
		if (!scopeRef.current || scopeRef.current.signal.aborted) return;
		activeReadRef.current?.abort();
		const controller = new AbortController();
		activeReadRef.current = controller;
		setIsRefreshing(true);
		applyLoad(await load(controller.signal), controller.signal);
	};

	const create = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const normalizedName = name.trim();
		const scope = scopeRef.current;
		if (
			!workspaceId ||
			!canManage ||
			isSwitching ||
			!normalizedName ||
			isMutating ||
			!scope ||
			scope.signal.aborted
		)
			return;
		copyRequestRef.current?.abort();
		setError("");
		setSecret("");
		setCopied(false);
		startMutation(async () => {
			try {
				const response = await fetch("/api/user/management-keys", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						name: normalizedName,
						expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
					}),
				});
				const result = await readPortalJson<ManagementKeyRow>(response);
				if (scope.signal.aborted) return;
				const returnedSecret = result?.key ?? "";
				if (!response.ok || !result?.success || !returnedSecret) {
					setError(result?.message ?? t("createFailed"));
					return;
				}
				setSecret(returnedSecret);
				setName("");
				setExpiresAt("");
				await refresh();
			} catch {
				if (scope.signal.aborted) return;
				setError(t("createFailed"));
			}
		});
	};

	const revoke = (row: ManagementKeyRow) => {
		const scope = scopeRef.current;
		if (
			!workspaceId ||
			!canManage ||
			isSwitching ||
			!scope ||
			scope.signal.aborted ||
			isMutating ||
			!window.confirm(t("confirmRevoke", { name: row.name || row.label }))
		) {
			return;
		}
		setError("");
		startMutation(async () => {
			try {
				const response = await fetch(
					`/api/user/management-keys/${encodeURIComponent(row.id)}`,
					{ method: "DELETE" }
				);
				if (scope.signal.aborted) return;
				if (!response.ok) {
					const result = await readPortalJson<never>(response);
					if (scope.signal.aborted) return;
					setError(result?.message ?? t("revokeFailed"));
					return;
				}
				copyRequestRef.current?.abort();
				setSecret("");
				setCopied(false);
				await refresh();
			} catch {
				if (scope.signal.aborted) return;
				setError(t("revokeFailed"));
			}
		});
	};

	const copySecret = async () => {
		const scope = scopeRef.current;
		if (!secret || !scope || scope.signal.aborted) return;
		copyRequestRef.current?.abort();
		const copy = new AbortController();
		copyRequestRef.current = copy;
		try {
			await navigator.clipboard.writeText(secret);
			if (!scope.signal.aborted && !copy.signal.aborted) setCopied(true);
		} catch {
			if (!scope.signal.aborted && !copy.signal.aborted) setCopied(false);
		}
	};

	return (
		<section
			className="console-panel space-y-5 rounded-xl border p-5"
			style={{ borderColor: "var(--console-border)" }}
		>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<h2 className="text-xl font-semibold">{t("title")}</h2>
					<p className="console-muted mt-1 text-sm">{t("subtitle")}</p>
				</div>
				<div className="console-badge self-start rounded-full px-2.5 py-1 text-xs">
					{t("workspaceScope", { name: workspaceName || workspaceId })}
				</div>
			</div>

			{canManage ? (
				<form
					onSubmit={create}
					className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(13rem,0.6fr)_auto]"
				>
					<label className="space-y-1">
						<span className="console-muted text-xs">{t("name")}</span>
						<input
							value={name}
							onChange={(event) => setName(event.target.value.slice(0, 128))}
							placeholder={t("namePlaceholder")}
							className="console-input w-full rounded-lg border px-3 py-2 text-sm"
							maxLength={128}
							required
						/>
					</label>
					<label className="space-y-1">
						<span className="console-muted text-xs">{t("expiresAt")}</span>
						<input
							type="datetime-local"
							value={expiresAt}
							onChange={(event) => setExpiresAt(event.target.value)}
							className="console-input w-full rounded-lg border px-3 py-2 text-sm"
						/>
					</label>
					<button
						type="submit"
						disabled={!workspaceId || isSwitching || isMutating || !name.trim()}
						className="self-end rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{isMutating ? t("creating") : t("create")}
					</button>
				</form>
			) : (
				<div className="console-muted rounded-lg border px-4 py-3 text-sm">
					{t("adminRequired")}
				</div>
			)}

			{secret ? (
				<div className="rounded-lg border border-amber-400/40 bg-amber-400/10 p-3 text-sm">
					<div className="font-medium text-amber-600">{t("secretNotice")}</div>
					<div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
						<code className="min-w-0 flex-1 break-all rounded bg-black/10 px-2 py-1.5 text-xs">
							{secret}
						</code>
						<button
							type="button"
							onClick={() => void copySecret()}
							className="rounded-md border px-3 py-1.5 text-xs"
						>
							{copied ? t("copied") : t("copy")}
						</button>
					</div>
				</div>
			) : null}

			{error ? (
				<div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
					{error}
				</div>
			) : null}

			{canManage ? (
				<div
					className="overflow-x-auto rounded-lg border"
					style={{ borderColor: "var(--console-border)" }}
				>
					{isLoading ? (
						<div className="console-muted px-4 py-8 text-center text-sm">
							{t("loading")}
						</div>
					) : rows.length === 0 ? (
						<div className="console-muted px-4 py-8 text-center text-sm">
							{t("empty")}
						</div>
					) : (
						<table className="w-full min-w-[720px] text-sm">
							<thead>
								<tr
									className="border-b text-left text-xs"
									style={{ borderColor: "var(--console-border)" }}
								>
									<th className="px-4 py-2.5">{t("key")}</th>
									<th className="px-4 py-2.5">{t("expires")}</th>
									<th className="px-4 py-2.5">{t("lastUsed")}</th>
									<th className="px-4 py-2.5">{t("createdAt")}</th>
									<th className="px-4 py-2.5 text-right">{t("actions")}</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((row) => (
									<tr
										key={row.id}
										className="border-b last:border-0"
										style={{ borderColor: "var(--console-border)" }}
									>
										<td className="px-4 py-3">
											<div className="font-medium">{row.name}</div>
											<code className="console-muted text-xs">{row.label}</code>
										</td>
										<td className="console-muted px-4 py-3 text-xs">
											{row.expires_at
												? new Date(row.expires_at).toLocaleString()
												: t("neverExpires")}
										</td>
										<td className="console-muted px-4 py-3 text-xs">
											{row.last_used_at
												? new Date(row.last_used_at).toLocaleString()
												: t("neverUsed")}
										</td>
										<td className="console-muted px-4 py-3 text-xs">
											{new Date(row.created_at).toLocaleString()}
										</td>
										<td className="px-4 py-3 text-right">
											<button
												type="button"
												disabled={isMutating}
												onClick={() => revoke(row)}
												className="rounded-md border border-red-500/30 px-2.5 py-1 text-xs text-red-500 disabled:opacity-50"
											>
												{t("revoke")}
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
			) : null}
		</section>
	);
}
