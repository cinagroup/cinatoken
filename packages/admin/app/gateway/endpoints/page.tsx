"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
	ArrowPathIcon,
	CheckCircleIcon,
	ExclamationTriangleIcon,
	LinkIcon,
	PencilSquareIcon,
	PlusIcon,
	TrashIcon,
	XMarkIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import {
	deleteEndpoint,
	endpointToForm,
	loadEndpointWorkspace,
	previewAudioCapabilitiesJson,
	saveEndpoint,
	setEndpointRouteLink,
	summarizeAudioCapabilities,
	type AudioCapabilitySummary,
} from "./endpoint-api";
import {
	EMPTY_ENDPOINT_FORM,
	type EndpointFormState,
	type EndpointListItem,
	type EndpointModelOption,
	type EndpointProviderOption,
	type EndpointRouteOption,
	type TriState,
} from "./types";

const inputClass =
	"mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100 disabled:cursor-not-allowed disabled:bg-gray-100";
const labelClass =
	"block text-xs font-semibold uppercase tracking-wide text-gray-600";

function providerSlug(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
}

function TriStateSelect({
	label,
	value,
	onChange,
}: {
	label: string;
	value: TriState;
	onChange: (value: TriState) => void;
}) {
	const t = useTranslations("endpoints");
	return (
		<label className={labelClass}>
			{label}
			<select
				className={inputClass}
				value={value}
				onChange={(event) => onChange(event.target.value as TriState)}
			>
				<option value="unknown">{t("unknown")}</option>
				<option value="true">{t("supported")}</option>
				<option value="false">{t("unsupported")}</option>
			</select>
		</label>
	);
}

