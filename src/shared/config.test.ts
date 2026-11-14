import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APP_CONFIG,
  DEFAULT_CUSTOM_COMMANDS,
  normalizeAppConfig,
  validateConfigPatch,
  validateConfigRaw,
  validateCustomCommandTrigger
} from './config'

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
    expect(() => validateConfigPatch({ autoSaveDelayMs: 0.4 })).toThrow(/autoSaveDelayMs/i)
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

  it('validates raw config.json text strictly and rejects malformed JSON, unknown keys, and invalid field types', () => {
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
    expect(() => validateConfigRaw('{"theme": "blue"}')).toThrow(/theme/i)
    expect(() => validateConfigRaw('{"autoSave": "yes"}')).toThrow(/autoSave/i)
    expect(() =>
      validateConfigRaw(
        JSON.stringify({
          customCommands: [{ trigger: 'bad trigger', label: 'Bad', template: 'x' }]
        })
      )
    ).toThrow(/customCommands/i)
    expect(() =>
      validateConfigRaw(
        JSON.stringify({
          customCommands: [
            { trigger: 'note', label: 'Note 1', template: 'a' },
            { trigger: 'Note', label: 'Note 2', template: 'b' }
          ]
        })
      )
    ).toThrow(/customCommands/i)
  })

  it('seeds built-in custom commands by default and validates trigger syntax & uniqueness', () => {
    const triggers = DEFAULT_APP_CONFIG.customCommands.map((cmd) => cmd.trigger)
    expect(DEFAULT_CUSTOM_COMMANDS.length).toBeGreaterThanOrEqual(4)
    expect(triggers).toEqual(expect.arrayContaining(['function', 'struct', 'table', 'mermaid', 'toc']))

    expect(validateCustomCommandTrigger('function')).toBeNull()
    expect(validateCustomCommandTrigger('api-doc_2')).toBeNull()
    expect(validateCustomCommandTrigger('함수')).toBeNull()
    expect(validateCustomCommandTrigger('')).not.toBeNull()
    expect(validateCustomCommandTrigger('my cmd')).not.toBeNull()
    expect(validateCustomCommandTrigger('/function')).not.toBeNull()
    expect(validateCustomCommandTrigger('bad!')).not.toBeNull()
    expect(validateCustomCommandTrigger('Function', ['function'])).not.toBeNull()

    expect(() =>
      validateConfigPatch({
        customCommands: [{ trigger: 'has space', label: 'Bad', template: 'x' }]
      })
    ).toThrow(/customCommands/i)
    expect(() =>
      validateConfigPatch({
        customCommands: [{ trigger: '/slash', label: 'Bad', template: 'x' }]
      })
    ).toThrow(/customCommands/i)
    expect(() =>
      validateConfigPatch({
        customCommands: [
          { trigger: 'dup', label: 'One', template: '1' },
          { trigger: 'DUP', label: 'Two', template: '2' }
        ]
      })
    ).toThrow(/customCommands/i)

    const deduped = normalizeAppConfig({
      customCommands: [
        { trigger: 'valid', label: 'First', template: 'one' },
        { trigger: 'VALID', label: 'Duplicate', template: 'two' },
        { trigger: 'bad space', label: 'Bad', template: 'three' }
      ]
    })
    expect(deduped.customCommands).toEqual([{ trigger: 'valid', label: 'First', template: 'one' }])

    const cleared = normalizeAppConfig({ customCommands: [] })
    expect(cleared.customCommands).toEqual([])
  })
})
