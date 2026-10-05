"use client";

import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type FormEvent,
} from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";
import {
	ADMIN_SESSION_EXPIRED_EVENT_NAME,
	notifyAdminSessionExpired,
} from "@/lib/admin-session-events";
import { subscribeCinaAuthSessionChanges } from "@/lib/cinaauth/session-events";
import type {
	AdminSharedKeyDetail,
	AdminSharedKeysOverview,
	SafeAdminSharedKeyRow,
} from "@/lib/services/admin/shared-key-admin-dto";
import {
	legacySharedKeyAudit,
	legacySharedKeyCanRecover,
	legacySharedKeyClearMarker,
	legacySharedKeyDetail,
	legacySharedKeyHeaders,
	legacySharedKeyMark,
	legacySharedKeyOverview,
	legacySharedKeyQuery,
	legacySharedKeyReadMarker,
	legacySharedKeyRow,
	legacySharedKeyScope,
	legacySharedKeySubject,
	legacySharedKeyWriteBody,
	legacySharedKeyWriteResult,
	type LegacySharedKeyAuditSummary,
	type LegacySharedKeyFilters,
	type LegacySharedKeyMarker,
	type LegacySharedKeyOperation,
} from "@/lib/services/admin/legacy-shared-key-browser";

type Scope = { subject: string; key: string };
type Gate =
	| "checking"
	| "ready"
	| "unverified"
	| "storage"
	| "unknown"
	| "denied";
type Editor =
	| {
			kind: "govern";
			operation: LegacySharedKeyOperation;
			listed: SafeAdminSharedKeyRow;
			detail: AdminSharedKeyDetail | null;
	  }
	| {
			kind: "recover";
			pending: LegacySharedKeyMarker;
			detail: AdminSharedKeyDetail | null;
			missing: boolean;
			ready: boolean;
			entries: LegacySharedKeyAuditSummary[];
			nextCursor: string | null;
	  };
class HttpFailure extends Error {
	constructor(readonly status: number, readonly code: string = "") {
		super("Shared Key request failed");
	}
}
const initialFilters: LegacySharedKeyFilters = {
	page: 1,
	pageSize: 20,
	status: "",
	channelType: "",
	sellerUserId: "",
	search: "",
};
const statuses = [
	"active",
	"validating",
	"paused",
	"invalid",
	"disabled",
] as const;
const channels = ["openai", "anthropic", "zhipu", "deepseek"] as const;
const controlClass =
	"w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-600";
const buttonClass =
	"rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-800 hover:bg-[var(--console-panel-subtle)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-600";

async function json(response: Response): Promise<unknown> {
	const raw = await response.text();
	if (raw.length > 512 * 1024) throw new Error("Oversize response");
	return JSON.parse(raw) as unknown;
}
function envelope(value: unknown): {
	success: boolean;
	data: unknown;
	code: string;
} {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid response");
	const body = value as Record<string, unknown>;
	if (typeof body.success !== "boolean") throw new Error("Invalid response");
	return {
		success: body.success,
		data: body.data,
		code: typeof body.code === "string" ? body.code : "",
	};
}
async function read(url: string, signal: AbortSignal, allowMissing = false) {
	const response = await fetch(url, {
		cache: "no-store",
		credentials: "same-origin",
		redirect: "error",
		signal,
	});
	if (response.status === 401 || response.status === 403)
		throw new HttpFailure(response.status);
	const body = envelope(await json(response));
	if (allowMissing && response.status === 404 && !body.success) return null;
	if (!response.ok || !body.success)
		throw new HttpFailure(response.status, body.code);
	return body.data;
}
async function auth(signal: AbortSignal): Promise<Scope | null> {
	const response = await fetch("/api/auth/check", {
		cache: "no-store",
		credentials: "same-origin",
		redirect: "error",
		signal,
	});
	if (response.status === 401 || response.status === 403)
		throw new HttpFailure(response.status);
	if (!response.ok) throw new Error("Auth verification unavailable");
	const subject = legacySharedKeySubject(await json(response));
	return subject ? { subject, key: await legacySharedKeyScope(subject) } : null;
}

