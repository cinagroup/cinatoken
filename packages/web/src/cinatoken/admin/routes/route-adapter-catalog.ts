/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	listSelectableAdapters,
	type AdapterDescriptor,
} from '@octafuse/core/adapters/registry'
import type { AdminModel } from '../model-contracts'
import type { RouteDraft } from './route-domain'
import { routeModelKind } from './route-options'

/** Passthrough shares one stored ID across modalities; the complete selected topology identifies its guide. */
export function routeAdapterDescriptor(
	draft: RouteDraft,
	model: AdminModel | undefined
): AdapterDescriptor | null {
	const kind = routeModelKind(model)
	if (!kind) return null
	return (
		listSelectableAdapters().find(
			(descriptor) =>
				descriptor.modelKind === kind &&
				descriptor.id === draft.adapter &&
				descriptor.request.protocol === draft.requestProtocol &&
				descriptor.request.operation === draft.requestOperation &&
				descriptor.upstream.protocol === draft.upstreamProtocol &&
				descriptor.upstream.operations.includes(draft.upstreamOperation)
		) ?? null
	)
}
