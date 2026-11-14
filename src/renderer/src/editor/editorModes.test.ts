import { describe, expect, it } from 'vitest'
import {
  cycleEditorMode,
  getRawEditorLanguage,
  isMarkdownDocument,
  resolveModeShortcut
} from './editorModes'

describe('editorModes helpers', () => {
  it('identifies markdown vs non-markdown/config documents accurately', () => {
    expect(isMarkdownDocument({ kind: 'workspace', name: 'readme.md' })).toBe(true)
    expect(isMarkdownDocument({ kind: 'workspace', name: 'Guide.MARKDOWN' })).toBe(true)
    expect(isMarkdownDocument({ kind: 'workspace', name: 'scratch-note' })).toBe(true)
    expect(isMarkdownDocument({ kind: 'config', name: 'config.json' })).toBe(false)
    expect(isMarkdownDocument({ kind: 'workspace', name: 'settings.json' })).toBe(false)
    expect(isMarkdownDocument({ kind: 'workspace', name: 'notes.txt' })).toBe(false)

    expect(getRawEditorLanguage({ kind: 'config', name: 'config.json' })).toBe('json')
    expect(getRawEditorLanguage({ kind: 'workspace', name: 'data.json' })).toBe('json')
    expect(getRawEditorLanguage({ kind: 'workspace', name: 'doc.md' })).toBe('markdown')
  })

  it('cycles modes and resolves Ctrl+1/2/3 and Ctrl+Shift+M shortcuts', () => {
    expect(cycleEditorMode('raw')).toBe('wysiwyg')
    expect(cycleEditorMode('wysiwyg')).toBe('preview')
    expect(cycleEditorMode('preview')).toBe('raw')

    expect(
      resolveModeShortcut({ key: '1', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'raw', true)
    ).toBe('raw')
    expect(
      resolveModeShortcut({ key: '2', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'raw', true)
    ).toBe('wysiwyg')
    expect(
      resolveModeShortcut({ key: '3', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'raw', true)
    ).toBe('preview')
    expect(
      resolveModeShortcut({ key: 'M', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, 'wysiwyg', true)
    ).toBe('preview')

    // Non-markdown docs cannot switch to wysiwyg/preview via shortcuts
    expect(
      resolveModeShortcut({ key: '2', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'raw', false)
    ).toBeNull()
    expect(
      resolveModeShortcut({ key: 'M', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, 'raw', false)
    ).toBeNull()
  })
})
