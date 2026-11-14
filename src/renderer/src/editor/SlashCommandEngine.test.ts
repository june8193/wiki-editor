import { describe, expect, it } from 'vitest'
import { DEFAULT_CUSTOM_COMMANDS, type CustomCommandConfig } from '@shared/config'
import {
  applySlashCommandToText,
  deriveDocumentTitle,
  detectSlashQuery,
  expandSlashTemplate,
  filterSlashCommands,
  resolveSlashCommandSnippet
} from './SlashCommandEngine'

describe('SlashCommandEngine', () => {
  it('detects slash queries after line start or whitespace and ignores URLs, mid-word slashes, spaces, and code fences', () => {
    expect(detectSlashQuery('/', 1)).toEqual({ query: '', rangeFrom: 0, rangeTo: 1 })
    expect(detectSlashQuery('/fun', 4)).toEqual({ query: 'fun', rangeFrom: 0, rangeTo: 4 })
    expect(detectSlashQuery('Intro\n- /str', 12)).toEqual({
      query: 'str',
      rangeFrom: 8,
      rangeTo: 12
    })
    expect(detectSlashQuery('Hello\t/mer', 10)).toEqual({
      query: 'mer',
      rangeFrom: 6,
      rangeTo: 10
    })

    // Non-triggers
    expect(detectSlashQuery('https://example.com', 8)).toBeNull()
    expect(detectSlashQuery('https://example.com/api', 23)).toBeNull()
    expect(detectSlashQuery('foo/bar', 7)).toBeNull()
    expect(detectSlashQuery('[about](/about)', 14)).toBeNull()
    expect(detectSlashQuery('// comment', 10)).toBeNull()
    expect(detectSlashQuery('/func arg', 9)).toBeNull()
    expect(detectSlashQuery('plain text', 10)).toBeNull()

    // Code fences ignored by default
    const fenced = ['# Doc', '', '```ts', '/function', '```', '', '/struct'].join('\n')
    expect(detectSlashQuery(fenced, fenced.indexOf('/function') + 9)).toBeNull()
    expect(detectSlashQuery(fenced, fenced.length)).toEqual({
      query: 'struct',
      rangeFrom: fenced.lastIndexOf('/struct'),
      rangeTo: fenced.length
    })
  })

  it('filters commands by prefix priority (exact > prefix > substring > label/description)', () => {
    const commands: CustomCommandConfig[] = [
      {
        trigger: 'my-func',
        label: 'Helper',
        description: 'Utility helper',
        template: 'helper'
      },
      {
        trigger: 'function',
        label: 'Function Doc',
        description: 'API spec',
        template: 'fn'
      },
      {
        trigger: 'fun',
        label: 'Short Fun',
        template: 'short'
      },
      {
        trigger: 'note',
        label: 'Function Note',
        description: 'Notes for fun work',
        template: 'note'
      }
    ]

    expect(filterSlashCommands(commands, '').map((c) => c.trigger)).toEqual([
      'my-func',
      'function',
      'fun',
      'note'
    ])
    expect(filterSlashCommands(commands, 'fun').map((c) => c.trigger)).toEqual([
      'fun', // exact match first
      'function', // prefix match second
      'my-func', // trigger substring third
      'note' // label/description match fourth
    ])
    expect(filterSlashCommands(commands, 'FUN').map((c) => c.trigger)).toEqual([
      'fun',
      'function',
      'my-func',
      'note'
    ])
    expect(filterSlashCommands(commands, 'nonexistent')).toEqual([])
  })

  it('expands {{date}}, {{title}}, and {{cursor}} placeholders and computes exact cursor offset', () => {
    expect(deriveDocumentTitle('architecture-guide.md')).toBe('architecture-guide')
    expect(deriveDocumentTitle('notes.MARKDOWN')).toBe('notes')
    expect(deriveDocumentTitle('')).toBe('Untitled')
    expect(deriveDocumentTitle(undefined)).toBe('Untitled')

    const fixedDate = new Date(2026, 10, 5) // 2026-11-05 local
    const expanded = expandSlashTemplate(
      '# {{title}}\nDate: {{date}}\n\n### `{{cursor}}`\nNotes{{cursor}}',
      {
        fileName: 'api-ref.md',
        now: fixedDate
      }
    )

    expect(expanded.hasCursorPlaceholder).toBe(true)
    expect(expanded.text).toBe('# api-ref\nDate: 2026-11-05\n\n### ``\nNotes')
    // Cursor offset should sit exactly between the backticks on line 4
    expect(expanded.cursorOffset).toBe('# api-ref\nDate: 2026-11-05\n\n### `'.length)
    expect(expanded.text.slice(expanded.cursorOffset)).toBe('`\nNotes')

    const withoutCursor = expandSlashTemplate('Date: {{date}} - {{title}}', {
      title: 'Custom Title',
      date: '2026-11-14'
    })
    expect(withoutCursor.hasCursorPlaceholder).toBe(false)
    expect(withoutCursor.text).toBe('Date: 2026-11-14 - Custom Title')
    expect(withoutCursor.cursorOffset).toBe(withoutCursor.text.length)
  })

  it('applies slash command replacement to LF and CRLF documents preserving line endings and cursor offset', () => {
    const cmd: CustomCommandConfig = {
      trigger: 'fn',
      label: 'Fn',
      template: '### {{title}}\nDate: {{date}}\nBody: {{cursor}}end'
    }

    const lfDoc = '# Top\n\n/fn\n\nAfter'
    const lfMatch = detectSlashQuery(lfDoc, lfDoc.indexOf('/fn') + 3)!
    const lfResult = applySlashCommandToText(lfDoc, lfMatch, cmd, {
      fileName: 'guide.md',
      date: '2026-11-14'
    })
    expect(lfResult.content).toBe('# Top\n\n### guide\nDate: 2026-11-14\nBody: end\n\nAfter')
    expect(lfResult.content.slice(lfResult.cursorOffset, lfResult.cursorOffset + 3)).toBe('end')

    const crlfDoc = '# Top\r\n\r\n/fn\r\n\r\nAfter'
    const crlfMatch = detectSlashQuery(crlfDoc, crlfDoc.indexOf('/fn') + 3)!
    const crlfResult = applySlashCommandToText(crlfDoc, crlfMatch, cmd, {
      fileName: 'guide.md',
      date: '2026-11-14'
    })
    expect(crlfResult.content).toBe(
      '# Top\r\n\r\n### guide\r\nDate: 2026-11-14\r\nBody: end\r\n\r\nAfter'
    )
    expect(crlfResult.content.slice(crlfResult.cursorOffset, crlfResult.cursorOffset + 3)).toBe('end')
  })

  it('generates live TOC markup for the default toc command while honoring user-customized toc templates', () => {
    const defaultToc = DEFAULT_CUSTOM_COMMANDS.find((cmd) => cmd.trigger === 'toc')!
    const doc = '# Overview\n\n/toc\n\n## Details'
    const resolved = resolveSlashCommandSnippet(doc, defaultToc)
    expect(resolved.text).toContain('<!-- toc -->')
    expect(resolved.text).toContain('- [Overview](#overview)')
    expect(resolved.text).toContain('  - [Details](#details)')
    expect(resolved.text).toContain('<!-- /toc -->')

    const customToc: CustomCommandConfig = {
      trigger: 'toc',
      label: 'Custom TOC',
      template: '## Contents\n{{cursor}}'
    }
    const customResolved = resolveSlashCommandSnippet(doc, customToc)
    expect(customResolved.text).toBe('## Contents\n')
    expect(customResolved.cursorOffset).toBe('## Contents\n'.length)
  })
})
