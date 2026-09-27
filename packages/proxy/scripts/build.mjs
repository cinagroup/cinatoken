/**
 * Proxy Node 运行时打包：把 `@octafuse/*` workspace 解析结果打进 bundle，
 * 其余裸导入（hono、postgres、drizzle-orm…）保持 external。
 * core 根导入按 node exports 使用 dist/index.js；子路径可能使用源码。
 *
 * 避免 `--packages=external` 把 `@octafuse/core/lib/*` 子路径留成运行时依赖
 * （core 子路径 exports 指向 `.ts`，镜像 runner 只有 `dist`，会 ERR_MODULE_NOT_FOUND）。
 */
import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..');
const outfile = join(pkgRoot, 'dist/runtime/node.js');

/** 裸导入中仅 `@octafuse/*` 走默认解析（打进 bundle）；其余 external。 */
const bundleWorkspacePackages = {
	name: 'bundle-workspace-packages',
	setup(build) {
		build.onResolve({ filter: /^[^./]/ }, (args) => {
			// Windows entry points are absolute `C:\\...` paths and are not bare imports.
			if (args.kind === 'entry-point') return undefined;
			if (args.path.startsWith('@octafuse/')) {
				return undefined;
			}
			return { path: args.path, external: true };
		});
	},
};

// Export the actual options for offline evaluation; CLI defaults remain unchanged.
// Evaluation plugins must precede the bare-import externalizer.
export function proxyNodeBuildOptions({ outputFile = outfile, beforePlugins = [] } = {}) {
	return {
		entryPoints: [join(pkgRoot, 'src/runtime/node.ts')],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile: outputFile,
		logLevel: 'warning',
		plugins: [...beforePlugins, bundleWorkspacePackages],
	};
}

/** 产物不得再含 `@octafuse/*` 外部说明符。 */
export function assertNoWorkspaceExternals(source) {
	const re = /(?:from\s+|import\s*\(\s*)["'](@octafuse\/[^"']+)["']/g;
	const found = new Set();
	for (const m of source.matchAll(re)) {
		found.add(m[1]);
	}
	if (found.size > 0) {
		console.error('[proxy/build] bundle still references @octafuse/* as external:');
		for (const id of [...found].sort()) {
			console.error(`  ${id}`);
		}
		throw new Error('[proxy/build] unresolved workspace imports');
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await esbuild.build(proxyNodeBuildOptions());
	assertNoWorkspaceExternals(readFileSync(outfile, 'utf8'));
	console.log('[proxy/build] OK: no @octafuse/* externals in', outfile);
}
