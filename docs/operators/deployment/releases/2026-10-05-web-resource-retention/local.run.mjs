import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const directory = dirname(fileURLToPath(import.meta.url))
const [label, executable, ...args] = process.argv.slice(2)
const startedAt = new Date().toISOString()
const child = spawn(executable, args, { cwd: 'C:/cinagroup/cinatoken', env: { ...process.env, TSX_TSCONFIG_PATH: 'C:/cinagroup/cinatoken/packages/web/tsconfig.test.json' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = '', stderr = '', error = null
child.stdout.on('data', chunk => { stdout += chunk })
child.stderr.on('data', chunk => { stderr += chunk })
child.on('error', failure => { error = failure.message })
child.on('close', (code, signal) => {
  writeFileSync(join(directory, label + '.stdout.txt'), stdout, { flag: 'wx' })
  writeFileSync(join(directory, label + '.stderr.txt'), stderr, { flag: 'wx' })
  const result = { startedAt, finishedAt: new Date().toISOString(), executable, args, actualExitCode: code, signal, error, stdoutPath: join(directory, label + '.stdout.txt'), stderrPath: join(directory, label + '.stderr.txt') }
  writeFileSync(join(directory, label + '.closed.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  process.stdout.write(JSON.stringify(result, null, 2) + '\n' + stdout.slice(-6000) + stderr.slice(-2000))
  process.exit(code ?? 1)
})