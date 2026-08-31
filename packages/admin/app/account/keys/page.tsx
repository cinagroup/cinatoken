"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { readPortalJson } from "@/lib/portal-fetch";
import GatewayKeyManager from "@/components/portal/GatewayKeyManager";
import ManagementKeyManager from "@/components/portal/ManagementKeyManager";

type Channel = {
	channelType: string;
	label: string;
	modelsUrl: string | null;
};

type ChannelLimits = {
	maxInputPrice: number;
	maxOutputPrice: number;
	commissionRate: number;
};

type SharedKeyRow = {
	id: string;
	channelType: string;
	label: string | null;
	apiKeyMasked: string;
	keyFingerprint: string;
	status: string;
	weight: number;
	inputPrice: number;
	outputPrice: number;
	servedInputTokens: number;
	servedOutputTokens: number;
	earnedTotal: number;
	lastUsedAt: string | null;
	failureReason: string | null;
};

const STATUS_STYLES: Record<string, string> = {
	validating: "bg-yellow-50 text-yellow-700",
	active: "bg-green-50 text-green-700",
	paused: "bg-gray-100 text-gray-600",
	invalid: "bg-red-50 text-red-700",
	disabled: "bg-gray-100 text-gray-500",
};

export default function AccountKeysPage() {
	const t = useTranslations("portal");
	const [channels, setChannels] = useState<Channel[]>([]);
	const [limits, setLimits] = useState<ChannelLimits | null>(null);
	const [rows, setRows] = useState<SharedKeyRow[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [message, setMessage] = useState<{
		kind: "ok" | "err";
		text: string;
	} | null>(null);
	const [revealedKey, setRevealedKey] = useState<string | null>(null);

	const [form, setForm] = useState({
		channelType: "",
		apiKey: "",
		label: "",
		weight: "10",
		inputPrice: "",
		outputPrice: "",
	});

	const load = useCallback(async () => {
		try {
			const [channelsRes, keysRes] = await Promise.all([
				fetch("/api/user/shared-keys/channels", { cache: "no-store" }),
				fetch("/api/user/shared-keys", { cache: "no-store" }),
			]);
			const channelsData = await readPortalJson<{
				channels: Channel[];
				limits: ChannelLimits;
			}>(channelsRes);
			const keysData = await readPortalJson<SharedKeyRow[]>(keysRes);
			if (channelsData?.success) {
				setChannels(channelsData.data?.channels ?? []);
				setLimits(channelsData.data?.limits ?? null);
				setForm((prev) => ({
					...prev,
					channelType:
						prev.channelType ||
						channelsData.data?.channels?.[0]?.channelType ||
						"",
				}));
			}
			if (keysData?.success) setRows(keysData.data ?? []);
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setIsSubmitting(true);
		setMessage(null);
		setRevealedKey(null);
		try {
			const response = await fetch("/api/user/shared-keys", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					channelType: form.channelType,
					apiKey: form.apiKey,
					label: form.label || null,
					weight: Number(form.weight) || 1,
					inputPrice: Number(form.inputPrice),
					outputPrice: Number(form.outputPrice),
				}),
			});
			const data = await readPortalJson<
				SharedKeyRow & {
					apiKey: string;
					validation: string;
					validationReason: string | null;
				}
			>(response);
			if (!response.ok || !data?.success) {
				setMessage({
					kind: "err",
					text: data?.message ?? t("keys.submitFailed"),
				});
				return;
			}
			setRevealedKey(data.data?.apiKey ?? null);
			setMessage({
				kind: "ok",
				text:
					data.data?.validation === "active"
						? t("keys.createdActive")
						: data.data?.validation === "invalid"
						? t("keys.createdInvalid", {
								reason: data.data?.validationReason ?? "",
						  })
						: t("keys.createdValidating"),
			});
			setForm((prev) => ({ ...prev, apiKey: "", label: "" }));
			await load();
		} finally {
			setIsSubmitting(false);
		}
	};

	const patchKey = async (id: string, patch: Record<string, unknown>) => {
		const response = await fetch(`/api/user/shared-keys/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(patch),
		});
		const data = await readPortalJson<SharedKeyRow>(response);
		if (!response.ok || !data?.success) {
			setMessage({
				kind: "err",
				text: data?.message ?? t("keys.updateFailed"),
			});
			return;
		}
		setMessage({ kind: "ok", text: t("keys.updated") });
		await load();
	};

	const revalidate = async (id: string) => {
		const response = await fetch(`/api/user/shared-keys/${id}/revalidate`, {
			method: "POST",
		});
		const data = await readPortalJson<SharedKeyRow>(response);
		if (!response.ok || !data?.success) {
			setMessage({
				kind: "err",
				text: data?.message ?? t("keys.updateFailed"),
			});
			return;
		}
		setMessage({ kind: "ok", text: t("keys.revalidated") });
		await load();
	};

	const removeKey = async (id: string) => {
		if (!window.confirm(t("keys.confirmDelete"))) return;
		const response = await fetch(`/api/user/shared-keys/${id}`, {
			method: "DELETE",
		});
		if (response.ok) {
			setMessage({ kind: "ok", text: t("keys.deleted") });
			await load();
		}
	};

	return (
		<div className="space-y-6">
			<GatewayKeyManager />
			<ManagementKeyManager />
			<div>
				<h1 className="text-2xl font-bold text-gray-800">{t("keys.title")}</h1>
				<p className="mt-1 text-sm text-gray-500">{t("keys.subtitle")}</p>
			</div>

			{message && (
				<div
					className={`rounded-md border p-3 text-sm ${
						message.kind === "ok"
							? "border-green-200 bg-green-50 text-green-700"
							: "border-red-200 bg-red-50 text-red-700"
					}`}
				>
					{message.text}
					{revealedKey && (
						<div className="mt-2 break-all rounded bg-white/70 px-2 py-1 font-mono text-xs">
							{revealedKey}
						</div>
					)}
				</div>
			)}

			<form
				onSubmit={submit}
				className="space-y-4 rounded-lg border border-gray-200 bg-white p-4"
			>
				<div className="text-sm font-medium text-gray-700">
					{t("keys.formTitle")}
				</div>
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					<label className="space-y-1">
						<span className="text-xs text-gray-500">{t("keys.channel")}</span>
						<select
							value={form.channelType}
							onChange={(event) =>
								setForm((prev) => ({
									...prev,
									channelType: event.target.value,
								}))
							}
							className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
							required
						>
							{channels.map((channel) => (
								<option key={channel.channelType} value={channel.channelType}>
									{channel.label}
								</option>
							))}
						</select>
					</label>
					<label className="space-y-1 lg:col-span-2">
						<span className="text-xs text-gray-500">{t("keys.apiKey")}</span>
						<input
							value={form.apiKey}
							onChange={(event) =>
								setForm((prev) => ({ ...prev, apiKey: event.target.value }))
							}
							placeholder={t("keys.apiKeyPlaceholder")}
							className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm"
							required
						/>
					</label>
					<label className="space-y-1">
						<span className="text-xs text-gray-500">
							{t("keys.labelOptional")}
						</span>
						<input
							value={form.label}
							onChange={(event) =>
								setForm((prev) => ({ ...prev, label: event.target.value }))
							}
							className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
						/>
					</label>
					<label className="space-y-1">
						<span className="text-xs text-gray-500">
							{t("keys.inputPrice")}（$/1M）
						</span>
						<input
							type="number"
							min="0"
							step="0.0001"
							max={limits?.maxInputPrice}
							value={form.inputPrice}
							onChange={(event) =>
								setForm((prev) => ({ ...prev, inputPrice: event.target.value }))
							}
							className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
							required
						/>
					</label>
					<label className="space-y-1">
						<span className="text-xs text-gray-500">
							{t("keys.outputPrice")}（$/1M）
						</span>
						<input
							type="number"
							min="0"
							step="0.0001"
							max={limits?.maxOutputPrice}
							value={form.outputPrice}
							onChange={(event) =>
								setForm((prev) => ({
									...prev,
									outputPrice: event.target.value,
								}))
							}
							className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
							required
						/>
					</label>
					<label className="space-y-1">
						<span className="text-xs text-gray-500">{t("keys.weight")}</span>
						<input
							type="number"
							min="1"
							max="100"
							value={form.weight}
							onChange={(event) =>
								setForm((prev) => ({ ...prev, weight: event.target.value }))
							}
							className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
						/>
						<span className="text-[11px] text-gray-400">
							{t("keys.weightHint")}
						</span>
					</label>
				</div>
				{limits && (
					<div className="text-xs text-gray-400">
						{t("keys.limitsHint", {
							input: limits.maxInputPrice,
							output: limits.maxOutputPrice,
							commission: Math.round(limits.commissionRate * 100),
						})}
					</div>
				)}
				<button
					type="submit"
					disabled={isSubmitting || !form.channelType}
					className="rounded-md bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
				>
					{isSubmitting ? t("common.submitting") : t("keys.submit")}
				</button>
			</form>

			<div className="rounded-lg border border-gray-200 bg-white">
				{isLoading ? (
					<div className="px-4 py-8 text-center text-sm text-gray-500">
						{t("common.loading")}
					</div>
				) : rows.length === 0 ? (
					<div className="px-4 py-8 text-center text-sm text-gray-500">
						{t("keys.empty")}
					</div>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-gray-100 text-left text-xs text-gray-500">
									<th className="px-4 py-2">{t("keys.channel")}</th>
									<th className="px-4 py-2">{t("keys.key")}</th>
									<th className="px-4 py-2">{t("keys.status")}</th>
									<th className="px-4 py-2">{t("keys.pricing")}</th>
									<th className="px-4 py-2">{t("keys.weight")}</th>
									<th className="px-4 py-2">{t("keys.usage")}</th>
									<th className="px-4 py-2">{t("keys.actions")}</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((row) => (
									<tr
										key={row.id}
										className="border-b border-gray-50 align-top last:border-0"
									>
										<td className="px-4 py-3">
											<div className="font-medium text-gray-700">
												{row.channelType}
											</div>
											{row.label && (
												<div className="text-xs text-gray-400">{row.label}</div>
											)}
										</td>
										<td className="px-4 py-3 font-mono text-xs text-gray-500">
											{row.apiKeyMasked}
										</td>
										<td className="px-4 py-3">
											<span
												className={`rounded-full px-2 py-0.5 text-xs ${
													STATUS_STYLES[row.status] ??
													"bg-gray-100 text-gray-600"
												}`}
											>
												{t(`keys.status_${row.status}`)}
											</span>
											{row.failureReason && (
												<div className="mt-1 max-w-48 text-[11px] text-red-400">
													{row.failureReason}
												</div>
											)}
										</td>
										<td className="px-4 py-3 text-xs text-gray-600">
											{t("keys.priceCell", {
												input: row.inputPrice,
												output: row.outputPrice,
											})}
										</td>
										<td className="px-4 py-3 text-gray-700">{row.weight}</td>
										<td className="px-4 py-3 text-xs text-gray-600">
											<div>
												{t("keys.tokensCell", {
													input: (row.servedInputTokens ?? 0).toLocaleString(),
													output: (
														row.servedOutputTokens ?? 0
													).toLocaleString(),
												})}
											</div>
											<div className="text-gray-400">
												${(row.earnedTotal ?? 0).toFixed(4)}
											</div>
										</td>
										<td className="px-4 py-3">
											<div className="flex flex-wrap gap-2 text-xs">
												{row.status === "active" && (
													<button
														type="button"
														onClick={() =>
															void patchKey(row.id, { status: "paused" })
														}
														className="rounded border border-gray-300 px-2 py-1 text-gray-600 hover:bg-gray-50"
													>
														{t("keys.pause")}
													</button>
												)}
												{row.status === "paused" && (
													<button
														type="button"
														onClick={() =>
															void patchKey(row.id, { status: "active" })
														}
														className="rounded border border-cyan-300 px-2 py-1 text-cyan-700 hover:bg-cyan-50"
													>
														{t("keys.resume")}
													</button>
												)}
												{(row.status === "invalid" ||
													row.status === "validating") && (
													<button
														type="button"
														onClick={() => void revalidate(row.id)}
														className="rounded border border-gray-300 px-2 py-1 text-gray-600 hover:bg-gray-50"
													>
														{t("keys.revalidate")}
													</button>
												)}
												<button
													type="button"
													onClick={() => void removeKey(row.id)}
													className="rounded border border-red-200 px-2 py-1 text-red-600 hover:bg-red-50"
												>
													{t("keys.delete")}
												</button>
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</div>
	);
}
