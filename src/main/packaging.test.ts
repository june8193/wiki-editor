import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface PackageManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  build?: {
    npmRebuild?: boolean
    files?: string[]
    win?: {
      icon?: string
    }
  }
}

describe('package.json Electron packaging configuration', () => {
  const packageJsonPath = resolve(import.meta.dirname, '../../package.json')
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageManifest

  it('keeps runtime dependencies empty so electron-builder does not pack bundled node_modules into app.asar', () => {
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([])
  })

  it('disables unnecessary native npmRebuild, restricts packaged files to out/**/* and runtime icon, and sets Windows icon', () => {
    expect(manifest.build?.npmRebuild).toBe(false)
    expect(manifest.build?.files).toEqual(['out/**/*', 'build/icon.png'])
    expect(manifest.build?.win?.icon).toBe('build/icon.ico')
  })
})
