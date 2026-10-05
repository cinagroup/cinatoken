/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { chatMessages } from '../chat/messages'
import type { CatalogModel } from '../public/catalog-contracts'
import { publicMessages } from '../public/messages'
import { PUBLIC_HTTP_LOCALES, type PublicHttpRoute } from './http-policy'

const home = {
	en: {
		title: 'CinaToken — Unified AI gateway',
		description:
			'Explore published AI models, compare catalog prices, and use a unified gateway API.',
	},
	zh: {
		title: 'CinaToken — 统一 AI 网关',
		description:
			'发现已发布的 AI 模型，比较目录价格，并通过统一网关 API 使用模型。',
	},
	ja: {
		title: 'CinaToken — 統合 AI ゲートウェイ',
		description:
			'公開 AI モデルと料金を比較し、統合ゲートウェイ API を利用できます。',
	},
	ko: {
		title: 'CinaToken — 통합 AI 게이트웨이',
		description:
			'공개 AI 모델과 카탈로그 가격을 비교하고 통합 게이트웨이 API를 이용하세요.',
	},
}
export type PublicMetadata = {
	title: string
	description: string
	canonical: string | null
	robots: string
	languages: { locale: string; href: string }[]
}

export function publicMetadata(
	route: PublicHttpRoute,
	origin: string,
	status: number,
	model?: CatalogModel
): PublicMetadata {
	const messages = publicMessages[route.locale]
	let title = home[route.locale].title
	let description = home[route.locale].description
	if (route.kind === 'chat') {
		title = chatMessages[route.locale].title
		description = chatMessages[route.locale].description
	}
	if (route.kind === 'models' || route.kind === 'model') {
		title = messages.modelsTitle
		description = messages.modelsDescription
	} else if (
		route.kind === 'providers' ||
		route.kind === 'compare' ||
		route.kind === 'rankings' ||
		route.kind === 'benchmarks'
	) {
		title = messages[`${route.kind}Title`]
		description = messages[`${route.kind}Description`]
	}
	if (model && status === 200) {
		title = `${model.display_name || model.id} — ${messages.modelsTitle}`
		description = model.description?.trim().slice(0, 300) || description
	}
	if (status !== 200) {
		title = status === 404 ? messages.notFound : messages.unavailable
		description = title
		return {
			title,
			description,
			canonical: null,
			robots: 'noindex, nofollow',
			languages: [],
		}
	}
	let path = route.barePath === '/' ? '' : route.barePath
	if (model && route.kind === 'model')
		path = `/models/${encodeURIComponent(model.vendor.toLowerCase())}/${encodeURIComponent(model.slug)}`
	const languages: PublicMetadata['languages'] = PUBLIC_HTTP_LOCALES.map(
		(locale) => ({ locale, href: `${origin}/${locale}${path}` })
	)
	languages.push({ locale: 'x-default', href: `${origin}/en${path}` })
	return {
		title: title.includes('CinaToken') ? title : `${title} — CinaToken`,
		description,
		canonical: `${origin}/${route.locale}${path}`,
		robots: route.kind === 'chat' ? 'noindex, nofollow' : 'index, follow',
		languages,
	}
}
