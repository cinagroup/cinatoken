"use client";

import {
	useEffect,
	useRef,
	useState,
	useTransition,
	type TransitionStartFunction,
} from "react";
import { useLocale, useTranslations } from "next-intl";
import { usePortalWorkspace } from "@/components/portal/PortalWorkspaceContext";
import { readPortalJson } from "@/lib/portal-fetch";

const INTERVALS = ["daily", "weekly", "monthly", "lifetime"] as const;
type Interval = (typeof INTERVALS)[number];

type WorkspaceBudget = {
	id: string;
	workspaceId: string;
	limitUsd: number;
	resetInterval: Interval;
	periodStart: string;
	periodEnd: string;
	spentUsd: number;
	reservedUsd: number;
	remainingUsd: number;
	createdAt: string;
	updatedAt: string;
};

const EMPTY_DRAFTS: Record<Interval, string> = {
	daily: "",
	weekly: "",
	monthly: "",
	lifetime: "",
};

function intervalKey(interval: Interval) {
	return `interval_${interval}` as const;
}

export default function WorkspaceBudgetManager() {
	const { context, isSwitching } = usePortalWorkspace();
	const workspace = context?.currentWorkspace;
	const workspaceId = workspace?.id ?? "";
	const canManage = workspace?.role === "owner" || workspace?.role === "admin";
	// The pending write stays owned by this wrapper until it really settles,
	// even when a workspace/role change disposes the old private view.
	const [isMutating, startMutation] = useTransition();
	return (
		<WorkspaceBudgetContent
			key={JSON.stringify([workspaceId, workspace?.role, isSwitching])}
			workspaceId={workspaceId}
			canManage={canManage}
			isSwitching={isSwitching}
			isMutating={isMutating}
			startMutation={startMutation}
		/>
	);
}

