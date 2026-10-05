"use client";

import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTranslations } from "next-intl";
import { useOptionalPortalWorkspace } from "@/components/portal/PortalWorkspaceContext";
import { readPortalJson } from "@/lib/portal-fetch";
import EffectiveGuardrailPreview from "./EffectiveGuardrailPreview";

type Guardrail = {
	id: string;
	workspaceId: string;
	ownerUserId: string;
	name: string;
	description: string | null;
	status: "active" | "archived";
	isWorkspaceDefault: boolean;
	isAccountDefault: boolean;
	accountScopeKey: string | null;
	designatedVersion: number;
	latestVersion: number;
	config: Record<string, unknown> | null;
	updatedAt: string;
};
type Version = {
	id: string;
	version: number;
	config: Record<string, unknown> | null;
	createdAt: string;
};
type Assignment = {
	id: string;
	workspaceId: string;
	guardrailId: string;
	scopeType: "user" | "api_key";
	scopeId: string;
	createdAt: string;
};
type GatewayKey = {
	id: string;
	workspaceId: string;
	name: string | null;
	key: string;
	status: string;
};
type PortalMe = { userId: string };
type UserGuardrailCollection = { workspaceId: string; guardrails: Guardrail[] };

const DEFAULT_CONFIG = `{
  "allowed_models": [],
  "allowed_providers": [],
  "content_filter_builtins": [],
  "input_filters": [],
  "output_filters": [],
  "require_zdr": false
}`;

export default function GuardrailManager({ mode }: { mode: "user" | "admin" }) {
	const t = useTranslations("guardrails");
	const portalWorkspace = useOptionalPortalWorkspace();
	const workspaceId =
		mode === "user" ? portalWorkspace?.context?.currentWorkspace.id ?? "" : "";
	const workspaceName =
		mode === "user"
			? portalWorkspace?.context?.currentWorkspace.name ?? ""
			: "";
	// A submitted save keeps its UI lock across workspace changes until it settles.
	const [saving, setSaving] = useState(false);
	const lifetimeRef = useRef<AbortController | null>(null);
	const pendingSavesRef = useRef(0);
	useLayoutEffect(() => {
		const lifetime = new AbortController();
		lifetimeRef.current = lifetime;
		return () => lifetime.abort();
	}, []);
	const beginSave = () => {
		const lifetime = lifetimeRef.current;
		if (!lifetime || lifetime.signal.aborted) return null;
		pendingSavesRef.current += 1;
		setSaving(true);
		let settled = false;
		return () => {
			if (settled || lifetime.signal.aborted) return;
			settled = true;
			pendingSavesRef.current -= 1;
			setSaving(pendingSavesRef.current > 0);
		};
	};
	if (mode === "user" && portalWorkspace?.isSwitching) {
		return (
			<div className="console-muted py-10 text-center text-sm">
				{t("loading")}
			</div>
		);
	}
	return (
		<ScopedGuardrailManager
			key={`${mode}:${workspaceId}`}
			mode={mode}
			workspaceId={workspaceId}
			workspaceName={workspaceName}
			saving={saving}
			beginSave={beginSave}
		/>
	);
}

