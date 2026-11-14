import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG, normalizeAppConfig, validateConfigPatch } from './config'

describe('shared config validation and normalization', () => {
  it('validates valid partial config updates including favorites and customCommands', () => {
    const patch = validateConfigPatch({
      theme: 'dark',
      autoSave: true,
      autoSaveDelayMs: 2500,
      showHeadingNumbers: false,
      favoriteWorkspaces: [
        { path: 'C:\\wiki', name: 'Wiki', pinnedAt: '2026-11-14T00:00:00.000Z' }
      ],
      recentWorkspaces: ['C:\\wiki'],
      customCommands: [
        {
          trigger: 'function',
          label: 'Function Doc',
          description: 'API function template',
          template: '## {{title}}\n{{cursor}}'
        }
      ]
    })

    expect(patch.theme).toBe('dark')
    expect(patch.favoriteWorkspaces).toHaveLength(1)
    expect(patch.customCommands).toHaveLength(1)
  })

  it('rejects invalid config patch values with descriptive errors', () => {
    expect(() => validateConfigPatch(null)).toThrow(/plain object/i)
    expect(() => validateConfigPatch({ theme: 'solarized' })).toThrow(/theme/i)
    expect(() => validateConfigPatch({ autoSave: 'yes' })).toThrow(/autoSave/i)
    expect(() => validateConfigPatch({ autoSaveDelayMs: 0 })).toThrow(/autoSaveDelayMs/i)
    expect(() => validateConfigPatch({ showHeadingNumbers: 1 })).toThrow(/showHeadingNumbers/i)
    expect(() => validateConfigPatch({ favoriteWorkspaces: [{ path: 123 }] })).toThrow(
      /favoriteWorkspaces/i
    )
    expect(() => validateConfigPatch({ recentWorkspaces: [42] })).toThrow(/recentWorkspaces/i)
    expect(() => validateConfigPatch({ customCommands: [{ trigger: '' }] })).toThrow(
      /customCommands/i
    )
    expect(() => validateConfigPatch({ version: 2 })).toThrow(/version/i)
  })

  it('normalizes persisted config while keeping valid favoriteWorkspaces and customCommands', () => {
    const normalized = normalizeAppConfig({
      favoriteWorkspaces: [
        { path: 'C:\\ok', name: 'OK', pinnedAt: '2026-11-14T00:00:00.000Z' },
        { path: 123 }
      ],
      customCommands: [
        { trigger: 'struct', label: 'Struct', template: '```c\n{{cursor}}\n```' },
        { trigger: 'broken' }
      ]
    })

    expect(normalized.version).toBe(DEFAULT_APP_CONFIG.version)
    expect(normalized.favoriteWorkspaces).toEqual([
      { path: 'C:\\ok', name: 'OK', pinnedAt: '2026-11-14T00:00:00.000Z' }
    ])
    expect(normalized.customCommands).toEqual([
      { trigger: 'struct', label: 'Struct', template: '```c\n{{cursor}}\n```' }
    ])
  })
})