function WorkspaceBudgetContent({
	workspaceId,
	canManage,
	isSwitching,
	isMutating,
	startMutation,
}: {
	workspaceId: string;
	canManage: boolean;
	isSwitching: boolean;
	isMutating: boolean;
	startMutation: TransitionStartFunction;
}) {
	const t = useTranslations("portal.workspaceBudgets");
	const locale = useLocale();
	const [rows, setRows] = useState<WorkspaceBudget[]>([]);
	const [drafts, setDrafts] = useState<Record<Interval, string>>(EMPTY_DRAFTS);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const active = useRef(false);
	const loadController = useRef<AbortController | null>(null);
	const loadErrorLabel = t("loadFailed");
	const [loadRequest, setLoadRequest] = useState(() => ({
		errorLabel: loadErrorLabel,
	}));
	if (loadRequest.errorLabel !== loadErrorLabel)
		setLoadRequest({ errorLabel: loadErrorLabel });
	const latestLoadRequest = useRef(loadRequest);
	const [completedLoad, setCompletedLoad] = useState<typeof loadRequest | null>(
		null
	);
	const isLoading =
		!!workspaceId && !isSwitching && completedLoad !== loadRequest;

	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);

	useEffect(() => {
		latestLoadRequest.current = loadRequest;
		if (!workspaceId || isSwitching) return;
		const controller = new AbortController();
		loadController.current = controller;
		const current = () => active.current && !controller.signal.aborted;
		void (async () => {
			try {
				const response = await fetch("/api/user/workspace-budgets", {
					cache: "no-store",
					signal: controller.signal,
				});
				const result = await readPortalJson<WorkspaceBudget[]>(response);
				if (!current()) return;
				if (!response.ok || !result?.success) {
					setRows([]);
					setError(result?.message ?? loadRequest.errorLabel);
					return;
				}
				const nextRows = result.data ?? [];
				if (nextRows.some((row) => row.workspaceId !== workspaceId)) {
					setRows([]);
					setError(loadRequest.errorLabel);
					return;
				}
				setRows(nextRows);
				setError("");
			} catch (cause) {
				if (
					!current() ||
					(cause instanceof DOMException && cause.name === "AbortError")
				)
					return;
				setRows([]);
				setError(loadRequest.errorLabel);
			} finally {
				if (current()) setCompletedLoad(loadRequest);
			}
		})();
		return () => controller.abort();
	}, [isSwitching, loadRequest, workspaceId]);

	const finishWrite = () => {
		// A locale refresh may have started another GET while this write was pending.
		loadController.current?.abort();
		setCompletedLoad(latestLoadRequest.current);
	};

	const save = (interval: Interval) => {
		if (
			!active.current ||
			!workspaceId ||
			!canManage ||
			isSwitching ||
			isMutating
		)
			return;
		const limitUsd = Number(drafts[interval]);
		if (!Number.isFinite(limitUsd) || limitUsd <= 0) {
			setError(t("invalidLimit"));
			return;
		}
		setError("");
		setNotice("");
		loadController.current?.abort();
		setCompletedLoad(loadRequest);
		startMutation(async () => {
			try {
				const response = await fetch(
					`/api/user/workspace-budgets/${interval}`,
					{
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ limit_usd: limitUsd }),
					}
				);
				const result = await readPortalJson<WorkspaceBudget>(response);
				if (!active.current) return;
				finishWrite();
				if (!response.ok || !result?.success || !result.data) {
					setError(result?.message ?? t("saveFailed"));
					return;
				}
				if (result.data.workspaceId !== workspaceId) return;
				setRows((current) => [
					...current.filter((row) => row.resetInterval !== interval),
					result.data!,
				]);
				setDrafts((current) => ({ ...current, [interval]: "" }));
				setNotice(t("saved"));
			} catch {
				if (active.current) {
					finishWrite();
					setError(t("saveFailed"));
				}
			}
		});
	};

	const remove = (interval: Interval) => {
		if (
			!active.current ||
			!workspaceId ||
			!canManage ||
			isSwitching ||
			isMutating ||
			!window.confirm(
				t("confirmDelete", { interval: t(intervalKey(interval)) })
			)
		)
			return;
		setError("");
		setNotice("");
		loadController.current?.abort();
		setCompletedLoad(loadRequest);
		startMutation(async () => {
			try {
				const response = await fetch(
					`/api/user/workspace-budgets/${interval}`,
					{
						method: "DELETE",
					}
				);
				const result = await readPortalJson<never>(response);
				if (!active.current) return;
				finishWrite();
				if (!response.ok || !result?.success) {
					setError(result?.message ?? t("deleteFailed"));
					return;
				}
				setRows((current) =>
					current.filter((row) => row.resetInterval !== interval)
				);
				setNotice(t("deleted"));
			} catch {
				if (active.current) {
					finishWrite();
					setError(t("deleteFailed"));
				}
			}
		});
	};

	const money = new Intl.NumberFormat(locale, {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 6,
	});
	const date = new Intl.DateTimeFormat(locale, {
		dateStyle: "medium",
		timeZone: "UTC",
	});

	return (
		<section
			className="console-panel rounded-xl border p-5"
			style={{ borderColor: "var(--console-border)" }}
		>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<h2 className="text-base font-semibold">{t("title")}</h2>
					<p className="console-muted mt-1 text-sm">{t("subtitle")}</p>
				</div>
				<span className="console-badge self-start rounded-full px-2.5 py-1 text-xs">
					{canManage ? t("editable") : t("readOnly")}
				</span>
			</div>

			{error && (
				<div
					role="alert"
					className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
				>
					{error}
				</div>
			)}
			{notice && (
				<div
					role="status"
					className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
				>
					{notice}
				</div>
			)}

			<div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
				{INTERVALS.map((interval) => {
					const row = rows.find(
						(candidate) => candidate.resetInterval === interval
					);
					const spentPercent = row
						? Math.min(100, (row.spentUsd / row.limitUsd) * 100)
						: 0;
					const reservedPercent = row
						? Math.min(
								100 - spentPercent,
								(row.reservedUsd / row.limitUsd) * 100
						  )
						: 0;
					return (
						<div
							key={interval}
							className="rounded-lg border p-4"
							style={{ borderColor: "var(--console-border)" }}
						>
							<div className="text-sm font-medium">
								{t(intervalKey(interval))}
							</div>
							<div className="mt-2 text-xl font-semibold">
								{row ? money.format(row.limitUsd) : t("notConfigured")}
							</div>
							<div className="console-muted mt-1 min-h-8 text-xs">
								{t(`reset_${interval}`)}
							</div>
							{row && (
								<div className="mt-3 space-y-2">
									<div
										role="progressbar"
										aria-label={t("usageLabel", {
											interval: t(intervalKey(interval)),
										})}
										aria-valuemin={0}
										aria-valuemax={row.limitUsd}
										aria-valuenow={Math.min(
											row.limitUsd,
											row.spentUsd + row.reservedUsd
										)}
										className="flex h-2 overflow-hidden rounded-full"
										style={{ background: "var(--console-panel-subtle)" }}
									>
										<div
											className="h-full bg-cyan-600"
											style={{ width: `${spentPercent}%` }}
										/>
										<div
											className="h-full bg-cyan-300"
											style={{ width: `${reservedPercent}%` }}
										/>
									</div>
									<div className="grid grid-cols-3 gap-2 text-xs">
										<div>
											<div className="console-muted">{t("spent")}</div>
											<div className="mt-0.5 font-medium">
												{money.format(row.spentUsd)}
											</div>
										</div>
										<div>
											<div className="console-muted">{t("reserved")}</div>
											<div className="mt-0.5 font-medium">
												{money.format(row.reservedUsd)}
											</div>
										</div>
										<div>
											<div className="console-muted">{t("remaining")}</div>
											<div className="mt-0.5 font-medium">
												{money.format(row.remainingUsd)}
											</div>
										</div>
									</div>
									<div className="console-muted text-[11px]">
										{interval === "lifetime"
											? t("periodSince", {
													start: date.format(new Date(row.periodStart)),
											  })
											: t("periodWindow", {
													start: date.format(new Date(row.periodStart)),
													end: date.format(new Date(row.periodEnd)),
											  })}
									</div>
								</div>
							)}
							{canManage && (
								<div className="mt-3 space-y-2">
									<input
										type="number"
										min="0.000001"
										step="0.000001"
										value={drafts[interval]}
										onChange={(event) =>
											setDrafts((current) => ({
												...current,
												[interval]: event.target.value,
											}))
										}
										placeholder={
											row ? String(row.limitUsd) : t("limitPlaceholder")
										}
										aria-label={t("limitLabel", {
											interval: t(intervalKey(interval)),
										})}
										className="console-input w-full rounded-lg border px-3 py-2 text-sm"
										disabled={isSwitching || isMutating}
									/>
									<div className="flex gap-2">
										<button
											type="button"
											onClick={() => save(interval)}
											disabled={isSwitching || isMutating || !drafts[interval]}
											className="rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
										>
											{t("save")}
										</button>
										{row && (
											<button
												type="button"
												onClick={() => remove(interval)}
												disabled={isSwitching || isMutating}
												className="rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-40"
												style={{ borderColor: "var(--console-border)" }}
											>
												{t("delete")}
											</button>
										)}
									</div>
								</div>
							)}
						</div>
					);
				})}
			</div>
			{isLoading && (
				<div className="console-muted mt-3 text-xs">{t("loading")}</div>
			)}
			<p className="console-muted mt-4 text-xs">{t("ordering")}</p>
		</section>
	);
}
