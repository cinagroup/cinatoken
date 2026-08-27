import createNextIntlPlugin from 'next-intl/plugin';
import path from 'path';
import { fileURLToPath } from 'url';

const withNextIntl = createNextIntlPlugin('./lib/i18n.ts');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** npm workspace 根（`cinatoken/`），与 hoist 的 `next` 一致 */
const workspaceRoot = path.join(__dirname, '../..');

/** Admin/OpenNext 的 `node` 条件会解析到过期的 `core/dist`；强制根导入走 src。 */
const coreSrcIndex = path.join(__dirname, '../core/src/index.ts');
const isDevelopment = process.env.NODE_ENV === 'development';
const isCloudflareBuild = process.env.CINATOKEN_CLOUDFLARE_BUILD === '1';
const contentSecurityPolicy = [
	"default-src 'self'",
	`script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com${isDevelopment ? " 'unsafe-eval'" : ''}`,
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob: https:",
	"font-src 'self' data:",
	"connect-src 'self' https://auth.cinaseek.ai https://accounts.cinaseek.ai wss:",
	"worker-src 'self' blob:",
	"object-src 'none'",
	"base-uri 'self'",
	"frame-ancestors 'none'",
	"frame-src 'none'",
	"form-action 'self' https://auth.cinaseek.ai https://accounts.cinaseek.ai",
	'upgrade-insecure-requests',
].join('; ');

const securityHeaders = [
	{ key: 'Content-Security-Policy', value: contentSecurityPolicy },
	{ key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
	{ key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
	{ key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
	{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
	{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
	{ key: 'X-Content-Type-Options', value: 'nosniff' },
	{ key: 'X-Frame-Options', value: 'DENY' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
	output: 'standalone',
	transpilePackages: ['@octafuse/core', '@octafuse/tool-engines'],
	images: {
		unoptimized: true,
	},
	async headers() {
		return [
			{ source: '/api/:path*', headers: [...securityHeaders, { key: 'Cache-Control', value: 'no-store' }] },
			{ source: '/:path*', headers: securityHeaders },
		];
	},
	async rewrites() {
		return [
			{ source: '/admin', destination: '/dashboard' },
			{ source: '/admin/:path*', destination: '/gateway/:path*' },
		];
	},
	// 与 `turbopack.root` 必须相同（npm workspaces 下 Next 会从 monorepo 根解析 `next`）
	outputFileTracingRoot: workspaceRoot,
	turbopack: {
		root: workspaceRoot,
		resolveAlias: {
			// Turbopack alias 从 Admin 目录解析；使用相对路径避免绝对路径被误判为 server-relative import。
			'@octafuse/core': '../core/src/index.ts',
		},
	},
	webpack: (config) => {
		config.resolve.alias = {
			...config.resolve.alias,
			// Exact match (`$`) so `@octafuse/core/lib/...` still uses package exports → src.
			// Avoids OpenNext/webpack `node` condition resolving a stale `core/dist`.
			'@octafuse/core$': coreSrcIndex,
			// MySQL is unsupported in the Worker runtime. PostgreSQL must stay bundled for
			// Hyperdrive deployments; replacing it with `false` creates an empty module.
			...(isCloudflareBuild
				? { 'mysql2$': false, 'mysql2/promise$': false }
				: {}),
		};
		return config;
	},
};

export default withNextIntl(nextConfig);