function ScopedGuardrailManager({
	mode,
	workspaceId,
	workspaceName,
	saving,
	beginSave,
}: {
	mode: "user" | "admin";
	workspaceId: string;
	workspaceName: string;
	saving: boolean;
	beginSave: () => (() => void) | null;
}) {
	const t = useTranslations("guardrails");
	const portalWorkspace = useOptionalPortalWorkspace();
	const base =
		mode === "user" ? "/api/user/guardrails" : "/api/admin/guardrails";
	const [rows, setRows] = useState<Guardrail[]>([]);
	const [versions, setVersions] = useState<Record<string, Version[]>>({});
	const [assignments, setAssignments] = useState<Record<string, Assignment[]>>(
		{}
	);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [keys, setKeys] = useState<GatewayKey[]>([]);
	const [me, setMe] = useState<PortalMe | null>(null);
	const [loading, setLoading] = useState(
		mode === "admin" || Boolean(workspaceId)
	);
	const [message, setMessage] = useState<{
		error: boolean;
		text: string;
	} | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [adminScope, setAdminScope] = useState<
		Record<string, { type: "user" | "api_key"; id: string }>
	>({});
	const [form, setForm] = useState({
		name: "",
		description: "",
		config: DEFAULT_CONFIG,
	});
	const editingGuardrail = rows.find((row) => row.id === editingId) ?? null;

	const scopeRef = useRef<AbortController | null>(null);
	const listReadRef = useRef<AbortController | null>(null);
	const detailReadRef = useRef<AbortController | null>(null);
	const identityReadRef = useRef<AbortController | null>(null);
	useLayoutEffect(() => {
		const scope = new AbortController();
		scopeRef.current = scope;
		return () => {
			scope.abort();
			listReadRef.current?.abort();
			detailReadRef.current?.abort();
			identityReadRef.current?.abort();
		};
	}, []);
	const load = useCallback(() => {
		const scope = scopeRef.current;
		if (!scope || scope.signal.aborted || (mode === "user" && !workspaceId))
			return;
		listReadRef.current?.abort();
		const controller = new AbortController();
		listReadRef.current = controller;
		const signal = controller.signal;
		return fetch(base, { cache: "no-store", signal })
			.then(async (response) => {
				const payload = await readPortalJson<
					Guardrail[] | UserGuardrailCollection
				>(response);
				if (scope.signal.aborted || signal.aborted) return;
				if (!response.ok || !payload?.success)
					throw new Error(payload?.message ?? t("loadFailed"));
				const data = payload.data;
				const responseWorkspaceId =
					mode === "user" && data && !Array.isArray(data)
						? data.workspaceId
						: null;
				const nextRows = Array.isArray(data) ? data : data?.guardrails ?? [];
				if (
					mode === "user" &&
					(responseWorkspaceId !== workspaceId ||
						nextRows.some(
							(row) => !row.isAccountDefault && row.workspaceId !== workspaceId
						))
				)
					throw new Error(t("loadFailed"));
				setRows(nextRows);
				setMessage(null);
			})
			.catch((error: unknown) => {
				if (
					scope.signal.aborted ||
					signal.aborted ||
					(error instanceof DOMException && error.name === "AbortError")
				)
					return;
				setRows([]);
				setMessage({
					error: true,
					text: error instanceof Error ? error.message : t("loadFailed"),
				});
			})
			.finally(() => {
				if (!scope.signal.aborted && !signal.aborted) setLoading(false);
			});
	}, [base, mode, t, workspaceId]);

	useEffect(() => {
		void load();
		return () => listReadRef.current?.abort();
	}, [load]);

	const reload = async () => {
		const scope = scopeRef.current;
		if (!scope || scope.signal.aborted) return;
		setLoading(true);
		await load();
	};
	useEffect(() => {
		const scope = scopeRef.current;
		if (mode !== "user" || !workspaceId || !scope || scope.signal.aborted)
			return;
		const controller = new AbortController();
		identityReadRef.current = controller;
		void Promise.all([
			fetch("/api/user/me", {
				cache: "no-store",
				signal: controller.signal,
			}).then((r) => readPortalJson<PortalMe>(r)),
			fetch("/api/user/gateway-keys", {
				cache: "no-store",
				signal: controller.signal,
			}).then((r) => readPortalJson<GatewayKey[]>(r)),
		])
			.then(([mePayload, keyPayload]) => {
				if (scope.signal.aborted || controller.signal.aborted) return;
				const nextKeys = keyPayload?.data ?? [];
				if (nextKeys.some((key) => key.workspaceId !== workspaceId)) {
					setMessage({ error: true, text: t("loadFailed") });
					return;
				}
				setMe(mePayload?.data ?? null);
				setKeys(nextKeys);
			})
			.catch((error) => {
				if (
					!scope.signal.aborted &&
					!controller.signal.aborted &&
					!(error instanceof DOMException && error.name === "AbortError")
				)
					setMessage({ error: true, text: t("loadFailed") });
			});
		return () => controller.abort();
	}, [mode, t, workspaceId]);

	const save = async () => {
		const scope = scopeRef.current;
		if (!scope || scope.signal.aborted || saving) return;
		let config: Record<string, unknown>;
		try {
			const value = JSON.parse(form.config) as unknown;
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new Error();
			config = value as Record<string, unknown>;
		} catch {
			setMessage({ error: true, text: t("invalidJson") });
			return;
		}
		const finishSave = beginSave();
		if (!finishSave) return;
		try {
			const url = editingId ? `${base}/${editingId}/versions` : base;
			const response = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: form.name,
					description: form.description || null,
					config,
				}),
			});
			const payload = await readPortalJson<Guardrail>(response);
			if (scope.signal.aborted) return;
			if (!response.ok || !payload?.success)
				throw new Error(payload?.message ?? t("saveFailed"));
			if (
				mode === "user" &&
				payload.data &&
				!payload.data.isAccountDefault &&
				payload.data.workspaceId !== workspaceId
			)
				return;
			setMessage({ error: false, text: t("saved") });
			setEditingId(null);
			setForm({ name: "", description: "", config: DEFAULT_CONFIG });
			await reload();
		} catch (error) {
			if (!scope.signal.aborted)
				setMessage({
					error: true,
					text: error instanceof Error ? error.message : t("saveFailed"),
				});
		} finally {
			finishSave();
		}
	};

	const edit = (row: Guardrail) => {
		if (
			mode === "user" &&
			!row.isAccountDefault &&
			row.workspaceId !== workspaceId
		)
			return;
		setEditingId(row.id);
		setForm({
			name: row.name,
			description: row.description ?? "",
			config: JSON.stringify(row.config ?? {}, null, 2),
		});
		window.scrollTo({ top: 0, behavior: "smooth" });
	};

	const patchRow = async (row: Guardrail, body: Record<string, unknown>) => {
		const scope = scopeRef.current;
		if (
			!scope ||
			scope.signal.aborted ||
			(mode === "user" &&
				!row.isAccountDefault &&
				row.workspaceId !== workspaceId)
		)
			return;
		try {
			const response = await fetch(`${base}/${row.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const payload = await readPortalJson<Guardrail>(response);
			if (scope.signal.aborted) return;
			if (!response.ok || !payload?.success)
				throw new Error(payload?.message ?? t("updateFailed"));
			if (
				mode === "user" &&
				payload.data &&
				!payload.data.isAccountDefault &&
				payload.data.workspaceId !== workspaceId
			)
				return;
			await reload();
		} catch (error) {
			if (!scope.signal.aborted)
				setMessage({
					error: true,
					text: error instanceof Error ? error.message : t("updateFailed"),
				});
		}
	};

	const showDetails = async (row: Guardrail, refresh = false) => {
		const scope = scopeRef.current;
		if (
			!scope ||
			scope.signal.aborted ||
			(mode === "user" &&
				!row.isAccountDefault &&
				row.workspaceId !== workspaceId)
		)
			return;
		detailReadRef.current?.abort();
		if (!refresh && expanded === row.id) {
			setExpanded(null);
			return;
		}
		const controller = new AbortController();
		detailReadRef.current = controller;
		try {
			const [vr, ar] = await Promise.all([
				fetch(`${base}/${row.id}/versions`, {
					cache: "no-store",
					signal: controller.signal,
				}),
				fetch(`${base}/${row.id}/assignments`, {
					cache: "no-store",
					signal: controller.signal,
				}),
			]);
			const [vp, ap] = await Promise.all([
				readPortalJson<Version[]>(vr),
				readPortalJson<Assignment[]>(ar),
			]);
			if (scope.signal.aborted || controller.signal.aborted) return;
			if (!vr.ok || !ar.ok || !vp?.success || !ap?.success)
				throw new Error(vp?.message ?? ap?.message ?? t("loadFailed"));
			if (
				mode === "user" &&
				(ap.data ?? []).some(
					(assignment) => assignment.workspaceId !== workspaceId
				)
			)
				return;
			setVersions((value) => ({ ...value, [row.id]: vp.data ?? [] }));
			setAssignments((value) => ({ ...value, [row.id]: ap.data ?? [] }));
			setExpanded(row.id);
		} catch (error) {
			if (!scope.signal.aborted && !controller.signal.aborted)
				setMessage({
					error: true,
					text: error instanceof Error ? error.message : t("loadFailed"),
				});
		}
	};

	const designate = async (row: Guardrail, version: number) => {
		const scope = scopeRef.current;
		if (
			!scope ||
			scope.signal.aborted ||
			(mode === "user" &&
				!row.isAccountDefault &&
				row.workspaceId !== workspaceId)
		)
			return;
		try {
			const response = await fetch(`${base}/${row.id}/designate`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ version }),
			});
			const payload = await readPortalJson<Guardrail>(response);
			if (scope.signal.aborted) return;
			if (!response.ok || !payload?.success)
				throw new Error(payload?.message ?? t("updateFailed"));
			if (
				mode === "user" &&
				payload.data &&
				!payload.data.isAccountDefault &&
				payload.data.workspaceId !== workspaceId
			)
				return;
			await reload();
			if (scope.signal.aborted) return;
			setExpanded(null);
			await showDetails({ ...row, designatedVersion: version }, true);
		} catch (error) {
			if (!scope.signal.aborted)
				setMessage({
					error: true,
					text: error instanceof Error ? error.message : t("updateFailed"),
				});
		}
	};

	const bind = async (
		row: Guardrail,
		scopeType: "user" | "api_key",
		scopeId: string
	) => {
		const scope = scopeRef.current;
		if (
			!scope ||
			scope.signal.aborted ||
			!scopeId ||
			(mode === "user" && row.workspaceId !== workspaceId)
		)
			return;
		try {
			const response = await fetch(`${base}/${row.id}/assignments`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ scope_type: scopeType, scope_id: scopeId }),
			});
			const payload = await readPortalJson<Assignment>(response);
			if (scope.signal.aborted) return;
			if (!response.ok || !payload?.success)
				throw new Error(payload?.message ?? t("assignFailed"));
			if (payload.data?.workspaceId !== row.workspaceId)
				throw new Error(t("assignFailed"));
			setMessage({ error: false, text: t("assigned") });
			setExpanded(null);
			await showDetails(row, true);
		} catch (error) {
			if (!scope.signal.aborted)
				setMessage({
					error: true,
					text: error instanceof Error ? error.message : t("assignFailed"),
				});
		}
	};

	const unbind = async (row: Guardrail, assignment: Assignment) => {
		const scope = scopeRef.current;
		if (
			!scope ||
			scope.signal.aborted ||
			assignment.workspaceId !== row.workspaceId ||
			(mode === "user" && row.workspaceId !== workspaceId)
		)
			return;
		try {
			const workspaceQuery =
				mode === "admin"
					? `?workspace_id=${encodeURIComponent(row.workspaceId)}`
					: "";
			const response = await fetch(
				`${base}/assignments/${assignment.scopeType}/${encodeURIComponent(
					assignment.scopeId
				)}${workspaceQuery}`,
				{ method: "DELETE" }
			);
			const payload = await readPortalJson(response);
			if (scope.signal.aborted) return;
			if (!response.ok || !payload?.success)
				throw new Error(payload?.message ?? t("updateFailed"));
			setExpanded(null);
			await showDetails(row, true);
		} catch (error) {
			if (!scope.signal.aborted)
				setMessage({
					error: true,
					text: error instanceof Error ? error.message : t("updateFailed"),
				});
		}
	};

	return (
		<div className="space-y-6">
			<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<h1 className="text-2xl font-bold">
						{mode === "admin" ? t("adminTitle") : t("title")}
					</h1>
					<p className="console-muted mt-1 text-sm">
						{mode === "admin" ? t("adminSubtitle") : t("subtitle")}
					</p>
				</div>
				{mode === "user" && (
					<div className="console-badge self-start rounded-full px-2.5 py-1 text-xs">
						{t("workspaceScope", { name: workspaceName || workspaceId })}
					</div>
				)}
			</div>
			{message && (
				<div
					className={`rounded-lg border p-3 text-sm ${
						message.error
							? "border-red-300 bg-red-50 text-red-700"
							: "border-emerald-300 bg-emerald-50 text-emerald-700"
					}`}
				>
					{message.text}
				</div>
			)}
			<EffectiveGuardrailPreview
				mode={mode}
				workspaceId={workspaceId}
				keys={keys}
			/>
			{mode === "user" && (
				<section
					className="console-panel rounded-xl border p-4 sm:p-6"
					style={{ borderColor: "var(--console-border)" }}
				>
					<div className="flex items-start justify-between gap-3">
						<div>
							<h2 className="font-semibold">
								{editingId ? t("newVersion") : t("editorTitle")}
							</h2>
							<p className="console-muted mt-1 text-xs">{t("editorHint")}</p>
						</div>
						{editingId && (
							<button
								type="button"
								className="text-xs text-cyan-600"
								onClick={() => {
									setEditingId(null);
									setForm({
										name: "",
										description: "",
										config: DEFAULT_CONFIG,
									});
								}}
							>
								{t("cancel")}
							</button>
						)}
					</div>
					<div className="mt-4 grid gap-4 sm:grid-cols-2">
						<label className="text-sm">
							{t("name")}
							<input
								disabled={
									editingGuardrail?.isWorkspaceDefault ||
									editingGuardrail?.isAccountDefault
								}
								className="console-input mt-1 w-full rounded-lg border px-3 py-2 disabled:opacity-60"
								value={form.name}
								onChange={(e) => setForm({ ...form, name: e.target.value })}
							/>
						</label>
						<label className="text-sm">
							{t("description")}
							<input
								className="console-input mt-1 w-full rounded-lg border px-3 py-2"
								value={form.description}
								onChange={(e) =>
									setForm({ ...form, description: e.target.value })
								}
							/>
						</label>
						<label className="text-sm sm:col-span-2">
							{t("config")}
							<textarea
								className="console-input mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs"
								rows={15}
								spellCheck={false}
								value={form.config}
								onChange={(e) => setForm({ ...form, config: e.target.value })}
							/>
						</label>
					</div>
					<button
						type="button"
						disabled={
							saving ||
							portalWorkspace?.isSwitching ||
							!workspaceId ||
							!form.name.trim()
						}
						onClick={() => void save()}
						className="mt-4 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
					>
						{saving ? t("saving") : t("saveVersion")}
					</button>
				</section>
			)}
			<section className="space-y-3">
				{loading ? (
					<div className="console-muted py-10 text-center text-sm">
						{t("loading")}
					</div>
				) : rows.length === 0 ? (
					<div
						className="console-panel console-muted rounded-xl border p-8 text-center text-sm"
						style={{ borderColor: "var(--console-border)" }}
					>
						{t("empty")}
					</div>
				) : (
					rows.map((row) => (
						<article
							key={row.id}
							className="console-panel rounded-xl border p-4"
							style={{ borderColor: "var(--console-border)" }}
						>
							<div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-start">
								<div className="min-w-0">
									<div className="flex flex-wrap items-center gap-2">
										<h2 className="font-semibold">{row.name}</h2>
										{row.isWorkspaceDefault && (
											<span className="rounded-full border border-cyan-300 bg-cyan-50 px-2 py-0.5 text-xs text-cyan-700">
												{t("defaultBadge")}
											</span>
										)}
										{row.isAccountDefault && (
											<span className="rounded-full border border-violet-300 bg-violet-50 px-2 py-0.5 text-xs text-violet-700">
												{t("accountDefaultBadge")}
											</span>
										)}
										<span className="rounded-full border px-2 py-0.5 text-xs">
											v{row.designatedVersion}
										</span>
										<span className="rounded-full border px-2 py-0.5 text-xs">
											{t(row.status)}
										</span>
									</div>
									<p className="console-muted mt-2 text-sm">
										{row.description || t("noDescription")}
									</p>
									{mode === "admin" && (
										<p className="console-muted mt-1 break-all text-xs">
											{t("workspace")}: {row.workspaceId} · {t("owner")}:{" "}
											{row.ownerUserId}
										</p>
									)}
								</div>
								<div className="flex flex-wrap gap-2 text-xs">
									{mode === "user" && row.ownerUserId === me?.userId && (
										<button
											type="button"
											onClick={() => edit(row)}
											className="rounded-md border px-3 py-1.5"
										>
											{t("newVersion")}
										</button>
									)}
									<button
										type="button"
										onClick={() => void showDetails(row)}
										className="rounded-md border px-3 py-1.5"
									>
										{t("details")}
									</button>
									{!row.isWorkspaceDefault && !row.isAccountDefault && (
										<button
											type="button"
											onClick={() =>
												void patchRow(row, {
													status:
														row.status === "active" ? "archived" : "active",
												})
											}
											className="rounded-md border px-3 py-1.5"
										>
											{row.status === "active" ? t("archive") : t("restore")}
										</button>
									)}
								</div>
							</div>
							{expanded === row.id && (
								<div
									className="mt-4 space-y-4 border-t pt-4"
									style={{ borderColor: "var(--console-border)" }}
								>
									<div>
										<h3 className="text-sm font-semibold">
											{t("assignments")}
										</h3>
										{row.isWorkspaceDefault || row.isAccountDefault ? (
											<p className="console-muted mt-2 text-xs">
												{t(
													row.isAccountDefault
														? "implicitAccountDefault"
														: "implicitDefault"
												)}
											</p>
										) : (
											<>
												<div className="mt-2 flex flex-wrap gap-2">
													{mode === "user" ? (
														<>
															<button
																disabled={!me || row.status !== "active"}
																className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
																onClick={() =>
																	me && void bind(row, "user", me.userId)
																}
															>
																{t("bindAccount")}
															</button>
															{keys
																.filter((key) => key.status === "active")
																.map((key) => (
																	<button
																		key={key.id}
																		disabled={row.status !== "active"}
																		className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
																		onClick={() =>
																			void bind(row, "api_key", key.id)
																		}
																	>
																		{t("bindKey")}: {key.name || key.key}
																	</button>
																))}
														</>
													) : (
														<>
															<select
																className="console-input rounded-md border px-2 py-1.5 text-xs"
																value={adminScope[row.id]?.type ?? "user"}
																onChange={(e) =>
																	setAdminScope((value) => ({
																		...value,
																		[row.id]: {
																			type: e.target.value as
																				| "user"
																				| "api_key",
																			id: value[row.id]?.id ?? "",
																		},
																	}))
																}
															>
																<option value="user">user</option>
																<option value="api_key">api_key</option>
															</select>
															<input
																className="console-input min-w-64 rounded-md border px-2 py-1.5 font-mono text-xs"
																placeholder={t("scopeId")}
																value={adminScope[row.id]?.id ?? ""}
																onChange={(e) =>
																	setAdminScope((value) => ({
																		...value,
																		[row.id]: {
																			type: value[row.id]?.type ?? "user",
																			id: e.target.value,
																		},
																	}))
																}
															/>
															<button
																className="rounded-md border px-3 py-1.5 text-xs"
																onClick={() => {
																	const scope = adminScope[row.id];
																	if (scope)
																		void bind(row, scope.type, scope.id);
																}}
															>
																{t("bind")}
															</button>
														</>
													)}
												</div>
												<div className="mt-2 space-y-1">
													{(assignments[row.id] ?? []).length === 0 ? (
														<p className="console-muted text-xs">
															{t("noAssignments")}
														</p>
													) : (
														(assignments[row.id] ?? []).map((assignment) => (
															<div
																key={assignment.id}
																className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs"
															>
																<code className="break-all">
																	{assignment.scopeType}:{assignment.scopeId}
																</code>
																<button
																	className="text-red-600"
																	onClick={() => void unbind(row, assignment)}
																>
																	{t("unbind")}
																</button>
															</div>
														))
													)}
												</div>
											</>
										)}
									</div>
									<div className="overflow-x-auto">
										<h3 className="mb-2 text-sm font-semibold">
											{t("versions")}
										</h3>
										<table className="w-full min-w-[480px] text-left text-xs">
											<thead className="console-muted">
												<tr>
													<th className="py-2">{t("version")}</th>
													<th>{t("createdAt")}</th>
													<th>{t("actions")}</th>
												</tr>
											</thead>
											<tbody>
												{(versions[row.id] ?? []).map((version) => (
													<tr
														key={version.id}
														className="border-t"
														style={{ borderColor: "var(--console-border)" }}
													>
														<td className="py-2">
															v{version.version}
															{version.version === row.designatedVersion
																? ` · ${t("designated")}`
																: ""}
														</td>
														<td>
															{new Date(version.createdAt).toLocaleString()}
														</td>
														<td>
															{version.version !== row.designatedVersion &&
															row.status === "active" &&
															(mode === "admin" ||
																row.ownerUserId === me?.userId) ? (
																<button
																	className="text-cyan-600"
																	onClick={() =>
																		void designate(row, version.version)
																	}
																>
																	{t("designate")}
																</button>
															) : (
																"—"
															)}
														</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
								</div>
							)}
						</article>
					))
				)}
			</section>
		</div>
	);
}
