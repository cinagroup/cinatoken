/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'
import {
	providerCatalogOutboundRel,
	resolveProviderCatalogOutbound,
	type ProviderCatalogLinks,
} from './provider-catalog-links'

export function ProviderCatalogOutboundLink(props: {
	links: ProviderCatalogLinks | null | undefined
	providerName: string
	className?: string
}) {
	const { t } = useTranslation()
	const outbound = resolveProviderCatalogOutbound(props.links)
	if (!outbound) return null
	let action = t('cinatoken.adminProviders.catalogOpenPlatform')
	if (outbound.kind === 'referral')
		action = t('cinatoken.adminProviders.catalogOpenReferral')
	else if (outbound.kind === 'api_keys')
		action = t('cinatoken.adminProviders.catalogOpenApiKeys')
	return (
		<a
			href={outbound.href}
			target='_blank'
			rel={providerCatalogOutboundRel(outbound.kind)}
			referrerPolicy='no-referrer'
			aria-label={t('cinatoken.adminProviders.catalogLinkLabel', {
				action,
				name: props.providerName,
			})}
			className={cn(
				'text-primary inline-flex items-center gap-1 rounded-sm text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4',
				props.className
			)}
		>
			{action}
			<span aria-hidden='true'>↗</span>
		</a>
	)
}