export default function AdminSharedKeysPage() {
	const t = useTranslations("sharedKeysPage");
	const common = useTranslations("common");
	const pathname = usePathname();
	const [filters, setFilters] = useState(initialFilters);
	const [draft, setDraft] = useState(initialFilters);
	const [overview, setOverview] = useState<AdminSharedKeysOverview | null>(
		null
	);
	const [loading, setLoading] = useState(true);
	const [gate, setGate] = useState<Gate>("checking");
	const [pending, setPending] = useState<LegacySharedKeyMarker | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [editor, setEditor] = useState<Editor | null>(null);
	const [editorError, setEditorError] = useState("");
	const [reason, setReason] = useState("");
	const [priority, setPriority] = useState("");
	const [weight, setWeight] = useState("");
	const [acknowledged, setAcknowledged] = useState(false);
	const [busy, setBusy] = useState(false);
	const dialog = useRef<HTMLDialogElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const opener = useRef<HTMLElement | null>(null);
	const firstField = useRef<HTMLInputElement>(null);
	const lifecycle = useRef({
		epoch: 0,
		editorEpoch: 0,
		scope: null as Scope | null,
		controllers: new Set<AbortController>(),
		busy: false,
	});
	const controller = useCallback(() => {
		const current = new AbortController();
		lifecycle.current.controllers.add(current);
		const timeout = window.setTimeout(() => current.abort(), 15_000);
		return {
			current,
			release: () => {
				window.clearTimeout(timeout);
				lifecycle.current.controllers.delete(current);
			},
		};
	}, []);
	const closeEditor = useCallback(() => {
		lifecycle.current.editorEpoch++;
		for (const current of lifecycle.current.controllers) current.abort();
		lifecycle.current.controllers.clear();
		setEditor(null);
		setEditorError("");
		setReason("");
		setPriority("");
		setWeight("");
		setAcknowledged(false);
	}, []);
	const invalidate = useCallback(() => {
		lifecycle.current.epoch++;
		lifecycle.current.editorEpoch++;
		lifecycle.current.scope = null;
		lifecycle.current.busy = false;
		setOverview(null);
		setPending(null);
		setLoading(false);
		setGate("denied");
		setBusy(false);
		closeEditor();
		setNotice("");
	}, [closeEditor]);
	const boundary = useCallback(
		(failure: unknown) => {
			if (
				!(failure instanceof HttpFailure) ||
				![401, 403].includes(failure.status)
			)
				return false;
			invalidate();
			setError(t("permissionLost"));
			if (failure.status === 401) notifyAdminSessionExpired();
			return true;
		},
		[invalidate, t]
	);
	const load = useCallback(async () => {
		const epoch = ++lifecycle.current.epoch;
		closeEditor();
		lifecycle.current.busy = false;
		setBusy(false);
		setOverview(null);
		setError("");
		setLoading(true);
		setGate("checking");
		const request = controller();
		try {
			const url = legacySharedKeyQuery(filters);
			// Legacy logins without a verified subject can still safely read the API.
			const [scope, data] = await Promise.all([
				auth(request.current.signal).catch((failure) => {
					if (failure instanceof HttpFailure) throw failure;
					return null;
				}),
				read(url, request.current.signal),
			]);
			if (epoch !== lifecycle.current.epoch || request.current.signal.aborted)
				return;
			const safe = legacySharedKeyOverview(data, filters);
			lifecycle.current.scope = scope;
			setPending(null);
			if (!scope) setGate("unverified");
			else {
				try {
					const marker = legacySharedKeyReadMarker(
						window.sessionStorage,
						scope.key
					);
					setPending(marker);
					setGate(marker ? "unknown" : "ready");
				} catch {
					setGate("storage");
				}
			}
			setOverview(safe);
		} catch (failure) {
			if (epoch !== lifecycle.current.epoch) return;
			if (!boundary(failure)) {
				setError(t("loadFailed"));
				setGate("unverified");
			}
		} finally {
			request.release();
			if (epoch === lifecycle.current.epoch) setLoading(false);
		}
	}, [filters, closeEditor, controller, boundary, t]);
	useEffect(() => {
		const current = lifecycle.current;
		let active = true;
		queueMicrotask(() => {
			if (active) void load();
		});
		return () => {
			active = false;
			current.epoch++;
			current.editorEpoch++;
			for (const request of current.controllers) request.abort();
			current.controllers.clear();
			current.scope = null;
		};
	}, [load, pathname]);
	useEffect(() => {
		const expired = () => {
			invalidate();
			setError(t("permissionLost"));
		};
		const unsubscribe = subscribeCinaAuthSessionChanges(expired);
		window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT_NAME, expired);
		const verify = async () => {
			if (
				document.visibilityState !== "visible" ||
				!lifecycle.current.scope ||
				lifecycle.current.busy
			)
				return;
			const subject = lifecycle.current.scope.subject;
			const epoch = lifecycle.current.epoch;
			const request = controller();
			try {
				const scope = await auth(request.current.signal);
				if (
					!request.current.signal.aborted &&
					epoch === lifecycle.current.epoch &&
					scope?.subject !== subject
				) {
					invalidate();
					setError(t("identityChanged"));
				}
			} catch (failure) {
				if (
					!request.current.signal.aborted &&
					epoch === lifecycle.current.epoch &&
					!boundary(failure)
				) {
					invalidate();
					setError(t("identityChanged"));
				}
			} finally {
				request.release();
			}
		};
		window.addEventListener("focus", verify);
		document.addEventListener("visibilitychange", verify);
		return () => {
			unsubscribe();
			window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT_NAME, expired);
			window.removeEventListener("focus", verify);
			document.removeEventListener("visibilitychange", verify);
		};
	}, [invalidate, boundary, controller, t]);
	const editorOpen = editor !== null;
	useEffect(() => {
		if (editorOpen && dialog.current && !dialog.current.open)
			dialog.current.showModal();
		else if (!editorOpen && dialog.current?.open) {
			dialog.current.close();
			(opener.current?.isConnected ? opener.current : heading.current)?.focus();
		}
	}, [editorOpen]);
	const editorReady =
		editor?.kind === "govern" ? editor.detail !== null : editor?.ready === true;
	const auditHead =
		editor?.kind === "recover" ? editor.entries[0]?.id : undefined;
	useEffect(() => {
		if (editorReady) firstField.current?.focus();
	}, [editorReady, auditHead]);
	const verifyScope = async (scope: Scope, signal: AbortSignal) => {
		const current = await auth(signal);
		if (signal.aborted) throw new DOMException("Aborted", "AbortError");
		if (
			current?.subject !== scope.subject ||
			lifecycle.current.scope?.subject !== scope.subject
		) {
			invalidate();
			setError(t("identityChanged"));
			throw new Error("Identity changed");
		}
	};
	const openGovernance = async (
		row: SafeAdminSharedKeyRow,
		operation: LegacySharedKeyOperation,
		target: HTMLElement
	) => {
		const scope = lifecycle.current.scope;
		if (
			!scope ||
			gate !== "ready" ||
			lifecycle.current.busy ||
			!overview?.capabilities.can_write
		)
			return;
		opener.current = target;
		closeEditor();
		setEditor({ kind: "govern", operation, listed: row, detail: null });
		setNotice("");
		const epoch = lifecycle.current.epoch;
		const editorEpoch = lifecycle.current.editorEpoch;
		const request = controller();
		try {
			await verifyScope(scope, request.current.signal);
			const data = await read(
				`/api/admin/shared-keys/${encodeURIComponent(row.id)}/detail`,
				request.current.signal
			);
			if (
				epoch !== lifecycle.current.epoch ||
				editorEpoch !== lifecycle.current.editorEpoch ||
				request.current.signal.aborted
			)
				return;
			const detail = legacySharedKeyDetail(data, row);
			if (!detail.capabilities.can_write) throw new HttpFailure(403);
			if (
				(operation === "restore" && detail.status !== "disabled") ||
				(operation === "disable" && detail.status === "disabled")
			)
				throw new HttpFailure(409);
			setEditor({ kind: "govern", operation, listed: row, detail });
			setPriority(String(detail.sellerPriority));
			setWeight(String(detail.weight));
		} catch (failure) {
			if (
				epoch !== lifecycle.current.epoch ||
				editorEpoch !== lifecycle.current.editorEpoch
			)
				return;
			if (!boundary(failure)) {
				closeEditor();
				setError(
					failure instanceof HttpFailure && failure.status === 409
						? t("conflict")
						: t("detailFailed")
				);
			}
		} finally {
			request.release();
		}
	};
	const submitGovernance = async () => {
		if (
			editor?.kind !== "govern" ||
			!editor.detail ||
			lifecycle.current.busy ||
			gate !== "ready"
		)
			return;
		const scope = lifecycle.current.scope;
		if (!scope) return;
		const review = editor;
		const detail = editor.detail;
		let body: Record<string, string | number>;
		try {
			if (!acknowledged) throw new Error("Review required");
			body = legacySharedKeyWriteBody(
				detail,
				review.operation,
				reason,
				priority,
				weight
			);
		} catch {
			setEditorError(t("invalidInput"));
			return;
		}
		lifecycle.current.busy = true;
		setBusy(true);
		setEditorError("");
		const epoch = lifecycle.current.epoch;
		const editorEpoch = lifecycle.current.editorEpoch;
		const request = controller();
		const marker: LegacySharedKeyMarker = {
			v: 1,
			keyId: detail.id,
			operation: review.operation,
		};
		let dispatched = false;
		try {
			const fresh = legacySharedKeyDetail(
				await read(
					`/api/admin/shared-keys/${encodeURIComponent(detail.id)}/detail`,
					request.current.signal
				),
				detail
			);
			await verifyScope(scope, request.current.signal);
			if (
				epoch !== lifecycle.current.epoch ||
				editorEpoch !== lifecycle.current.editorEpoch ||
				request.current.signal.aborted
			)
				return;
			if (!fresh.capabilities.can_write) throw new HttpFailure(403);
			if (fresh.profile_revision !== detail.profile_revision)
				throw new HttpFailure(409);
			try {
				legacySharedKeyMark(window.sessionStorage, scope.key, marker);
			} catch {
				setGate("storage");
				closeEditor();
				setError(t("storageUnavailable"));
				return;
			}
			dispatched = true;
			setPending(marker);
			setGate("unknown");
			const response = await fetch(
				`/api/admin/shared-keys/${encodeURIComponent(detail.id)}`,
				{
					method: review.operation === "delete" ? "DELETE" : "PATCH",
					headers: legacySharedKeyHeaders(scope.subject),
					cache: "no-store",
					credentials: "same-origin",
					redirect: "error",
					signal: request.current.signal,
					body: JSON.stringify(body),
				}
			);
			let result: unknown;
			try {
				result = await json(response);
			} catch {
				result = null;
			}
			if (
				epoch !== lifecycle.current.epoch ||
				editorEpoch !== lifecycle.current.editorEpoch ||
				request.current.signal.aborted
			)
				return;
			const outcome = legacySharedKeyWriteResult(
				response.status,
				result,
				marker
			);
			if (outcome === "unknown") {
				closeEditor();
				if (!boundary(new HttpFailure(response.status)))
					setError(t("unknownResult"));
				return;
			}
			try {
				legacySharedKeyClearMarker(window.sessionStorage, scope.key, marker);
			} catch {
				closeEditor();
				if (!boundary(new HttpFailure(response.status)))
					setError(t("unknownResult"));
				return;
			}
			setPending(null);
			setGate("ready");
			closeEditor();
			if (outcome === "rejected") {
				const failure = new HttpFailure(response.status, envelope(result).code);
				if (!boundary(failure))
					setError(
						failure.code === "shared_key_earning_history_immutable"
							? t("historyProtected")
							: failure.status === 409
							? t("conflict")
							: t("updateFailed")
					);
			} else {
				setNotice(outcome === "unchanged" ? t("unchanged") : t("saved"));
				await load();
			}
		} catch (failure) {
			if (
				epoch !== lifecycle.current.epoch ||
				editorEpoch !== lifecycle.current.editorEpoch
			)
				return;
			if (dispatched) {
				closeEditor();
				setError(t("unknownResult"));
			} else if (!boundary(failure)) {
				closeEditor();
				setError(
					failure instanceof HttpFailure && failure.status === 409
						? t("conflict")
						: t("detailFailed")
				);
			}
		} finally {
			request.release();
			if (epoch === lifecycle.current.epoch) {
				lifecycle.current.busy = false;
				setBusy(false);
			}
		}
	};
	const openRecovery = async (target: HTMLElement) => {
		const scope = lifecycle.current.scope;
		if (!scope || !pending || gate !== "unknown" || lifecycle.current.busy)
			return;
		const marker = pending;
		opener.current = target;
		closeEditor();
		setEditor({
			kind: "recover",
			pending: marker,
			detail: null,
			missing: false,
			ready: false,
			entries: [],
			nextCursor: null,
		});
		const epoch = lifecycle.current.epoch;
		const editorEpoch = lifecycle.current.editorEpoch;
		const request = controller();
		try {
			await verifyScope(scope, request.current.signal);
			const [data, audit] = await Promise.all([
				read(
					`/api/admin/shared-keys/${encodeURIComponent(marker.keyId)}/detail`,
					request.current.signal,
					marker.operation === "delete"
				),
				read(
					`/api/admin/shared-keys/${encodeURIComponent(
						marker.keyId
					)}/audit?page_size=20`,
					request.current.signal
				),
			]);
			await verifyScope(scope, request.current.signal);
			if (
				epoch !== lifecycle.current.epoch ||
				editorEpoch !== lifecycle.current.editorEpoch ||
				request.current.signal.aborted
			)
				return;
			const detail =
				data === null
					? null
					: legacySharedKeyDetail(data, {
							...legacySharedKeyRow(data),
							id: marker.keyId,
					  });
			setEditor({
				kind: "recover",
				pending: marker,
				detail,
				missing: data === null,
				ready: true,
				...legacySharedKeyAudit(audit, marker.keyId),
			});
		} catch (failure) {
			if (
				epoch === lifecycle.current.epoch &&
				editorEpoch === lifecycle.current.editorEpoch &&
				!boundary(failure)
			)
				setEditorError(t("recoveryFailed"));
		} finally {
			request.release();
		}
	};
	const olderAudit = async () => {
		if (
			editor?.kind !== "recover" ||
			!editor.ready ||
			!editor.nextCursor ||
			lifecycle.current.busy
		)
			return;
		const scope = lifecycle.current.scope;
		if (!scope) return;
		const review = editor;
		const epoch = lifecycle.current.epoch;
		const editorEpoch = lifecycle.current.editorEpoch;
		const request = controller();
		lifecycle.current.busy = true;
		setBusy(true);
		setAcknowledged(false);
		try {
			await verifyScope(scope, request.current.signal);
			const audit = await read(
				`/api/admin/shared-keys/${encodeURIComponent(
					review.pending.keyId
				)}/audit?page_size=20&cursor=${encodeURIComponent(review.nextCursor!)}`,
				request.current.signal
			);
			if (
				epoch !== lifecycle.current.epoch ||
				editorEpoch !== lifecycle.current.editorEpoch ||
				request.current.signal.aborted
			)
				return;
			setEditor({
				...review,
				...legacySharedKeyAudit(
					audit,
					review.pending.keyId,
					review.nextCursor!
				),
			});
			setEditorError("");
		} catch (failure) {
			if (
				epoch === lifecycle.current.epoch &&
				editorEpoch === lifecycle.current.editorEpoch &&
				!boundary(failure)
			)
				setEditorError(t("recoveryFailed"));
		} finally {
			request.release();
			if (epoch === lifecycle.current.epoch) {
				lifecycle.current.busy = false;
				setBusy(false);
			}
		}
	};
	const unlock = async () => {
		if (
			editor?.kind !== "recover" ||
			!legacySharedKeyCanRecover(
				editor.pending,
				editor.detail,
				editor.ready,
				acknowledged
			) ||
			lifecycle.current.busy
		)
			return;
		const scope = lifecycle.current.scope;
		if (!scope) return;
		const review = editor;
		const epoch = lifecycle.current.epoch;
		const editorEpoch = lifecycle.current.editorEpoch;
		const request = controller();
		lifecycle.current.busy = true;
		setBusy(true);
		try {
			await verifyScope(scope, request.current.signal);
			if (
				epoch !== lifecycle.current.epoch ||
				editorEpoch !== lifecycle.current.editorEpoch ||
				request.current.signal.aborted
			)
				return;
			legacySharedKeyClearMarker(
				window.sessionStorage,
				scope.key,
				review.pending
			);
			setPending(null);
			closeEditor();
			setNotice(t("recovered"));
			await load();
		} catch (failure) {
			if (
				epoch === lifecycle.current.epoch &&
				editorEpoch === lifecycle.current.editorEpoch &&
				!boundary(failure)
			)
				setEditorError(t("recoveryFailed"));
		} finally {
			request.release();
			if (epoch === lifecycle.current.epoch) {
				lifecycle.current.busy = false;
				setBusy(false);
			}
		}
	};
	const applyFilters = (event: FormEvent) => {
		event.preventDefault();
		if (lifecycle.current.busy) return;
		const next = {
			...draft,
			page: 1,
			search: draft.search.trim(),
			sellerUserId: draft.sellerUserId.trim(),
		};
		try {
			legacySharedKeyQuery(next);
			setFilters(next);
		} catch {
			setError(t("invalidFilters"));
		}
	};
	const canWrite =
		gate === "ready" &&
		overview?.capabilities.can_write === true &&
		!busy &&
		!loading;
	const rows = overview?.items ?? [];
	const reference = overview?.currentBillingCurrency ?? t("notAvailable");
	const operationTitle =
		editor?.kind === "govern"
			? t(`dialogTitles.${editor.operation}`)
			: t("recoveryTitle");
	return (
		<div className="console-shell min-w-0 space-y-4 p-4 text-gray-900 sm:p-6">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<h1 ref={heading} tabIndex={-1} className="text-2xl font-bold">
						{t("title")}
					</h1>
					<p className="mt-1 max-w-3xl text-sm text-gray-600">
						{t("subtitle")}
					</p>
				</div>
				<button
					type="button"
					className={buttonClass}
					disabled={busy || loading}
					onClick={() => void load()}
				>
					{t("refresh")}
				</button>
			</div>
			<form
				onSubmit={applyFilters}
				className="grid gap-3 rounded-lg border border-gray-200 p-4 sm:grid-cols-2 xl:grid-cols-6"
			>
				<label className="text-sm">
					{t("status")}
					<select
						className={`mt-1 ${controlClass}`}
						value={draft.status}
						disabled={busy}
						onChange={(event) =>
							setDraft({ ...draft, status: event.target.value })
						}
					>
						<option value="">{t("filterAll")}</option>
						{statuses.map((status) => (
							<option key={status} value={status}>
								{t(`statuses.${status}`)}
							</option>
						))}
					</select>
				</label>
				<label className="text-sm">
					{t("channel")}
					<select
						className={`mt-1 ${controlClass}`}
						value={draft.channelType}
						disabled={busy}
						onChange={(event) =>
							setDraft({ ...draft, channelType: event.target.value })
						}
					>
						<option value="">{t("allChannels")}</option>
						{channels.map((channel) => (
							<option key={channel} value={channel}>
								{channel}
							</option>
						))}
					</select>
				</label>
				<label className="text-sm">
					{t("sellerId")}
					<input
						className={`mt-1 ${controlClass}`}
						maxLength={255}
						value={draft.sellerUserId}
						disabled={busy}
						onChange={(event) =>
							setDraft({ ...draft, sellerUserId: event.target.value })
						}
					/>
				</label>
				<label className="text-sm">
					{t("search")}
					<input
						className={`mt-1 ${controlClass}`}
						maxLength={200}
						value={draft.search}
						disabled={busy}
						onChange={(event) =>
							setDraft({ ...draft, search: event.target.value })
						}
					/>
				</label>
				<label className="text-sm">
					{t("pageSize")}
					<select
						className={`mt-1 ${controlClass}`}
						value={draft.pageSize}
						disabled={busy}
						onChange={(event) =>
							setDraft({ ...draft, pageSize: Number(event.target.value) })
						}
					>
						{[20, 50, 100].map((size) => (
							<option key={size} value={size}>
								{size}
							</option>
						))}
					</select>
				</label>
				<div className="flex items-end">
					<button type="submit" className={buttonClass} disabled={busy}>
						{t("applyFilters")}
					</button>
				</div>
			</form>
			<div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
				<p>{t("quoteCurrencyWarning")}</p>
				<p className="mt-1">{t("billingReference", { currency: reference })}</p>
				<p className="mt-1">{t("earningsUnit")}</p>
			</div>
			{gate === "unknown" && (
				<div role="alert" className="rounded-lg border border-amber-400 p-3">
					<p>{t("unknownResult")}</p>
					{pending && (
						<>
							<p className="mt-2 break-all font-mono text-xs">
								{pending.keyId}
							</p>
							<button
								type="button"
								className={`mt-3 ${buttonClass}`}
								disabled={busy || loading}
								onClick={(event) => void openRecovery(event.currentTarget)}
							>
								{t("reviewUnknown")}
							</button>
						</>
					)}
				</div>
			)}
			{gate === "unverified" && (
				<p role="status" className="text-sm text-[var(--console-text)]">
					{t("unverifiedReadOnly")}
				</p>
			)}
			{gate === "storage" && (
				<p role="alert" className="text-sm text-[var(--console-text)]">
					{t("storageUnavailable")}
				</p>
			)}
			{overview && !overview.capabilities.can_write && (
				<p className="text-sm text-gray-600">{t("readOnly")}</p>
			)}
			{error && (
				<p
					role="alert"
					className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-[var(--console-text)]"
				>
					{error}
				</p>
			)}
			{notice && (
				<p role="status" className="text-sm text-green-700">
					{notice}
				</p>
			)}
			<div
				className="max-w-full overflow-x-auto rounded-lg border border-gray-200 bg-white"
				tabIndex={0}
				role="region"
				aria-label={t("tableLabel")}
			>
				{loading ? (
					<p className="px-4 py-10 text-center text-sm">{common("loading")}</p>
				) : rows.length === 0 ? (
					<p className="px-4 py-10 text-center text-sm">{t("empty")}</p>
				) : (
					<table className="w-full min-w-[1100px] text-sm">
						<caption className="sr-only">{t("tableLabel")}</caption>
						<thead>
							<tr className="border-b border-gray-200 text-left text-xs text-gray-600">
								{[
									"seller",
									"channel",
									"key",
									"status",
									"pricing",
									"priority",
									"weight",
									"usage",
									"actions",
								].map((label) => (
									<th key={label} scope="col" className="px-4 py-3">
										{t(label)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr
									key={row.id}
									className="border-b border-gray-100 align-top last:border-0"
								>
									<td className="max-w-56 break-words px-4 py-3 text-xs">
										<p>{row.sellerEmail ?? t("notAvailable")}</p>
										{overview?.capabilities.user_detail ? (
											<Link
												className="mt-1 block break-all text-cyan-700 underline"
												href={`/gateway/users/${encodeURIComponent(
													row.sellerUserId
												)}`}
											>
												{row.sellerUserId}
											</Link>
										) : (
											<p className="mt-1 break-all font-mono">
												{row.sellerUserId}
											</p>
										)}
									</td>
									<td className="max-w-48 break-words px-4 py-3">
										<p>{row.channelType}</p>
										<p className="mt-1 text-xs text-gray-500">
											{row.label ?? t("notAvailable")}
										</p>
									</td>
									<td className="max-w-56 break-all px-4 py-3 font-mono text-xs">
										<p>{row.apiKeyMasked}</p>
										<p className="mt-2">{row.id}</p>
									</td>
									<td className="px-4 py-3">
										<p className="rounded bg-gray-100 px-2 py-1 text-xs">
											{t(`statuses.${row.status}`)}
										</p>
										{row.failureCode && (
											<p className="mt-2 max-w-48 text-xs text-[var(--console-text)]">
												{t(`failureCodes.${row.failureCode}`)}
											</p>
										)}
										<p className="mt-2 text-xs text-gray-500">
											{row.validatedAt
												? t("validatedAt", { date: row.validatedAt })
												: t("notValidated")}
										</p>
									</td>
									<td className="whitespace-nowrap px-4 py-3 text-xs">
										{(
											[
												"inputPrice",
												"outputPrice",
												"cacheReadPrice",
												"cacheWritePrice",
											] as const
										).map((field) => (
											<p key={field}>
												{t(`prices.${field}`)}
												{": "}
												{row[field] ?? t("notAvailable")}
											</p>
										))}
										<p className="mt-2 whitespace-normal text-[var(--console-text)]">
											{t("unrecordedCurrency")}
										</p>
									</td>
									<td className="px-4 py-3">{row.sellerPriority}</td>
									<td className="px-4 py-3">{row.weight}</td>
									<td className="px-4 py-3 text-xs">
										<p>
											{t("inputTokens", {
												count: row.servedInputTokens.toLocaleString(),
											})}
										</p>
										<p>
											{t("outputTokens", {
												count: row.servedOutputTokens.toLocaleString(),
											})}
										</p>
										<p className="mt-1">
											{t("earnedUsd", { amount: row.earnedTotal.toFixed(6) })}
										</p>
										<p className="mt-2 max-w-48 text-gray-500">
											{t(`statistics.${row.statisticsBasis}`)}
										</p>
									</td>
									<td className="px-4 py-3">
										<div className="flex min-w-36 flex-col gap-2">
											{(
												[
													"update",
													row.status === "disabled" ? "restore" : "disable",
													"delete",
												] as const
											).map((operation) => (
												<button
													key={operation}
													type="button"
													className={buttonClass}
													disabled={!canWrite}
													onClick={(event) =>
														void openGovernance(
															row,
															operation,
															event.currentTarget
														)
													}
													aria-label={t("rowAction", {
														action: t(`dialogTitles.${operation}`),
														id: row.id,
													})}
												>
													{t(`dialogTitles.${operation}`)}
												</button>
											))}
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
			<nav
				aria-label={t("pagination")}
				className="flex flex-wrap items-center justify-between gap-3"
			>
				<p className="text-sm">
					{t("pageSummary", {
						page: filters.page,
						total: overview?.total ?? 0,
					})}
				</p>
				<div className="flex gap-2">
					<button
						type="button"
						className={buttonClass}
						disabled={busy || loading || filters.page <= 1}
						onClick={() => setFilters({ ...filters, page: filters.page - 1 })}
					>
						{common("previous")}
					</button>
					<button
						type="button"
						className={buttonClass}
						disabled={
							busy || loading || !overview?.hasMore || filters.page >= 1_000_000
						}
						onClick={() => setFilters({ ...filters, page: filters.page + 1 })}
					>
						{common("next")}
					</button>
				</div>
			</nav>
			<dialog
				ref={dialog}
				tabIndex={-1}
				aria-labelledby="shared-key-dialog-title"
				aria-describedby="shared-key-dialog-description"
				onCancel={(event) => {
					event.preventDefault();
					if (!lifecycle.current.busy) closeEditor();
				}}
				onKeyDown={(event) => {
					if (
						event.key !== "Tab" ||
						event.ctrlKey ||
						event.altKey ||
						event.metaKey
					)
						return;
					const controls = Array.from(
						event.currentTarget.querySelectorAll<HTMLElement>(
							"button,input,select,textarea,a[href],[tabindex]"
						)
					).filter(
						(element) =>
							element.tabIndex >= 0 &&
							!element.matches(":disabled") &&
							element.getClientRects().length > 0
					);
					if (!controls.length) {
						event.preventDefault();
						event.currentTarget.focus();
						return;
					}
					if (event.shiftKey && document.activeElement === controls[0]) {
						event.preventDefault();
						controls.at(-1)!.focus();
					} else if (
						!event.shiftKey &&
						document.activeElement === controls.at(-1)
					) {
						event.preventDefault();
						controls[0].focus();
					}
				}}
				className="m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-xl border border-gray-300 bg-white p-5 text-gray-900 shadow-xl backdrop:bg-black/50"
			>
				{editor && (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void (editor.kind === "govern" ? submitGovernance() : unlock());
						}}
						className="space-y-4"
					>
						<h2 id="shared-key-dialog-title" className="text-lg font-semibold">
							{operationTitle}
						</h2>
						<p
							id="shared-key-dialog-description"
							className="text-sm text-gray-600"
						>
							{editor.kind === "recover"
								? t("recoveryInstructions")
								: t("reviewInstructions")}
						</p>
						{!editorReady ? (
							<p role="status">{common("loading")}</p>
						) : editor.kind === "govern" && editor.detail ? (
							<>
								<dl className="grid grid-cols-[auto_1fr] gap-2 text-sm">
									<dt>{t("keyId")}</dt>
									<dd className="break-all font-mono text-xs">
										{editor.detail.id}
									</dd>
									<dt>{t("seller")}</dt>
									<dd className="break-all">
										{editor.detail.sellerEmail ?? editor.detail.sellerUserId}
										<span className="block font-mono text-xs">
											{editor.detail.sellerUserId}
										</span>
									</dd>
									<dt>{t("status")}</dt>
									<dd>{t(`statuses.${editor.detail.status}`)}</dd>
									<dt>{t("reviewedRevision")}</dt>
									<dd className="break-all font-mono text-xs">
										{editor.detail.profile_revision}
									</dd>
								</dl>
								{editor.operation === "update" && (
									<div className="grid gap-3 sm:grid-cols-2">
										<label className="text-sm">
											{t("priority")}
											<input
												ref={firstField}
												type="number"
												step={1}
												min={-2147483648}
												max={2147483647}
												value={priority}
												onChange={(event) => setPriority(event.target.value)}
												disabled={busy}
												required
												className={`mt-1 ${controlClass}`}
											/>
										</label>
										<label className="text-sm">
											{t("weight")}
											<input
												type="number"
												step={1}
												min={1}
												max={100}
												value={weight}
												onChange={(event) => setWeight(event.target.value)}
												disabled={busy}
												required
												className={`mt-1 ${controlClass}`}
											/>
										</label>
									</div>
								)}
								{editor.operation === "restore" && (
									<p className="text-sm text-[var(--console-text)]">
										{t("restoreHint")}
									</p>
								)}
								{editor.operation === "delete" && (
									<p className="text-sm text-[var(--console-text)]">
										{t("deleteWarning")}
									</p>
								)}
								<div className="text-sm">
									<label htmlFor="shared-key-reason">{t("reason")}</label>
									<input
										id="shared-key-reason"
										aria-describedby="shared-key-reason-hint"
										ref={editor.operation !== "update" ? firstField : undefined}
										value={reason}
										onChange={(event) => setReason(event.target.value)}
										required
										maxLength={600}
										disabled={busy}
										autoComplete="off"
										className={`mt-1 ${controlClass}`}
									/>
									<p
										id="shared-key-reason-hint"
										className="mt-1 text-xs text-gray-500"
									>
										{t("reasonHint")}
									</p>
								</div>
								<label className="flex items-start gap-2 text-sm">
									<input
										type="checkbox"
										checked={acknowledged}
										onChange={(event) => setAcknowledged(event.target.checked)}
										required
										disabled={busy}
										className="mt-1"
									/>
									{editor.operation === "delete"
										? t("confirmDelete")
										: t("confirmReview")}
								</label>
							</>
						) : (
							editor.kind === "recover" && (
								<>
									<p className="break-all font-mono text-xs">
										{editor.pending.keyId}
									</p>
									<p className="text-sm">
										{editor.missing
											? t("recoveryMissing")
											: t("recoveryCurrent", {
													status: t(`statuses.${editor.detail!.status}`),
													priority: editor.detail!.sellerPriority,
													weight: editor.detail!.weight,
											  })}
									</p>
									<div className="space-y-3 rounded border border-gray-200 p-3 text-xs">
										<h3 className="font-semibold">{t("auditEvidence")}</h3>
										{editor.entries.length === 0 ? (
											<p>{t("emptyAudit")}</p>
										) : (
											editor.entries.map((entry) => (
												<article
													key={entry.id}
													className="space-y-1 border-b border-gray-200 pb-3 last:border-0"
												>
													<p>
														{entry.createdAt}
														{" · "}
														{t(`auditActions.${entry.action}`)}
													</p>
													<p className="break-all font-mono">{entry.id}</p>
													<p>
														{t("auditBefore", {
															status: t(`statuses.${entry.before.status}`),
															priority: entry.before.sellerPriority,
															weight: entry.before.weight,
														})}
													</p>
													<p>
														{entry.after
															? t("auditAfter", {
																	status: t(`statuses.${entry.after.status}`),
																	priority: entry.after.sellerPriority,
																	weight: entry.after.weight,
															  })
															: t("recoveryMissing")}
													</p>
												</article>
											))
										)}
										{editor.nextCursor && (
											<button
												type="button"
												className={buttonClass}
												disabled={busy}
												onClick={() => void olderAudit()}
											>
												{t("olderAudit")}
											</button>
										)}
									</div>
									<label className="flex items-start gap-2 text-sm">
										<input
											ref={firstField}
											type="checkbox"
											checked={acknowledged}
											onChange={(event) =>
												setAcknowledged(event.target.checked)
											}
											required
											disabled={busy}
											className="mt-1"
										/>
										{t("confirmRecovery")}
									</label>
								</>
							)
						)}
						{editorError && (
							<p role="alert" className="text-sm text-[var(--console-text)]">
								{editorError}
							</p>
						)}
						<div className="flex flex-wrap justify-end gap-2">
							<button
								type="button"
								className={buttonClass}
								disabled={busy}
								onClick={closeEditor}
							>
								{common("cancel")}
							</button>
							<button
								type="submit"
								className={`${buttonClass} border-cyan-500`}
								disabled={busy || !editorReady || !acknowledged}
							>
								{busy
									? common("loading")
									: editor.kind === "recover"
									? t("unlock")
									: t("submit")}
							</button>
						</div>
					</form>
				)}
			</dialog>
		</div>
	);
}
