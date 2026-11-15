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

export interface TabViewState {
  mode: EditorMode
  cursor: CursorPosition
  scrollTop: number
}

export interface TabTransferPayload extends TabViewState {
  bufferKey: string
}

export function extractTabViewState(source: TabViewState): TabViewState {
  return {
    mode: source.mode,
    cursor: { ...source.cursor },
    scrollTop: source.scrollTop
  }
}

export function toTabTransferPayload(
  source: { bufferKey: string } & TabViewState
): TabTransferPayload {
  return {
    bufferKey: source.bufferKey,
    ...extractTabViewState(source)
  }
}

export function cloneTabTransferPayloads(
  tabs: readonly TabTransferPayload[]
): TabTransferPayload[] {
  return tabs.map(toTabTransferPayload)
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
