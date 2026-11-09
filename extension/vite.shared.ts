import { copyFileSync, cpSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vite'

/** Shared build plumbing: background (ES module) and content (classic IIFE) into dist/. */
export const outDir = resolve(import.meta.dirname, 'dist')

export const copyManifest = {
  name: 'copy-manifest',
  closeBundle(): void {
    mkdirSync(outDir, { recursive: true })
    copyFileSync(resolve(import.meta.dirname, 'manifest.json'), resolve(outDir, 'manifest.json'))
    cpSync(resolve(import.meta.dirname, '_locales'), resolve(outDir, '_locales'), { recursive: true })
    cpSync(resolve(import.meta.dirname, 'assets'), resolve(outDir, 'assets'), { recursive: true })
  },
}

export function targetBuild(entry: string, format: 'es' | 'iife', entryFileNames: string, emptyOutDir: boolean) {
  return defineConfig({
    build: {
      outDir,
      emptyOutDir,
      rollupOptions: {
        input: resolve(import.meta.dirname, entry),
        output: { format, entryFileNames },
      },
    },
    plugins: [tsconfigPaths({ projects: ['./tsconfig.json'] }), copyManifest],
  })
}
