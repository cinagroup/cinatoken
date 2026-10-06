/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { attachRouterServerSsrUtils } from '@tanstack/react-router/ssr/server'
import {
	renderToReadableStream,
	renderToStaticMarkup,
} from 'react-dom/server.edge'
import { createPublicCatalogApi } from '../public/catalog-api'
import { publicMessages } from '../public/messages'
import {
	createPublicRequestApp,
	preparePublicRequest,
	PublicApplication,
	serializePublicBootstrap,
	type PublicRequestApp,
} from '../public/ssr'
import { publicPreferencesScript } from '../public/ssr/public-preferences'
import { publicDocumentBody } from './document-stream'
import {
	PUBLIC_HTTP_LOCALES,
	publicBrowserAssets,
	publicHttpRoute,
	publicRobotsText,
	publicSecurityHeaders,
	trustedPublicOrigin,
	xmlText,
} from './http-policy'
import { publicMetadata, type PublicMetadata } from './metadata'
import {
	abortablePublicResponse,
	readPublicBrowserShell,
} from './response-cancellation'

export type PublicResponseOptions = {
	publicOrigin?: string
	proxyOrigins?: string
	anonymousFetch: typeof fetch
	readBrowserShell: (request: Request) => Promise<Response>
	// Internal diagnostics only; never written to the response.
	onFailure?: (error: unknown) => void
}

function Head(props: {
	metadata: PublicMetadata
	styles: string[]
	nonce: string
}) {
	return (
		<head>
			<meta charSet='utf-8' />
			<meta name='viewport' content='width=device-width, initial-scale=1' />
			<script
				id='cinatoken-preferences-init'
				nonce={props.nonce}
				dangerouslySetInnerHTML={{ __html: publicPreferencesScript }}
			/>
			<title>{props.metadata.title}</title>
			<meta name='description' content={props.metadata.description} />
			<meta name='robots' content={props.metadata.robots} />
			<meta property='og:type' content='website' />
			<meta property='og:site_name' content='CinaToken' />
			<meta property='og:title' content={props.metadata.title} />
			<meta property='og:description' content={props.metadata.description} />
			<meta name='twitter:card' content='summary' />
			<meta name='twitter:title' content={props.metadata.title} />
			<meta name='twitter:description' content={props.metadata.description} />
			{props.metadata.canonical && (
				<>
					<link rel='canonical' href={props.metadata.canonical} />
					<meta property='og:url' content={props.metadata.canonical} />
				</>
			)}
			{props.metadata.languages.map((language) => (
				<link
					key={language.locale}
					rel='alternate'
					hrefLang={language.locale}
					href={language.href}
				/>
			))}
			<link rel='icon' type='image/png' href='/web-assets/logo.png' />
			{props.styles.map((style) => (
				<link key={style} rel='stylesheet' href={style} />
			))}
		</head>
	)
}

type RouterHydrationTags = NonNullable<
	ReturnType<
		NonNullable<
			PublicRequestApp['router']['serverSsr']
		>['takeInitialHydrationScriptTags']
	>
>
function RouterScripts(props: { tags: RouterHydrationTags; nonce: string }) {
	const tags = [...props.tags.before, props.tags.boundary]
	return (
		<>
			{tags.map((tag, index) => {
				if (tag.tag !== 'script' || typeof tag.children !== 'string')
					throw new TypeError('Invalid public router hydration script')
				return (
					<script
						key={index}
						{...tag.attrs}
						nonce={props.nonce}
						dangerouslySetInnerHTML={{ __html: tag.children }}
					/>
				)
			})}
		</>
	)
}

function unavailable(request: Request): Response {
	const locale = publicHttpRoute(new URL(request.url))?.locale ?? 'en'
	return new Response(
		request.method === 'HEAD' ? null : publicMessages[locale].unavailable,
		{
			status: 503,
			headers: {
				'cache-control': 'no-store',
				'content-type': 'text/plain; charset=utf-8',
				'x-robots-tag': 'noindex, nofollow',
				'retry-after': '30',
				'x-content-type-options': 'nosniff',
			},
		}
	)
}

