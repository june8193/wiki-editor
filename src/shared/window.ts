export type WindowRole = 'main' | 'auxiliary'

export type EditorMode = 'raw' | 'preview' | 'wysiwyg'

export interface CursorPosition {
  selectionStart: number
  selectionEnd: number
}

export interface TabTransferPayload {
  bufferKey: string
  mode: EditorMode
  cursor: CursorPosition
  scrollTop: number
}

export interface WindowInitContext {
  role: WindowRole
  initialTabs: TabTransferPayload[]
}

export interface DetachTabToNewWindowResult {
  windowId: number
}

export const WINDOW_BASE_TITLE = 'Wiki Editor'

/**
 * Formats an OS window title from the active document display name.
 */
export function formatWindowTitle(activeDocumentName?: string | null): string {
  const trimmed = activeDocumentName?.trim()
  return trimmed ? `${trimmed} - ${WINDOW_BASE_TITLE}` : WINDOW_BASE_TITLE
}
