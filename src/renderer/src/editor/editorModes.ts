import type { DocumentBuffer } from '@shared/documentBuffer'
import type { GitFileStatusCode } from '@shared/git'
import type { EditorMode } from '../stores/PaneTabStore'
import { hasKnownCodeFilename } from './rawEditorLanguage'

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
  | { type: 'suppressed' }

export interface LinkClickModifierState {
  button: number
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

const MODE_ORDER: readonly EditorMode[] = ['raw', 'wysiwyg', 'preview', 'split']

const DIGIT_SHORTCUT_MODES: Readonly<Record<string, EditorMode>> = {
  '1': 'raw',
  '2': 'wysiwyg',
  '3': 'preview',
  '4': 'split'
}

export type EditorModeDocumentRef = Pick<DocumentBuffer, 'kind' | 'name'> & {
  contentKind?: DocumentBuffer['contentKind']
}

export interface SidebarDiffContext {
  rawPatch: string | null
  filePath: string
  status: GitFileStatusCode
}

export interface SidebarDocumentContext {
  documentName: string | null
  documentKey?: string | null
  content: string
  isMarkdownDocument: boolean
  diffContext?: SidebarDiffContext
}

/**
 * Returns true when a buffer holds read-only binary image metadata rather than editable text.
 */
export function isImageDocument(
  doc: { contentKind?: DocumentBuffer['contentKind'] } | null | undefined
): boolean {
  return doc?.contentKind === 'image'
}

/**
 * Determines whether rich Markdown modes (WYSIWYG / Preview / Split) are enabled for a buffer.
 * Extensionless files default to Markdown, while `.json`, `.txt`, `config`, and images are not Markdown.
 */
export function isMarkdownDocument(doc: EditorModeDocumentRef): boolean {
  if (doc.kind === 'config' || isImageDocument(doc)) {
    return false
  }
  const lastDot = doc.name.lastIndexOf('.')
  if (lastDot < 0) {
    return !hasKnownCodeFilename(doc.name)
  }
  const ext = doc.name.slice(lastDot).toLowerCase()
  return ext === '.md' || ext === '.markdown'
}

/**
 * Resolves whether rich Markdown modes are enabled alongside the effective editor mode for a buffer.
 */
export function resolveEffectiveEditorMode(
  doc: EditorModeDocumentRef | null | undefined,
  requestedMode: EditorMode
): { allowRichModes: boolean; effectiveMode: EditorMode } {
  const allowRichModes = doc ? isMarkdownDocument(doc) : false
  return {
    allowRichModes,
    effectiveMode: allowRichModes ? requestedMode : 'raw'
  }
}

/**
 * Cycles editor modes in order: Raw -> WYSIWYG -> Preview -> Split -> Raw.
 */
export function cycleEditorMode(current: EditorMode): EditorMode {
  const index = MODE_ORDER.indexOf(current)
  return MODE_ORDER[(index + 1) % MODE_ORDER.length]
}

/**
 * Resolves Ctrl/Cmd+1/2/3/4 and Ctrl/Cmd+Shift+M mode-switching keyboard shortcuts.
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

  const mappedMode = DIGIT_SHORTCUT_MODES[normalizedKey]
  if (!mappedMode) {
    return null
  }

  return mappedMode === 'raw' || allowRichModes ? mappedMode : null
}

/**
 * Returns true when the keyboard event matches `Ctrl/Cmd+S` (save shortcut).
 */
export function isSaveShortcut(event: ModeShortcutEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 's'
  )
}

/**
 * Resolves global/editor application shortcuts (`Ctrl/Cmd+S` save or mode-switch keys).
 * When `isReadOnly` is true, matching editor shortcuts resolve to `{ type: 'suppressed' }`
 * so callers can block browser defaults without invoking save or mode switches.
 */
export function resolveEditorShortcut(
  event: ModeShortcutEvent,
  currentMode: EditorMode,
  allowRichModes: boolean,
  isReadOnly = false
): EditorShortcutAction | null {
  if (isSaveShortcut(event)) {
    return isReadOnly ? { type: 'suppressed' } : { type: 'save' }
  }
  const mode = resolveModeShortcut(event, currentMode, isReadOnly ? true : allowRichModes)
  if (!mode) {
    return null
  }
  return isReadOnly ? { type: 'suppressed' } : { type: 'mode', mode }
}

/**
 * Determines whether a mouse click should trigger Markdown link navigation in the given editor mode.
 * Preview and WYSIWYG navigate on primary click (as well as Ctrl/Meta+click), whereas Raw
 * requires Ctrl/Meta+click so normal clicks continue to move the editing caret.
 */
export function isLinkNavigationClick(mode: EditorMode, event: LinkClickModifierState): boolean {
  if (event.button !== 0 || event.altKey) {
    return false
  }
  if (mode === 'preview' || mode === 'wysiwyg') {
    return true
  }
  return event.ctrlKey || event.metaKey
}
