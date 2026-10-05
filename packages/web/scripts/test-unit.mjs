import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

function discover(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name)
		return entry.isDirectory()
			? discover(path)
			: /\.test\.(ts|mjs)$/.test(path)
				? [path]
				: []
	})
}

const tests = [
	'src/cinatoken',
	'edge',
	'scripts',
	'../../docker/web',
	'../../scripts/web',
]
	.flatMap((directory) => {
		try {
			return discover(directory)
		} catch (error) {
			if (error.code === 'ENOENT') return []
			throw error
		}
	})
	.sort()
if (!tests.length) throw new Error('No cinatoken Web contract tests found')
const result = spawnSync(
	process.execPath,
	['--import', 'tsx', '--test', ...tests],
	{
		stdio: 'inherit',
		// JSX settings must also cover lazily imported UI components outside cinatoken.
		env: { ...process.env, TSX_TSCONFIG_PATH: resolve('tsconfig.test.json') },
	}
)
process.exit(result.status ?? 1)