/** SDK requests are a new anonymous request; incoming Cookie/Authorization never cross this boundary. */
export function anonymousCatalogFetch(
	requestUrl: string,
	binding: { fetch(request: Request): Promise<Response> }
): typeof fetch {
	return async (input, init) => {
		const raw = input instanceof Request ? input.url : String(input)
		const url = new URL(raw, requestUrl)
		if (
			url.origin !== new URL(requestUrl).origin ||
			!/^\/api\/public\/catalog\/(?:models|providers|stats\/models|model\/[^/]+\/[^/]+)$/.test(
				url.pathname
			)
		)
			throw new TypeError('Only anonymous public catalog requests are allowed')
		return binding.fetch(
			new Request(url, {
				method: 'GET',
				credentials: 'omit',
				// Worker Requests support manual redirects; the catalog SDK rejects 3xx.
				redirect: 'manual',
				headers: { accept: 'application/json' },
				signal: init?.signal,
			})
		)
	}
}

/** Identical HTML/status/SEO contract for Worker and Node. HTML cache is intentionally disabled. */
export async function renderPublicResponse(
	request: Request,
	options: PublicResponseOptions
): Promise<Response> {
	const url = new URL(request.url)
	const route = publicHttpRoute(url)
	if (!route)
		return new Response(null, {
			status: 404,
			headers: { 'cache-control': 'no-store' },
		})
	const controller = new AbortController()
	const abort = () => controller.abort(request.signal.reason)
	request.signal.addEventListener('abort', abort, { once: true })
	if (request.signal.aborted) abort()
	const timer = setTimeout(() => controller.abort(), 15_000)
	let cleanup = () => {
		clearTimeout(timer)
		request.signal.removeEventListener('abort', abort)
	}
	try {
		const origin = trustedPublicOrigin(options.publicOrigin)
		if (route.redirect)
			return new Response(null, {
				status: 308,
				headers: { location: route.redirect, 'cache-control': 'no-store' },
			})
		const api = createPublicCatalogApi(options.anonymousFetch)
		if (route.kind === 'robots')
			return new Response(
				request.method === 'HEAD' ? null : publicRobotsText(origin),
				{
					headers: {
						'content-type': 'text/plain; charset=utf-8',
						'cache-control': 'no-store',
						'x-content-type-options': 'nosniff',
					},
				}
			)
		if (route.kind === 'sitemap') {
			const models = await api.models({}, { signal: controller.signal })
			const paths = [
				'',
				'/models',
				'/providers',
				'/compare',
				'/rankings',
				'/benchmarks',
				...models.data.map(
					(model) =>
						`/models/${encodeURIComponent(model.vendor.toLowerCase())}/${encodeURIComponent(model.slug)}`
				),
			]
			const entries = [...new Set(paths)]
				.map((path) => {
					const alternates =
						PUBLIC_HTTP_LOCALES.map(
							(locale) =>
								`<xhtml:link rel="alternate" hreflang="${locale}" href="${xmlText(`${origin}/${locale}${path}`)}"/>`
						).join('') +
						`<xhtml:link rel="alternate" hreflang="x-default" href="${xmlText(`${origin}/en${path}`)}"/>`
					return PUBLIC_HTTP_LOCALES.map(
						(locale) =>
							`<url><loc>${xmlText(`${origin}/${locale}${path}`)}</loc>${alternates}</url>`
					).join('')
				})
				.join('')
			const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${entries}</urlset>`
			return new Response(request.method === 'HEAD' ? null : xml, {
				headers: {
					'content-type': 'application/xml; charset=utf-8',
					'cache-control': 'no-store',
					'x-content-type-options': 'nosniff',
				},
			})
		}
		const shell = await abortablePublicResponse(
			options.readBrowserShell(
				new Request(new URL('/index.html', url), { signal: controller.signal })
			),
			controller.signal
		)
		if (
			shell.status !== 200 ||
			!shell.headers.get('content-type')?.toLowerCase().startsWith('text/html')
		) {
			void shell.body?.cancel()
			return unavailable(request)
		}
		const assets = publicBrowserAssets(
			await readPublicBrowserShell(shell, controller.signal)
		)
		const nonce = crypto.randomUUID().replaceAll('-', '')
		const app = await createPublicRequestApp({
			url,
			locale: route.locale,
			api,
			publicOrigin: origin,
			signal: controller.signal,
		})
		const releaseRequest = cleanup
		cleanup = () => {
			releaseRequest()
			app.router.serverSsr?.cleanup()
			app.dispose()
		}
		app.router.update({ ssr: { nonce } })
		attachRouterServerSsrUtils({ router: app.router, manifest: undefined })
		const serverSsr = app.router.serverSsr
		if (!serverSsr) throw new TypeError('Missing public router SSR utilities')
		const prepared = await preparePublicRequest(app)
		await serverSsr.dehydrate({ signal: controller.signal })
		const status = route.kind === 'not-found' ? 404 : prepared.status
		const metadata = publicMetadata(
			route,
			origin,
			status,
			prepared.modelDetail?.data
		)
		const headers = publicSecurityHeaders(nonce, options.proxyOrigins)
		if (status !== 200 || route.kind === 'chat')
			headers.set('x-robots-tag', 'noindex, nofollow')
		if (status === 503) headers.set('retry-after', '30')
		const bootstrap = serializePublicBootstrap(prepared.bootstrap)
		let renderFailed = false
		// Hydration starts at #root, so the server must use that exact React tree.
		// Rendering the outer document in the same tree changes useId positions.
		const stream = await renderToReadableStream(
			<PublicApplication app={app} />,
			{
				identifierPrefix: 'cinatoken-public-',
				// Fully prepared pages must stay visible with JavaScript disabled.
				// React otherwise outlines large completed boundaries into hidden segments.
				progressiveChunkSize: Number.MAX_SAFE_INTEGER,
				signal: controller.signal,
				nonce,
				onError: (error: unknown) => {
					renderFailed = true
					options.onFailure?.(error)
					return 'public-render-unavailable'
				},
			}
		)
		// The app is fully prepared. Wait before committing a successful HTTP status.
		await stream.allReady
		if (renderFailed) {
			await stream.cancel()
			return unavailable(request)
		}
		serverSsr.setRenderFinished()
		const routerHydrationTags = serverSsr.takeInitialHydrationScriptTags()
		if (!routerHydrationTags)
			throw new TypeError('Missing public router hydration scripts')
		const documentShell = renderToStaticMarkup(
			<html lang={route.locale}>
				<Head metadata={metadata} styles={assets.styles} nonce={nonce} />
				<body>
					<div id='root' />
					<script
						id='cinatoken-preferences-sync'
						nonce={nonce}
						dangerouslySetInnerHTML={{
							__html: 'window.cinatokenPublicPreferences?.syncControls();',
						}}
					/>
					<script
						id='cinatoken-public-bootstrap'
						type='application/json'
						nonce={nonce}
						dangerouslySetInnerHTML={{ __html: bootstrap }}
					/>
					<RouterScripts tags={routerHydrationTags} nonce={nonce} />
					{assets.scripts.map((script) => (
						<script key={script} src={script} defer nonce={nonce} />
					))}
				</body>
			</html>
		)
		const documentParts = documentShell.split('<div id="root"></div>')
		if (documentParts.length !== 2)
			throw new TypeError('Invalid public document shell')
		const encoder = new TextEncoder()
		const prefix = encoder.encode(
			`<!DOCTYPE html>${documentParts[0]}<div id="root">`
		)
		const suffix = encoder.encode(`</div>${documentParts[1]}`)
		if (request.method === 'HEAD') {
			await stream.cancel()
			return new Response(null, { status, headers })
		}
		const finish = cleanup
		cleanup = () => undefined
		const body = publicDocumentBody(stream, prefix, suffix, finish, (reason) =>
			controller.abort(reason)
		)
		return new Response(body, { status, headers })
	} catch (error: unknown) {
		options.onFailure?.(error)
		return unavailable(request)
	} finally {
		cleanup()
	}
}