function EndpointBadge({
	endpoint,
	asOf,
}: {
	endpoint: EndpointListItem;
	asOf: number;
}) {
	const t = useTranslations("endpoints");
	const expired =
		endpoint.expires_at != null &&
		Date.parse(endpoint.expires_at) <= asOf;
	const style = expired
		? "bg-amber-50 text-amber-800 ring-amber-200"
		: endpoint.status === "verified"
		? "bg-emerald-50 text-emerald-700 ring-emerald-200"
		: endpoint.status === "disabled"
		? "bg-gray-100 text-gray-600 ring-gray-200"
		: "bg-blue-50 text-blue-700 ring-blue-200";
	return (
		<span
			className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ring-1 ring-inset ${style}`}
		>
			{expired ? t("expired") : t(`statuses.${endpoint.status}`)}
		</span>
	);
}

function AudioCapabilitySummaryList({
	summary,
	compact = false,
}: {
	summary: AudioCapabilitySummary[];
	compact?: boolean;
}) {
	const t = useTranslations("endpoints");
	if (summary.length === 0) {
		return <span className="text-xs text-gray-400">{t("audioCapabilitiesEmpty")}</span>;
	}
	const visible = compact ? summary.slice(0, 2) : summary;
	return (
		<div className="flex flex-wrap gap-1.5">
			{visible.map((item) => (
				<span
					key={item.operation}
					title={`${item.operation} · ${item.meterKind} · ${item.unit}`}
					className="inline-flex max-w-full items-center gap-1 rounded-md bg-cyan-50 px-2 py-1 text-[11px] font-medium text-cyan-900 ring-1 ring-inset ring-cyan-200"
				>
					<span className="truncate font-mono">{item.operation}</span>
					<span aria-hidden="true">·</span>
					<span className="shrink-0">{t(`audioMeters.${item.meterKind}`)}</span>
					<span aria-hidden="true">·</span>
					<span className="shrink-0">{t(`audioUnits.${item.unit}`)}</span>
				</span>
			))}
			{compact && summary.length > visible.length ? (
				<span className="inline-flex items-center rounded-md bg-gray-100 px-2 py-1 text-[11px] font-medium text-gray-600">
					{t("audioMoreOperations", {
						count: summary.length - visible.length,
					})}
				</span>
			) : null}
		</div>
	);
}

function EndpointFormDialog({
	editing,
	form,
	models,
	providers,
	routes,
	saving,
	error,
	linkBusy,
	onChange,
	onClose,
	onSave,
	onDelete,
	onToggleRoute,
}: {
	editing: EndpointListItem | null;
	form: EndpointFormState;
	models: EndpointModelOption[];
	providers: EndpointProviderOption[];
	routes: EndpointRouteOption[];
	saving: boolean;
	error: string | null;
	linkBusy: string | null;
	onChange: (patch: Partial<EndpointFormState>) => void;
	onClose: () => void;
	onSave: () => void;
	onDelete: () => void;
	onToggleRoute: (routeId: string, linked: boolean) => void;
}) {
	const t = useTranslations("endpoints");
	const tCommon = useTranslations("common");
	const eligibleRoutes = useMemo(
		() =>
			routes.filter(
				(route) =>
					route.model_id === form.model_id &&
					route.provider_id === form.provider_id
			),
		[form.model_id, form.provider_id, routes]
	);
	const audioPreview = useMemo(
		() => previewAudioCapabilitiesJson(form.audio_capabilities_json),
		[form.audio_capabilities_json]
	);
	const linked = new Set(editing?.route_target_ids ?? []);

	return (
		<div
			className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/55 p-4 backdrop-blur-sm sm:p-8"
			role="presentation"
		>
			<div
				className="w-full max-w-5xl overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/10"
				role="dialog"
				aria-modal="true"
				aria-labelledby="endpoint-dialog-title"
			>
				<header className="flex items-start justify-between border-b border-gray-200 px-5 py-4 sm:px-7">
					<div>
						<h2
							id="endpoint-dialog-title"
							className="text-xl font-bold text-gray-950"
						>
							{editing ? t("editTitle") : t("createTitle")}
						</h2>
						<p className="mt-1 text-sm text-gray-500">
							{t("dialogDescription")}
						</p>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="rounded-lg p-2 text-gray-500 hover:bg-gray-100"
						aria-label={tCommon("close")}
					>
						<XMarkIcon className="h-5 w-5" />
					</button>
				</header>

				<div className="max-h-[72vh] space-y-7 overflow-y-auto px-5 py-6 sm:px-7">
					{error ? (
						<div className="flex gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
							<ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0" />
							<span>{error}</span>
						</div>
					) : null}

					<section>
						<h3 className="text-sm font-bold text-gray-900">
							{t("sections.identity")}
						</h3>
						<div className="mt-3 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
							<label className={labelClass}>
								{t("fields.model")}
								<select
									className={inputClass}
									disabled={Boolean(editing)}
									value={form.model_id}
									onChange={(event) =>
										onChange({ model_id: event.target.value })
									}
								>
									<option value="">{t("selectModel")}</option>
									{models.map((model) => (
										<option key={model.id} value={model.id}>
											{model.display_name || model.id}
										</option>
									))}
								</select>
							</label>
							<label className={labelClass}>
								{t("fields.provider")}
								<select
									className={inputClass}
									disabled={Boolean(editing)}
									value={form.provider_id}
									onChange={(event) => {
										const id = event.target.value;
										const provider = providers.find((item) => item.id === id);
										onChange({
											provider_id: id,
											...(form.provider_slug
												? {}
												: {
														provider_slug: providerSlug(provider?.name || id),
												  }),
										});
									}}
								>
									<option value="">{t("selectProvider")}</option>
									{providers.map((provider) => (
										<option key={provider.id} value={provider.id}>
											{provider.name || provider.id}
										</option>
									))}
								</select>
							</label>
							<label className={labelClass}>
								{t("fields.providerSlug")}
								<input
									className={inputClass}
									value={form.provider_slug}
									onChange={(event) =>
										onChange({ provider_slug: event.target.value })
									}
								/>
							</label>
							<label className={labelClass}>
								{t("fields.tag")}
								<input
									className={inputClass}
									value={form.tag}
									onChange={(event) => onChange({ tag: event.target.value })}
								/>
							</label>
							<label className={labelClass}>
								{t("fields.endpointClass")}
								<select
									className={inputClass}
									value={form.endpoint_class}
									onChange={(event) =>
										onChange({
											endpoint_class: event.target
												.value as EndpointFormState["endpoint_class"],
										})
									}
								>
									<option value="standard">standard</option>
									<option value="service_tier">service_tier</option>
								</select>
							</label>
							<label className={labelClass}>
								{t("fields.region")}
								<input
									className={inputClass}
									value={form.region}
									onChange={(event) => onChange({ region: event.target.value })}
									placeholder="us"
								/>
							</label>
						</div>
					</section>

					<section>
						<h3 className="text-sm font-bold text-gray-900">
							{t("sections.capacity")}
						</h3>
						<div className="mt-3 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
							{(
								[
									["context_length", t("fields.contextLength")],
									["max_prompt_tokens", t("fields.maxPromptTokens")],
									["max_completion_tokens", t("fields.maxCompletionTokens")],
								] as const
							).map(([key, label]) => (
								<label key={key} className={labelClass}>
									{label}
									<input
										type="number"
										min="1"
										step="1"
										className={inputClass}
										value={form[key]}
										onChange={(event) =>
											onChange({ [key]: event.target.value })
										}
									/>
								</label>
							))}
							<label className={labelClass}>
								{t("fields.quantization")}
								<input
									className={inputClass}
									value={form.quantization}
									onChange={(event) =>
										onChange({ quantization: event.target.value })
									}
									placeholder="fp16"
								/>
							</label>
						</div>
						<label className={`${labelClass} mt-4`}>
							{t("fields.supportedParameters")}
							<textarea
								rows={2}
								className={inputClass}
								value={form.supported_parameters}
								onChange={(event) =>
									onChange({ supported_parameters: event.target.value })
								}
								placeholder="temperature, tools, tool_choice"
							/>
						</label>
					</section>

					<section>
						<h3 className="text-sm font-bold text-gray-900">
							{t("sections.audioPricing")}
						</h3>
						<label className={`${labelClass} mt-4`}>
							{t("fields.audioCapabilities")}
							<textarea
								rows={12}
								className={`${inputClass} font-mono text-xs ${
									audioPreview.ok
										? ""
										: "border-red-400 focus:border-red-500 focus:ring-red-100"
								}`}
								value={form.audio_capabilities_json}
								onChange={(event) =>
									onChange({ audio_capabilities_json: event.target.value })
								}
								placeholder={t("audioCapabilitiesPlaceholder")}
								aria-invalid={!audioPreview.ok}
								aria-describedby="audio-capabilities-feedback"
							/>
						</label>
						<div id="audio-capabilities-feedback" className="mt-2">
							{audioPreview.ok ? (
								audioPreview.summary.length > 0 ? (
									<div className="rounded-lg border border-cyan-200 bg-cyan-50/60 p-3">
										<p className="mb-2 text-xs font-semibold text-cyan-950">
											{t("audioCapabilitiesSummary", {
												count: audioPreview.summary.length,
											})}
										</p>
										<AudioCapabilitySummaryList summary={audioPreview.summary} />
									</div>
								) : (
									<p className="text-xs text-gray-500">
										{t("audioCapabilitiesHint")}
									</p>
								)
							) : (
								<p className="text-xs font-medium text-red-700" role="alert">
									{t("audioCapabilitiesInvalid", {
										message: audioPreview.message,
									})}
								</p>
							)}
						</div>
					</section>

					<section>
						<h3 className="text-sm font-bold text-gray-900">
							{t("sections.pricing")}
						</h3>
						<p className="mt-1 text-xs text-gray-500">{t("pricingHint")}</p>
						<div className="mt-3 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
							{(
								[
									["prompt_price", t("fields.promptPrice")],
									["completion_price", t("fields.completionPrice")],
									["request_price", t("fields.requestPrice")],
									["image_price", t("fields.imagePrice")],
									["image_output_price", t("fields.imageOutputPrice")],
									["input_cache_read_price", t("fields.cacheReadPrice")],
									["input_cache_write_price", t("fields.cacheWritePrice")],
								] as const
							).map(([key, label]) => (
								<label key={key} className={labelClass}>
									{label}
									<input
										inputMode="decimal"
										className={inputClass}
										value={form[key]}
										onChange={(event) =>
											onChange({ [key]: event.target.value })
										}
										placeholder="0.000001"
									/>
								</label>
							))}
						</div>
						<label className={`${labelClass} mt-4`}>
							{t("fields.additionalPricing")}
							<textarea
								rows={5}
								className={`${inputClass} font-mono text-xs`}
								value={form.pricing_extras_json}
								onChange={(event) =>
									onChange({ pricing_extras_json: event.target.value })
								}
								placeholder={t("additionalPricingPlaceholder")}
							/>
						</label>
					</section>

					<section>
						<h3 className="text-sm font-bold text-gray-900">
							{t("sections.capabilities")}
						</h3>
						<div className="mt-3 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
							<TriStateSelect
								label={t("fields.implicitCaching")}
								value={form.implicit_caching}
								onChange={(value) => onChange({ implicit_caching: value })}
							/>
							<TriStateSelect
								label={t("fields.voiceCloning")}
								value={form.voice_cloning}
								onChange={(value) => onChange({ voice_cloning: value })}
							/>
							<TriStateSelect
								label="tool_choice.auto"
								value={form.tool_choice_auto}
								onChange={(value) => onChange({ tool_choice_auto: value })}
							/>
							<TriStateSelect
								label="tool_choice.function"
								value={form.tool_choice_function}
								onChange={(value) => onChange({ tool_choice_function: value })}
							/>
							<TriStateSelect
								label="tool_choice.none"
								value={form.tool_choice_none}
								onChange={(value) => onChange({ tool_choice_none: value })}
							/>
							<TriStateSelect
								label="tool_choice.required"
								value={form.tool_choice_required}
								onChange={(value) => onChange({ tool_choice_required: value })}
							/>
						</div>
						<label className={`${labelClass} mt-4`}>
							{t("fields.imageCapabilities")}
							<textarea
								rows={8}
								className={`${inputClass} font-mono text-xs`}
								value={form.image_capabilities_json}
								onChange={(event) =>
									onChange({ image_capabilities_json: event.target.value })
								}
								placeholder={t("imageCapabilitiesPlaceholder")}
							/>
						</label>
					</section>

					<section>
						<h3 className="text-sm font-bold text-gray-900">
							{t("sections.verification")}
						</h3>
						<p className="mt-1 text-xs text-gray-500">
							{t("verificationHint")}
						</p>
						<div className="mt-3 grid gap-4 md:grid-cols-3">
							<label className={`${labelClass} md:col-span-2`}>
								{t("fields.evidenceUrl")}
								<input
									type="url"
									className={inputClass}
									value={form.evidence_url}
									onChange={(event) =>
										onChange({ evidence_url: event.target.value })
									}
									placeholder="https://provider.example/pricing"
								/>
							</label>
							<label className={labelClass}>
								{t("fields.expiresAt")}
								<input
									type="datetime-local"
									className={inputClass}
									value={form.expires_at}
									onChange={(event) =>
										onChange({ expires_at: event.target.value })
									}
								/>
							</label>
							<label className={labelClass}>
								{tCommon("status")}
								<select
									className={inputClass}
									value={form.status}
									onChange={(event) =>
										onChange({
											status: event.target.value as EndpointFormState["status"],
										})
									}
								>
									<option value="draft">{t("statuses.draft")}</option>
									<option value="verified">{t("statuses.verified")}</option>
									<option value="disabled">{t("statuses.disabled")}</option>
								</select>
							</label>
						</div>
					</section>

					{editing ? (
						<section>
							<h3 className="text-sm font-bold text-gray-900">
								{t("sections.routes")}
							</h3>
							<p className="mt-1 text-xs text-gray-500">{t("routeHint")}</p>
							<div className="mt-3 divide-y divide-gray-200 overflow-hidden rounded-xl border border-gray-200">
								{eligibleRoutes.length === 0 ? (
									<p className="px-4 py-5 text-sm text-gray-500">
										{t("noEligibleRoutes")}
									</p>
								) : (
									eligibleRoutes.map((route) => {
										const checked = linked.has(route.id);
										return (
											<label
												key={route.id}
												className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3 hover:bg-gray-50"
											>
												<span className="min-w-0">
													<span className="block truncate text-sm font-medium text-gray-900">
														{route.provider_model_name || route.id}
													</span>
													<span className="block truncate font-mono text-xs text-gray-500">
														{route.id}
													</span>
												</span>
												<input
													type="checkbox"
													className="h-4 w-4 rounded border-gray-300 text-cyan-600"
													checked={checked}
													disabled={linkBusy === route.id}
													onChange={(event) =>
														onToggleRoute(route.id, event.target.checked)
													}
												/>
											</label>
										);
									})
								)}
							</div>
						</section>
					) : null}
				</div>

				<footer className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 bg-gray-50 px-5 py-4 sm:px-7">
					<div>
						{editing ? (
							<button
								type="button"
								onClick={onDelete}
								disabled={saving}
								className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
							>
								<TrashIcon className="h-4 w-4" />
								{tCommon("delete")}
							</button>
						) : null}
					</div>
					<div className="flex gap-2">
						<button
							type="button"
								onClick={onClose}
							disabled={saving}
							className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
						>
							{tCommon("cancel")}
						</button>
						<button
							type="button"
							onClick={onSave}
							disabled={saving || !audioPreview.ok}
							className="rounded-lg bg-gray-950 px-4 py-2 text-sm font-semibold text-white hover:bg-black disabled:opacity-50"
						>
							{saving ? tCommon("saving") : tCommon("save")}
						</button>
					</div>
				</footer>
			</div>
		</div>
	);
}

export default function ModelEndpointsPage() {
	const t = useTranslations("endpoints");
	const tCommon = useTranslations("common");
	const [endpoints, setEndpoints] = useState<EndpointListItem[]>([]);
	const [catalogAsOf, setCatalogAsOf] = useState(0);
	const [models, setModels] = useState<EndpointModelOption[]>([]);
	const [providers, setProviders] = useState<EndpointProviderOption[]>([]);
	const [routes, setRoutes] = useState<EndpointRouteOption[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<EndpointListItem | null>(null);
	const [form, setForm] = useState<EndpointFormState>({
		...EMPTY_ENDPOINT_FORM,
	});
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [linkBusy, setLinkBusy] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setLoadError(null);
		try {
			const workspace = await loadEndpointWorkspace();
			setCatalogAsOf(Date.now());
			setEndpoints(workspace.endpoints);
			setModels(workspace.models);
			setProviders(workspace.providers);
			setRoutes(workspace.routes);
		} catch (error) {
			setLoadError(
				error instanceof Error ? error.message : tCommon("requestFailed")
			);
		} finally {
			setLoading(false);
		}
	}, [tCommon]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const modelNames = useMemo(
		() =>
			new Map(
				models.map((model) => [model.id, model.display_name || model.id])
			),
		[models]
	);
	const providerNames = useMemo(
		() =>
			new Map(
				providers.map((provider) => [provider.id, provider.name || provider.id])
			),
		[providers]
	);

	function openCreate() {
		setEditing(null);
		setForm({ ...EMPTY_ENDPOINT_FORM });
		setSaveError(null);
		setDialogOpen(true);
	}

	function openEdit(endpoint: EndpointListItem) {
		setEditing(endpoint);
		setForm(endpointToForm(endpoint));
		setSaveError(null);
		setDialogOpen(true);
	}

	async function handleSave() {
		setSaving(true);
		setSaveError(null);
		try {
			await saveEndpoint(form, editing?.id);
			setDialogOpen(false);
			setEditing(null);
			await refresh();
		} catch (error) {
			setSaveError(
				error instanceof Error ? error.message : tCommon("saveFailed")
			);
		} finally {
			setSaving(false);
		}
	}

	async function handleDelete() {
		if (!editing || !window.confirm(t("confirmDelete"))) return;
		setSaving(true);
		setSaveError(null);
		try {
			await deleteEndpoint(editing.id);
			setDialogOpen(false);
			setEditing(null);
			await refresh();
		} catch (error) {
			setSaveError(
				error instanceof Error ? error.message : tCommon("requestFailed")
			);
		} finally {
			setSaving(false);
		}
	}

	async function handleToggleRoute(routeId: string, checked: boolean) {
		if (!editing) return;
		setLinkBusy(routeId);
		setSaveError(null);
		try {
			await setEndpointRouteLink(editing.id, routeId, checked);
			const routeIds = checked
				? [...new Set([...editing.route_target_ids, routeId])]
				: editing.route_target_ids.filter((id) => id !== routeId);
			const updated = { ...editing, route_target_ids: routeIds };
			setEditing(updated);
			setEndpoints((current) =>
				current.map((endpoint) =>
					endpoint.id === updated.id ? updated : endpoint
				)
			);
		} catch (error) {
			setSaveError(
				error instanceof Error ? error.message : tCommon("requestFailed")
			);
		} finally {
			setLinkBusy(null);
		}
	}

	return (
		<div className="min-h-full bg-gray-100/90 p-4 pb-8 sm:p-6 lg:p-8">
			<div className="mx-auto max-w-7xl">
				<header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
					<div>
						<h1 className="text-2xl font-bold text-gray-950 sm:text-3xl">
							{t("title")}
						</h1>
						<p className="mt-1 max-w-3xl text-sm text-gray-500">
							{t("subtitle")}
						</p>
					</div>
					<div className="flex gap-2">
						<button
							type="button"
							onClick={() => void refresh()}
							className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
						>
							<ArrowPathIcon className="h-4 w-4" />
							{t("refresh")}
						</button>
						<button
							type="button"
							onClick={openCreate}
							className="inline-flex items-center gap-2 rounded-lg bg-gray-950 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-black"
						>
							<PlusIcon className="h-4 w-4" />
							{t("newEndpoint")}
						</button>
					</div>
				</header>

				<div className="mt-6 grid gap-3 sm:grid-cols-3">
					<div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
						<p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
							{t("metrics.total")}
						</p>
						<p className="mt-1 text-2xl font-bold text-gray-950">
							{endpoints.length}
						</p>
					</div>
					<div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
						<p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
							{t("metrics.verified")}
						</p>
						<p className="mt-1 text-2xl font-bold text-emerald-700">
							{
								endpoints.filter(
									(endpoint) =>
									endpoint.status === "verified" &&
									(!endpoint.expires_at ||
										Date.parse(endpoint.expires_at) > catalogAsOf)
								).length
							}
						</p>
					</div>
					<div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
						<p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
							{t("metrics.linked")}
						</p>
						<p className="mt-1 text-2xl font-bold text-cyan-700">
							{
								endpoints.filter(
									(endpoint) => endpoint.route_target_ids.length > 0
								).length
							}
						</p>
					</div>
				</div>

				{loadError ? (
					<div className="mt-6 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
						<ExclamationTriangleIcon className="h-5 w-5" />
						{loadError}
					</div>
				) : null}

				<div className="mt-6 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
					{loading ? (
						<div className="flex min-h-52 items-center justify-center text-sm text-gray-500">
							{tCommon("loading")}
						</div>
					) : endpoints.length === 0 ? (
						<div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
							<LinkIcon className="h-10 w-10 text-gray-300" />
							<h2 className="mt-3 text-base font-bold text-gray-900">
								{t("emptyTitle")}
							</h2>
							<p className="mt-1 max-w-md text-sm text-gray-500">
								{t("emptyDescription")}
							</p>
						</div>
					) : (
						<div className="overflow-x-auto">
							<table className="min-w-[980px] divide-y divide-gray-200 text-left text-sm">
								<thead className="bg-gray-50 text-xs font-semibold uppercase tracking-wide text-gray-500">
									<tr>
										<th className="px-5 py-3">{t("columns.endpoint")}</th>
										<th className="px-5 py-3">{t("columns.modelProvider")}</th>
									<th className="px-5 py-3">{t("columns.capacity")}</th>
									<th className="px-5 py-3">{t("columns.audioPricing")}</th>
									<th className="px-5 py-3">{t("columns.routes")}</th>
										<th className="px-5 py-3">{tCommon("status")}</th>
										<th className="px-5 py-3 text-right">
											{tCommon("actions")}
										</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-gray-100">
									{endpoints.map((endpoint) => (
										<tr key={endpoint.id} className="hover:bg-gray-50/70">
											<td className="px-5 py-4">
												<div className="font-semibold text-gray-950">
													{endpoint.tag}
												</div>
												<div className="mt-1 font-mono text-xs text-gray-500">
													{endpoint.provider_slug}
													{endpoint.region ? ` · ${endpoint.region}` : ""}
												</div>
											</td>
											<td className="px-5 py-4">
												<div className="font-medium text-gray-900">
													{modelNames.get(endpoint.model_id) ||
														endpoint.model_id}
												</div>
												<div className="mt-1 text-xs text-gray-500">
													{providerNames.get(endpoint.provider_id) ||
														endpoint.provider_id}
												</div>
											</td>
										<td className="px-5 py-4 tabular-nums text-gray-700">
												{endpoint.context_length?.toLocaleString() ?? "—"}
												<div className="mt-1 text-xs text-gray-500">
													{endpoint.quantization ?? tCommon("unknown")}
												</div>
										</td>
										<td className="max-w-[22rem] px-5 py-4">
											<AudioCapabilitySummaryList
												summary={summarizeAudioCapabilities(
													endpoint.audio_capabilities
												)}
												compact
											/>
										</td>
											<td className="px-5 py-4">
												<span className="inline-flex items-center gap-1.5 text-gray-700">
													{endpoint.route_target_ids.length > 0 ? (
														<CheckCircleIcon className="h-4 w-4 text-emerald-600" />
													) : (
														<ExclamationTriangleIcon className="h-4 w-4 text-amber-500" />
													)}
													{t("routeCount", {
														count: endpoint.route_target_ids.length,
													})}
												</span>
											</td>
											<td className="px-5 py-4">
											<EndpointBadge endpoint={endpoint} asOf={catalogAsOf} />
											</td>
											<td className="px-5 py-4 text-right">
												<button
													type="button"
													onClick={() => openEdit(endpoint)}
													className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
												>
													<PencilSquareIcon className="h-4 w-4" />
													{t("edit")}
												</button>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>
			</div>

			{dialogOpen ? (
				<EndpointFormDialog
					editing={editing}
					form={form}
					models={models}
					providers={providers}
					routes={routes}
					saving={saving}
					error={saveError}
					linkBusy={linkBusy}
					onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
					onClose={() => setDialogOpen(false)}
					onSave={() => void handleSave()}
					onDelete={() => void handleDelete()}
					onToggleRoute={(routeId, checked) =>
						void handleToggleRoute(routeId, checked)
					}
				/>
			) : null}
		</div>
	);
}
