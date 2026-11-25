import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface PackageManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  build?: {
    npmRebuild?: boolean
    files?: string[]
    asarUnpack?: string[]
    win?: {
      icon?: string
    }
  }
}

describe('package.json Electron packaging configuration', () => {
  const packageJsonPath = resolve(import.meta.dirname, '../../package.json')
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageManifest

  it('restricts runtime dependencies to node-pty so only its native module is bundled', () => {
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['node-pty'])
  })

  it('disables unnecessary native npmRebuild, restricts packaged files to out/**/* and runtime icon, unpacks node-pty, and sets Windows icon', () => {
    expect(manifest.build?.npmRebuild).toBe(false)
    expect(manifest.build?.files).toEqual(['out/**/*', 'build/icon.png'])
    expect(manifest.build?.asarUnpack).toContain('node_modules/node-pty/**/*')
    expect(manifest.build?.win?.icon).toBe('build/icon.ico')
  })
})
