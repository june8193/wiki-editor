import type { DocumentBuffer } from '@shared/documentBuffer'
import type { EditorMode } from '../stores/PaneTabStore'

export interface ModeShortcutEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export type EditorShortcutAction =
  | { type: 'save' }
  | { type: 'mode'; mode: EditorMode }

const MODE_ORDER: readonly EditorMode[] = ['raw', 'wysiwyg', 'preview']

/**
 * Determines whether rich Markdown modes (WYSIWYG / Preview) are enabled for a buffer.
 * Extensionless files default to Markdown, while `.json`, `.txt`, and `config` stay Raw-only.
 */
export function isMarkdownDocument(doc: Pick<DocumentBuffer, 'kind' | 'name'>): boolean {
  if (doc.kind === 'config') {
    return false
  }
  const lastDot = doc.name.lastIndexOf('.')
  if (lastDot < 0) {
    return true
  }
  const ext = doc.name.slice(lastDot).toLowerCase()
  return ext === '.md' || ext === '.markdown'
}

/**
 * Resolves the CodeMirror syntax language for Raw mode.
 */
export function getRawEditorLanguage(doc: Pick<DocumentBuffer, 'kind' | 'name'>): 'markdown' | 'json' {
  if (doc.kind === 'config' || doc.name.toLowerCase().endsWith('.json')) {
    return 'json'
  }
  return 'markdown'
}

/**
 * Cycles editor modes in order: Raw -> WYSIWYG -> Preview -> Raw.
 */
export function cycleEditorMode(current: EditorMode): EditorMode {
  const index = MODE_ORDER.indexOf(current)
  return MODE_ORDER[(index + 1) % MODE_ORDER.length]
}

/**
 * Resolves Ctrl/Cmd+1/2/3 and Ctrl/Cmd+Shift+M mode-switching keyboard shortcuts.
 */
export function resolveModeShortcut(
  event: ModeShortcutEvent,
  currentMode: EditorMode,
  allowRichModes: boolean
): EditorMode | null {
  const hasPrimaryModifier = event.ctrlKey || event.metaKey
  if (!hasPrimaryModifier || event.altKey) {
    return null
  }

  const normalizedKey = event.key.toLowerCase()
  if (event.shiftKey && normalizedKey === 'm') {
    return allowRichModes ? cycleEditorMode(currentMode) : null
  }

  if (event.shiftKey) {
    return null
  }

  if (normalizedKey === '1') {
    return 'raw'
  }
  if (normalizedKey === '2') {
    return allowRichModes ? 'wysiwyg' : null
  }
  if (normalizedKey === '3') {
    return allowRichModes ? 'preview' : null
  }

  return null
}

/**
 * Resolves global/editor application shortcuts (`Ctrl/Cmd+S` save or mode-switch keys).
 */
export function resolveEditorShortcut(
  event: ModeShortcutEvent,
  currentMode: EditorMode,
  allowRichModes: boolean
): EditorShortcutAction | null {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
    return { type: 'save' }
  }
  const mode = resolveModeShortcut(event, currentMode, allowRichModes)
  return mode ? { type: 'mode', mode } : null
}
