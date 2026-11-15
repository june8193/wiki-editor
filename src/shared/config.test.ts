import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APP_CONFIG,
  normalizeAppConfig,
  validateConfigPatch,
  validateConfigRaw
} from './config'

describe('shared config validation and normalization', () => {
  it('validates valid partial config updates including favorites', () => {
    const patch = validateConfigPatch({
      theme: 'dark',
      autoSave: true,
      autoSaveDelayMs: 2500,
      showHeadingNumbers: false,
      favoriteWorkspaces: [
        { path: 'C:\\wiki', name: 'Wiki', pinnedAt: '2026-11-14T00:00:00.000Z' }
      ],
      recentWorkspaces: ['C:\\wiki']
    })

    expect(patch.theme).toBe('dark')
    expect(patch.favoriteWorkspaces).toHaveLength(1)
  })

  it('rejects invalid config patch values with descriptive errors', () => {
    expect(() => validateConfigPatch(null)).toThrow(/plain object/i)
    expect(() => validateConfigPatch({ theme: 'solarized' })).toThrow(/theme/i)
    expect(() => validateConfigPatch({ autoSave: 'yes' })).toThrow(/autoSave/i)
    expect(() => validateConfigPatch({ autoSaveDelayMs: 0 })).toThrow(/autoSaveDelayMs/i)
    expect(() => validateConfigPatch({ autoSaveDelayMs: 0.4 })).toThrow(/autoSaveDelayMs/i)
    expect(() => validateConfigPatch({ showHeadingNumbers: 1 })).toThrow(/showHeadingNumbers/i)
    expect(() => validateConfigPatch({ favoriteWorkspaces: [{ path: 123 }] })).toThrow(
      /favoriteWorkspaces/i
    )
    expect(() => validateConfigPatch({ recentWorkspaces: [42] })).toThrow(/recentWorkspaces/i)
    expect(() => validateConfigPatch({ version: 2 })).toThrow(/version/i)
  })

  it('normalizes persisted config while keeping valid favoriteWorkspaces and ignoring legacy customCommands', () => {
    expect('customCommands' in DEFAULT_APP_CONFIG).toBe(false)

    const normalized = normalizeAppConfig({
      theme: 'dark',
      favoriteWorkspaces: [
        { path: 'C:\\ok', name: 'OK', pinnedAt: '2026-11-14T00:00:00.000Z' },
        { path: 123 }
      ],
      customCommands: [{ trigger: 'legacy', label: 'Legacy', template: 'x' }]
    })

    expect(normalized.version).toBe(DEFAULT_APP_CONFIG.version)
    expect(normalized.theme).toBe('dark')
    expect('customCommands' in normalized).toBe(false)
    expect(normalized.favoriteWorkspaces).toEqual([
      { path: 'C:\\ok', name: 'OK', pinnedAt: '2026-11-14T00:00:00.000Z' }
    ])
  })

  it('validates raw config.json text strictly and rejects malformed JSON, unknown keys including customCommands, and invalid field types', () => {
    const parsed = validateConfigRaw(
      JSON.stringify({
        version: 1,
        theme: 'dark',
        autoSave: true,
        autoSaveDelayMs: 1500
      })
    )
    expect(parsed).toEqual({
      ...DEFAULT_APP_CONFIG,
      theme: 'dark',
      autoSave: true,
      autoSaveDelayMs: 1500
    })

    expect(() => validateConfigRaw('{ broken')).toThrow(/JSON/i)
    expect(() => validateConfigRaw('[]')).toThrow(/plain object/i)
    expect(() => validateConfigRaw('{"unknownKey": true}')).toThrow(/unknown config key/i)
    expect(() =>
      validateConfigRaw(JSON.stringify({ version: 1, customCommands: [] }))
    ).toThrow(/Unknown config key: "customCommands"/)
    expect(() => validateConfigRaw('{"theme": "blue"}')).toThrow(/theme/i)
    expect(() => validateConfigRaw('{"autoSave": "yes"}')).toThrow(/autoSave/i)
  })
})
