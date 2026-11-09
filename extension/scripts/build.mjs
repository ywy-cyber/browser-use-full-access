import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const viteBin = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js')
const configs = ['vite.background.config.ts', 'vite.content.config.ts']

for (const config of configs) {
  const result = spawnSync(process.execPath, [viteBin, 'build', '--config', config], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log('built into dist/')
