import { defineConfig } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	ADMIN_ENDPOINTS_PAGE_PATHS,
	ADMIN_MODELS_PAGE_PATHS,
	ADMIN_PROVIDERS_PAGE_PATHS,
	ADMIN_ROUTES_PAGE_PATHS,
	ADMIN_PLAYGROUND_PAGE_PATHS,
	ADMIN_SIMULATOR_PAGE_PATHS,
	ADMIN_WITHDRAWALS_PAGE_PATHS,
	ADMIN_NFT_MINTS_PAGE_PATHS,
} from './edge/page-paths'
import { pluginWebBuildContract } from './scripts/build-contract.mjs'
import { loadWebBuildEnvironment } from './scripts/build-environment.mjs'

const packageRoot = path.dirname(fileURLToPath(import.meta.url))
// Local previews use the browser shell; hosted public pages use the Web SSR entry.
const localPublicPages = new Set([
	'/chat',
	'/chat/',
	'/models',
	'/models/',
	'/providers',
	'/providers/',
	'/compare',
	'/compare/',
	'/rankings',
	'/rankings/',
	'/benchmarks',
	'/benchmarks/',
])

export default defineConfig(({ envMode }) => {
	const env = loadWebBuildEnvironment(packageRoot, envMode)
	const adminOrigin =
		env.values.CINATOKEN_WEB_ADMIN_ORIGIN || 'http://localhost:8789'
	const proxyOrigin =
		env.values.CINATOKEN_WEB_PROXY_ORIGIN || 'http://localhost:8787'
	const legacyPages = [
		'/models',
		'/providers',
		'/compare',
		'/rankings',
		'/benchmarks',
		'/chat',
		'/admin',
		'/gateway',
		'/dashboard',
		'/_next',
	]

	return {
		plugins: [pluginReact(), pluginWebBuildContract(packageRoot)],
		dev: {
			watchFiles: env.filePaths.length
				? [{ paths: env.filePaths, type: 'restart' }]
				: [],
		},
		environments: {
			web: { source: { entry: { index: './src/main.tsx' } } },
			worker: {
				source: { entry: { index: './edge/worker.ts' } },
				resolve: { conditionNames: ['workerd', '...'] },
				output: {
					target: 'web-worker',
					module: true,
					emitCss: false,
					distPath: { root: 'dist-server/worker', js: '' },
					filename: { js: '[name].mjs' },
				},
				tools: { rspack: { output: { library: { type: 'module' } } } },
			},
			node: {
				source: {
					entry: { index: './src/cinatoken/public-server/public-response.tsx' },
				},
				output: {
					target: 'node',
					module: true,
					emitCss: false,
					autoExternal: false,
					distPath: { root: 'dist-server/node', js: '' },
					filename: { js: '[name].mjs' },
				},
				tools: { rspack: { output: { library: { type: 'module' } } } },
			},
		},
		resolve: { alias: { '@': path.join(packageRoot, 'src') } },
		html: { template: './index.html' },
		server: {
			host: '127.0.0.1',
			port: 8790,
			strictPort: true,
			proxy: {
				'/api': { target: adminOrigin, changeOrigin: false },
				'/catalog': { target: proxyOrigin, changeOrigin: false },
				...Object.fromEntries(
					legacyPages.map((route) => [
						route,
						{
							target: adminOrigin,
							changeOrigin: false,
							bypass(request) {
								if (request.method !== 'GET' && request.method !== 'HEAD')
									return
								const pathname = new URL(
									request.url ?? '/',
									'http://development.invalid'
								).pathname
								if (
									ADMIN_PROVIDERS_PAGE_PATHS.has(pathname) ||
									ADMIN_MODELS_PAGE_PATHS.has(pathname) ||
									ADMIN_ENDPOINTS_PAGE_PATHS.has(pathname) ||
									ADMIN_ROUTES_PAGE_PATHS.has(pathname) ||
									ADMIN_PLAYGROUND_PAGE_PATHS.has(pathname) ||
									ADMIN_SIMULATOR_PAGE_PATHS.has(pathname) ||
									ADMIN_WITHDRAWALS_PAGE_PATHS.has(pathname) ||
									ADMIN_NFT_MINTS_PAGE_PATHS.has(pathname) ||
									localPublicPages.has(pathname) ||
									/^\/models\/[^/]+\/[^/]+\/?$/.test(pathname)
								)
									return true
							},
						},
					])
				),
			},
		},
		output: {
			target: 'web',
			assetPrefix: '/web-assets/',
			distPath: { root: 'dist' },
			// Preserve extracted upstream and third-party license notices.
		},
		performance: { removeConsole: envMode === 'production' ? ['log'] : false },
	}
})
