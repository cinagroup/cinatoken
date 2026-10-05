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

type Preset = {
	id: string;
	workspaceId: string;
	ownerUserId: string;
	slug: string;
	name: string;
	description: string | null;
	visibility: "private" | "public";
	status: "active" | "archived";
	designatedVersion: number;
	latestVersion: number;
	systemPrompt: string | null;
	config: Record<string, unknown> | null;
	updatedAt: string;
};

type UserPresetCollection = { workspaceId: string; presets: Preset[] };

type Version = {
	id: string;
	version: number;
	systemPrompt: string | null;
	config: Record<string, unknown> | null;
	createdAt: string;
};

export default function PresetManager({ mode }: { mode: "user" | "admin" }) {
	const t = useTranslations("presets");
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
		<ScopedPresetManager
			key={`${mode}:${workspaceId}`}
			mode={mode}
			workspaceId={workspaceId}
			workspaceName={workspaceName}
			saving={saving}
			beginSave={beginSave}
		/>
	);
}

function ScopedPresetManager({
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
	const t = useTranslations("presets");
	const portalWorkspace = useOptionalPortalWorkspace();
	const base = mode === "user" ? "/api/user/presets" : "/api/admin/presets";
	const [presets, setPresets] = useState<Preset[]>([]);
	const [versions, setVersions] = useState<Record<string, Version[]>>({});
	const [expanded, setExpanded] = useState<string | null>(null);
	const [loading, setLoading] = useState(
		mode === "admin" || Boolean(workspaceId)
	);
	const [message, setMessage] = useState<{
		error: boolean;
		text: string;
	} | null>(null);
	const [form, setForm] = useState({
		slug: "",
		name: "",
		description: "",
		visibility: "private" as "private" | "public",
		systemPrompt: "",
		config: '{\n  "model": "",\n  "temperature": 0.2\n}',
	});

	const scopeRef = useRef<AbortController | null>(null);
	const listReadRef = useRef<AbortController | null>(null);
	const detailReadRef = useRef<AbortController | null>(null);
	useLayoutEffect(() => {
		const scope = new AbortController();
		scopeRef.current = scope;
		return () => {
			scope.abort();
			listReadRef.current?.abort();
			detailReadRef.current?.abort();
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
				const payload = await readPortalJson<Preset[] | UserPresetCollection>(
					response
				);
				if (scope.signal.aborted || signal.aborted) return;
				if (!response.ok || !payload?.success)
					throw new Error(payload?.message ?? t("loadFailed"));
				const data = payload.data;
				const responseWorkspaceId =
					mode === "user" && data && !Array.isArray(data)
						? data.workspaceId
						: null;
				const nextPresets = Array.isArray(data) ? data : data?.presets ?? [];
				if (
					mode === "user" &&
					(responseWorkspaceId !== workspaceId ||
						nextPresets.some((preset) => preset.workspaceId !== workspaceId))
				) {
					throw new Error(t("loadFailed"));
				}
				setPresets(nextPresets);
				setMessage(null);
			})
			.catch((error: unknown) => {
				if (
					scope.signal.aborted ||
					signal.aborted ||
					(error instanceof DOMException && error.name === "AbortError")
				)
					return;
				setPresets([]);
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

	const save = async () => {
		const scope = scopeRef.current;
		if (!scope || scope.signal.aborted || saving) return;
		let config: Record<string, unknown>;
		try {
			const parsed = JSON.parse(form.config) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				throw new Error();
			config = parsed as Record<string, unknown>;
		} catch {
			setMessage({ error: true, text: t("invalidJson") });
			return;
		}
		const finishSave = beginSave();
		if (!finishSave) return;
		try {
			const response = await fetch(base, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...form,
					systemPrompt: form.systemPrompt || null,
					description: form.description || null,
					config,
				}),
			});
			const payload = await readPortalJson<Preset>(response);
			if (scope.signal.aborted) return;
			if (!response.ok || !payload?.success)
				throw new Error(payload?.message ?? t("saveFailed"));
			if (mode === "user" && payload.data?.workspaceId !== workspaceId) return;
			setMessage({ error: false, text: t("saved") });
			setForm({
				slug: "",
				name: "",
				description: "",
				visibility: "private",
				systemPrompt: "",
				config: '{\n  "model": "",\n  "temperature": 0.2\n}',
			});
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

	const edit = (preset: Preset) => {
		if (mode === "user" && preset.workspaceId !== workspaceId) return;
		setForm({
			slug: preset.slug,
			name: preset.name,
			description: preset.description ?? "",
			visibility: preset.visibility,
			systemPrompt: preset.systemPrompt ?? "",
			config: JSON.stringify(preset.config ?? {}, null, 2),
		});
		window.scrollTo({ top: 0, behavior: "smooth" });
	};

	const patch = async (preset: Preset, body: Record<string, unknown>) => {
		const scope = scopeRef.current;
		if (
			!scope ||
			scope.signal.aborted ||
			(mode === "user" && preset.workspaceId !== workspaceId)
		)
			return;
		try {
			const response = await fetch(`${base}/${preset.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const payload = await readPortalJson<Preset>(response);
			if (scope.signal.aborted) return;
			if (!response.ok || !payload?.success)
				throw new Error(payload?.message ?? t("updateFailed"));
			if (mode === "user" && payload.data?.workspaceId !== workspaceId) return;
			await reload();
		} catch (error) {
			if (!scope.signal.aborted)
				setMessage({
					error: true,
					text: error instanceof Error ? error.message : t("updateFailed"),
				});
		}
	};

	const showVersions = async (preset: Preset, refresh = false) => {
		const scope = scopeRef.current;
		if (
			!scope ||
			scope.signal.aborted ||
			(mode === "user" && preset.workspaceId !== workspaceId)
		)
			return;
		detailReadRef.current?.abort();
		if (!refresh && expanded === preset.id) {
			setExpanded(null);
			return;
		}
		const controller = new AbortController();
		detailReadRef.current = controller;
		try {
			const response = await fetch(`${base}/${preset.id}/versions`, {
				cache: "no-store",
				signal: controller.signal,
			});
			const payload = await readPortalJson<Version[]>(response);
			if (scope.signal.aborted || controller.signal.aborted) return;
			if (!response.ok || !payload?.success)
				throw new Error(payload?.message ?? t("loadFailed"));
			setVersions((current) => ({
				...current,
				[preset.id]: payload.data ?? [],
			}));
			setExpanded(preset.id);
		} catch (error) {
			if (!scope.signal.aborted && !controller.signal.aborted)
				setMessage({
					error: true,
					text: error instanceof Error ? error.message : t("loadFailed"),
				});
		}
	};

	const designate = async (preset: Preset, version: number) => {
		const scope = scopeRef.current;
		if (
			!scope ||
			scope.signal.aborted ||
			(mode === "user" && preset.workspaceId !== workspaceId)
		)
			return;
		try {
			const response = await fetch(`${base}/${preset.id}/designate`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ version }),
			});
			const payload = await readPortalJson<Preset>(response);
			if (scope.signal.aborted) return;
			if (!response.ok || !payload?.success)
				throw new Error(payload?.message ?? t("updateFailed"));
			if (mode === "user" && payload.data?.workspaceId !== workspaceId) return;
			await reload();
			if (scope.signal.aborted) return;
			await showVersions({ ...preset, designatedVersion: version }, true);
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

			{mode === "user" && (
				<section
					className="console-panel rounded-xl border p-4 sm:p-6"
					style={{ borderColor: "var(--console-border)" }}
				>
					<h2 className="font-semibold">{t("editorTitle")}</h2>
					<p className="console-muted mt-1 text-xs">{t("editorHint")}</p>
					<div className="mt-4 grid gap-4 sm:grid-cols-2">
						<label className="text-sm">
							{t("slug")}
							<input
								value={form.slug}
								onChange={(e) => setForm({ ...form, slug: e.target.value })}
								className="console-input mt-1 w-full rounded-lg border px-3 py-2 font-mono"
							/>
						</label>
						<label className="text-sm">
							{t("name")}
							<input
								value={form.name}
								onChange={(e) => setForm({ ...form, name: e.target.value })}
								className="console-input mt-1 w-full rounded-lg border px-3 py-2"
							/>
						</label>
						<label className="text-sm sm:col-span-2">
							{t("description")}
							<input
								value={form.description}
								onChange={(e) =>
									setForm({ ...form, description: e.target.value })
								}
								className="console-input mt-1 w-full rounded-lg border px-3 py-2"
							/>
						</label>
						<label className="text-sm">
							{t("visibility")}
							<select
								value={form.visibility}
								onChange={(e) =>
									setForm({
										...form,
										visibility: e.target.value as "private" | "public",
									})
								}
								className="console-input mt-1 w-full rounded-lg border px-3 py-2"
							>
								<option value="private">{t("private")}</option>
								<option value="public">{t("public")}</option>
							</select>
						</label>
						<label className="text-sm sm:col-span-2">
							{t("systemPrompt")}
							<textarea
								value={form.systemPrompt}
								onChange={(e) =>
									setForm({ ...form, systemPrompt: e.target.value })
								}
								rows={4}
								className="console-input mt-1 w-full rounded-lg border px-3 py-2"
							/>
						</label>
						<label className="text-sm sm:col-span-2">
							{t("config")}
							<textarea
								value={form.config}
								onChange={(e) => setForm({ ...form, config: e.target.value })}
								rows={10}
								spellCheck={false}
								className="console-input mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs"
							/>
						</label>
					</div>
					<button
						type="button"
						disabled={
							saving ||
							portalWorkspace?.isSwitching ||
							!workspaceId ||
							!form.slug.trim()
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
				) : presets.length === 0 ? (
					<div
						className="console-panel console-muted rounded-xl border p-8 text-center text-sm"
						style={{ borderColor: "var(--console-border)" }}
					>
						{t("empty")}
					</div>
				) : (
					presets.map((preset) => (
						<article
							key={preset.id}
							className="console-panel rounded-xl border p-4"
							style={{ borderColor: "var(--console-border)" }}
						>
							<div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
								<div className="min-w-0">
									<div className="flex flex-wrap items-center gap-2">
										<h2 className="font-semibold">{preset.name}</h2>
										<code className="console-muted text-xs">
											@preset/{preset.slug}
										</code>
										<span className="rounded-full border px-2 py-0.5 text-xs">
											{t(preset.visibility)}
										</span>
										<span className="rounded-full border px-2 py-0.5 text-xs">
											{t(preset.status)}
										</span>
									</div>
									<p className="console-muted mt-2 text-sm">
										{preset.description || t("noDescription")}
									</p>
									{mode === "admin" && (
										<p className="console-muted mt-1 break-all text-xs">
											{t("workspace")}: {preset.workspaceId} · {t("owner")}:{" "}
											{preset.ownerUserId}
										</p>
									)}
								</div>
								<div className="flex flex-wrap gap-2 text-xs">
									{mode === "user" && (
										<button
											type="button"
											onClick={() => edit(preset)}
											className="rounded-md border px-3 py-1.5"
										>
											{t("newVersion")}
										</button>
									)}
									<button
										type="button"
										onClick={() => void showVersions(preset)}
										className="rounded-md border px-3 py-1.5"
									>
										{t("versions", { count: preset.latestVersion })}
									</button>
									<button
										type="button"
										onClick={() =>
											void patch(preset, {
												visibility:
													preset.visibility === "private"
														? "public"
														: "private",
											})
										}
										className="rounded-md border px-3 py-1.5"
									>
										{preset.visibility === "private"
											? t("makePublic")
											: t("makePrivate")}
									</button>
									<button
										type="button"
										onClick={() =>
											void patch(preset, {
												status:
													preset.status === "active" ? "archived" : "active",
											})
										}
										className="rounded-md border px-3 py-1.5"
									>
										{preset.status === "active" ? t("archive") : t("restore")}
									</button>
								</div>
							</div>
							{expanded === preset.id && (
								<div
									className="mt-4 overflow-x-auto border-t pt-3"
									style={{ borderColor: "var(--console-border)" }}
								>
									<table className="w-full min-w-[520px] text-left text-xs">
										<thead className="console-muted">
											<tr>
												<th className="py-2">{t("version")}</th>
												<th>{t("createdAt")}</th>
												<th>{t("model")}</th>
												<th>{t("actions")}</th>
											</tr>
										</thead>
										<tbody>
											{(versions[preset.id] ?? []).map((version) => (
												<tr
													key={version.id}
													className="border-t"
													style={{ borderColor: "var(--console-border)" }}
												>
													<td className="py-2">
														v{version.version}
														{version.version === preset.designatedVersion
															? ` · ${t("designated")}`
															: ""}
													</td>
													<td>
														{new Date(version.createdAt).toLocaleString()}
													</td>
													<td className="font-mono">
														{typeof version.config?.model === "string"
															? version.config.model
															: "—"}
													</td>
													<td>
														{version.version !== preset.designatedVersion &&
														preset.status === "active" ? (
															<button
																type="button"
																onClick={() =>
																	void designate(preset, version.version)
																}
																className="text-cyan-600"
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
							)}
						</article>
					))
				)}
			</section>
		</div>
	);
}
