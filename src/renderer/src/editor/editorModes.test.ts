import { describe, expect, it } from 'vitest'
import {
  cycleEditorMode,
  getRawEditorLanguage,
  isLinkNavigationClick,
  isMarkdownDocument,
  resolveEditorShortcut,
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

  it('resolves Ctrl/Cmd+S save and mode shortcuts while ignoring alt or non-markdown rich switches', () => {
    expect(
      resolveEditorShortcut({ key: 's', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'raw', false)
    ).toEqual({ type: 'save' })
    expect(
      resolveEditorShortcut({ key: 'S', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false }, 'preview', true)
    ).toEqual({ type: 'save' })

    // Modifier conflicts or unrelated keys do not match save
    expect(
      resolveEditorShortcut({ key: 's', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, 'raw', true)
    ).toBeNull()
    expect(
      resolveEditorShortcut({ key: 's', ctrlKey: true, metaKey: false, shiftKey: false, altKey: true }, 'raw', true)
    ).toBeNull()

    expect(
      resolveEditorShortcut({ key: '2', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'raw', true)
    ).toEqual({ type: 'mode', mode: 'wysiwyg' })
    expect(
      resolveEditorShortcut({ key: 'm', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, 'wysiwyg', true)
    ).toEqual({ type: 'mode', mode: 'preview' })
    expect(
      resolveEditorShortcut({ key: '1', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'raw', false)
    ).toEqual({ type: 'mode', mode: 'raw' })
    expect(
      resolveEditorShortcut({ key: '2', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'raw', false)
    ).toBeNull()
    expect(
      resolveEditorShortcut({ key: 'k', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'raw', true)
    ).toBeNull()
  })

  it('triggers link navigation on normal primary click in Preview mode', () => {
    expect(
      isLinkNavigationClick('preview', {
        button: 0,
        ctrlKey: false,
        metaKey: false,
        altKey: false
      })
    ).toBe(true)

    expect(
      isLinkNavigationClick('preview', {
        button: 1,
        ctrlKey: false,
        metaKey: false,
        altKey: false
      })
    ).toBe(false)
  })

  it('requires Ctrl+click or Meta+click for link navigation in Raw and WYSIWYG modes', () => {
    for (const mode of ['raw', 'wysiwyg'] as const) {
      expect(
        isLinkNavigationClick(mode, {
          button: 0,
          ctrlKey: false,
          metaKey: false,
          altKey: false
        })
      ).toBe(false)

      expect(
        isLinkNavigationClick(mode, {
          button: 0,
          ctrlKey: true,
          metaKey: false,
          altKey: false
        })
      ).toBe(true)

      expect(
        isLinkNavigationClick(mode, {
          button: 0,
          ctrlKey: false,
          metaKey: true,
          altKey: false
        })
      ).toBe(true)

      expect(
        isLinkNavigationClick(mode, {
          button: 0,
          ctrlKey: true,
          metaKey: false,
          altKey: true
        })
      ).toBe(false)
    }
  })
})
