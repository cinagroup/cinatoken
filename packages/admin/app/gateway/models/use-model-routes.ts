'use client';

import {useAdvancedEditorRequest} from '@/components/routing-workbench/AdvancedEditorGate';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useFeedback } from '@/components/feedback';
import type { RouteListRow } from '../routes/types';
import { deleteModelRoutes, fetchModelRoutes } from './model-api';

export function useModelRoutes(
	modelId: string | null,
	onChanged: () => Promise<void>
) {
	const request = useAdvancedEditorRequest();
	const t = useTranslations('models.modal.relatedRoutes');
	const tCommon = useTranslations('common');
	const { confirm, notify } = useFeedback();
	const [data, setData] = useState<{
		modelId: string;
		routes: RouteListRow[];
	} | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');
	const [revision, setRevision] = useState(0);
	const [isDeleting, setIsDeleting] = useState(false);
	const deletingRef = useRef(false);
	const reload = useCallback(() => setRevision((value) => value + 1), []);

	const scope = `${modelId}:${revision}`;
	const [previousScope, setPreviousScope] = useState(scope);
	if(previousScope !== scope) {
		setPreviousScope(scope);setData(null);setError('');setLoading(Boolean(modelId));
	}
	useEffect(() => {
		if (!modelId) return;
		const controller = new AbortController();
		void fetchModelRoutes(modelId, controller.signal, request)
			.then((routes) => {
				if (!controller.signal.aborted) setData({ modelId, routes });
			})
			.catch((cause: unknown) => {
				if (!controller.signal.aborted)
					setError(cause instanceof Error ? cause.message : t('loadFailed'));
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [modelId, revision, t, request]);

	const routes = data?.modelId === modelId ? data?.routes ?? [] : [];
	const ready = Boolean(
		modelId && data?.modelId === modelId && !loading && !error
	);

	const remove = async (ids: string[]) => {
		if (deletingRef.current || !ready || !modelId) return;
		const requested = routes.filter((route) => ids.includes(route.id));
		if (!requested.length) return;
		deletingRef.current = true;
		setIsDeleting(true);
		try {
			const ok = await confirm({
				title: t('deleteTitle', { count: requested.length }),
				message: t('confirmDelete', { count: requested.length }),
				confirmLabel: tCommon('delete'),
				danger: true,
			});
			if (!ok) return;
			const result = await deleteModelRoutes(modelId, requested, ids, request);
			const deleted = new Set(result.deletedIds);
			const failures = result.failures.map(
				({ route, message }) =>
					`${route.provider_name || route.provider_id} / ${
						route.provider_model_name
					}: ${message || tCommon('failed')}`
			);
			setData((current) =>
				current?.modelId === modelId
					? {
							...current,
							routes: current.routes.filter((route) => !deleted.has(route.id)),
					  }
					: current
			);
			if (deleted.size)
				notify('success', t('deleted', { count: deleted.size }));
			if (failures.length)
				notify(
					'error',
					t('deleteFailed', { count: failures.length }),
					failures.join('\n')
				);
			try {
				await onChanged();
			} catch {
				notify('error', t('loadFailed'));
			} finally {
				reload();
			}
		} finally {
			deletingRef.current = false;
			setIsDeleting(false);
		}
	};

	return {
		routes,
		loading:
			Boolean(modelId) &&
			(loading || ((!data || data.modelId !== modelId) && !error)),
		error,
		ready,
		isDeleting,
		reload,
		remove,
	};
}

export type ModelRoutesState = ReturnType<typeof useModelRoutes>;
