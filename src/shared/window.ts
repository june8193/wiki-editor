export type WindowRole = 'main' | 'auxiliary'

export const WINDOW_ROLE_QUERY_PARAM = 'windowRole'

export function resolveWindowRole(rawRole?: string | null): WindowRole {
  return rawRole === 'auxiliary' ? 'auxiliary' : 'main'
}

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
  /** Hub/IPC window identifier (webContents.id) assigned to the detached auxiliary window. */
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
