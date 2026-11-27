import { describe, expect, it } from 'vitest'
import {
  cycleEditorMode,
  isImageDocument,
  isLinkNavigationClick,
  isMarkdownDocument,
  isSaveShortcut,
  resolveEditorShortcut,
  resolveEffectiveEditorMode,
  resolveModeShortcut
} from './editorModes'

describe('editorModes helpers', () => {
  it('identifies markdown vs non-markdown/config documents accurately', () => {
    expect(isMarkdownDocument({ kind: 'workspace', name: 'readme.md' })).toBe(true)
    expect(isMarkdownDocument({ kind: 'workspace', name: 'Guide.MARKDOWN' })).toBe(true)
    expect(isMarkdownDocument({ kind: 'workspace', name: 'scratch-note' })).toBe(true)
    expect(isMarkdownDocument({ kind: 'workspace', name: 'Dockerfile' })).toBe(false)
    expect(isMarkdownDocument({ kind: 'workspace', name: 'Gemfile' })).toBe(false)
    expect(isMarkdownDocument({ kind: 'config', name: 'config.json' })).toBe(false)
    expect(isMarkdownDocument({ kind: 'workspace', name: 'settings.json' })).toBe(false)
    expect(isMarkdownDocument({ kind: 'workspace', name: 'notes.txt' })).toBe(false)

    expect(resolveEffectiveEditorMode({ kind: 'workspace', name: 'readme.md' }, 'split')).toEqual({
      allowRichModes: true,
      effectiveMode: 'split'
    })
    expect(resolveEffectiveEditorMode({ kind: 'workspace', name: 'notes.txt' }, 'split')).toEqual({
      allowRichModes: false,
      effectiveMode: 'raw'
    })
    expect(resolveEffectiveEditorMode(undefined, 'split')).toEqual({
      allowRichModes: false,
      effectiveMode: 'raw'
    })
  })

  it('cycles modes and resolves Ctrl/Cmd+1/2/3/4 and Ctrl/Cmd+Shift+M shortcuts', () => {
    expect(cycleEditorMode('raw')).toBe('wysiwyg')
    expect(cycleEditorMode('wysiwyg')).toBe('preview')
    expect(cycleEditorMode('preview')).toBe('split')
    expect(cycleEditorMode('split')).toBe('raw')

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
      resolveModeShortcut({ key: '4', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'raw', true)
    ).toBe('split')
    expect(
      resolveModeShortcut({ key: '4', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false }, 'raw', true)
    ).toBe('split')
    expect(
      resolveModeShortcut({ key: 'M', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, 'wysiwyg', true)
    ).toBe('preview')
    expect(
      resolveModeShortcut({ key: 'M', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, 'preview', true)
    ).toBe('split')
    expect(
      resolveModeShortcut({ key: 'M', ctrlKey: false, metaKey: true, shiftKey: true, altKey: false }, 'split', true)
    ).toBe('raw')

    // Non-markdown docs cannot switch to wysiwyg/preview/split via shortcuts
    expect(
      resolveModeShortcut({ key: '2', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'raw', false)
    ).toBeNull()
    expect(
      resolveModeShortcut({ key: '4', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'raw', false)
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
      resolveEditorShortcut({ key: '4', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'raw', true)
    ).toEqual({ type: 'mode', mode: 'split' })
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
      resolveEditorShortcut({ key: '4', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'raw', false)
    ).toBeNull()
    expect(
      resolveEditorShortcut({ key: 'k', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'raw', true)
    ).toBeNull()
  })

  it('triggers link navigation on normal primary click and Ctrl/Meta+click in Preview and WYSIWYG modes', () => {
    for (const mode of ['preview', 'wysiwyg'] as const) {
      expect(
        isLinkNavigationClick(mode, {
          button: 0,
          ctrlKey: false,
          metaKey: false,
          altKey: false
        })
      ).toBe(true)

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
          button: 1,
          ctrlKey: false,
          metaKey: false,
          altKey: false
        })
      ).toBe(false)

      expect(
        isLinkNavigationClick(mode, {
          button: 0,
          ctrlKey: false,
          metaKey: false,
          altKey: true
        })
      ).toBe(false)

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

  it('requires Ctrl+click or Meta+click for link navigation in Raw mode', () => {
    expect(
      isLinkNavigationClick('raw', {
        button: 0,
        ctrlKey: false,
        metaKey: false,
        altKey: false
      })
    ).toBe(false)

    expect(
      isLinkNavigationClick('raw', {
        button: 0,
        ctrlKey: true,
        metaKey: false,
        altKey: false
      })
    ).toBe(true)

    expect(
      isLinkNavigationClick('raw', {
        button: 0,
        ctrlKey: false,
        metaKey: true,
        altKey: false
      })
    ).toBe(true)

    expect(
      isLinkNavigationClick('raw', {
        button: 0,
        ctrlKey: true,
        metaKey: false,
        altKey: true
      })
    ).toBe(false)
  })

  it('disables markdown modes, save shortcut, and mode shortcuts for read-only image buffers', () => {
    const imageDoc = { kind: 'workspace' as const, contentKind: 'image' as const, name: 'diagram.png' }
    const textDoc = { kind: 'workspace' as const, contentKind: 'text' as const, name: 'guide.md' }

    expect(isImageDocument(imageDoc)).toBe(true)
    expect(isImageDocument(textDoc)).toBe(false)
    expect(isMarkdownDocument(imageDoc)).toBe(false)
    expect(resolveEffectiveEditorMode(imageDoc, 'split')).toEqual({
      allowRichModes: false,
      effectiveMode: 'raw'
    })

    expect(
      isSaveShortcut({ key: 's', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })
    ).toBe(true)
    expect(
      resolveEditorShortcut({ key: 's', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'raw', false, true)
    ).toEqual({ type: 'suppressed' })
    expect(
      resolveEditorShortcut({ key: '1', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'raw', false, true)
    ).toEqual({ type: 'suppressed' })
    expect(
      resolveEditorShortcut({ key: '2', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'raw', false, true)
    ).toEqual({ type: 'suppressed' })
    expect(
      resolveEditorShortcut({ key: 'M', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, 'raw', false, true)
    ).toEqual({ type: 'suppressed' })
    expect(
      resolveEditorShortcut({ key: 'k', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'raw', false, true)
    ).toBeNull()
  })
})
