import { useCallback, useMemo, useState } from 'react'
import type { DocumentSearchJumpRequest } from '@shared/search'
import type { PreviewJumpHighlightQuery } from '../editor/previewSearchHighlight'
import type { RawJumpHighlightRequest } from '../editor/rawSearchHighlight'
import type { EditorMode } from '../stores/PaneTabStore'

export type DocumentJumpHighlightTarget = Omit<DocumentSearchJumpRequest, 'paneId' | 'tabId'>

interface AcceptedJumpRecord {
  nonce: number
  tabId: string
  documentKey: string
  effectiveMode: EditorMode
  dismissed: boolean
}

export interface UseDocumentSearchJumpOptions {
  tabId: string
  documentKey: string
  effectiveMode: EditorMode
  isImage: boolean
  searchJumpRequest?: DocumentSearchJumpRequest | null
}

function toJumpTarget(jump: DocumentSearchJumpRequest): DocumentJumpHighlightTarget {
  return {
    query: jump.query,
    options: jump.options,
    lineNumber: jump.lineNumber,
    columnStart: jump.columnStart,
    columnEnd: jump.columnEnd,
    nonce: jump.nonce
  }
}

/**
 * Coordinates temporary workspace search jump highlights for a single Document Editor tab,
 * automatically clearing on user edit, Editor Mode change, tab/document switch, or new jump.
 */
export function useDocumentSearchJump({
  tabId,
  documentKey,
  effectiveMode,
  isImage,
  searchJumpRequest = null
}: UseDocumentSearchJumpOptions) {
  const [accepted, setAccepted] = useState<AcceptedJumpRecord | null>(null)
  const incoming =
    !isImage && searchJumpRequest && searchJumpRequest.tabId === tabId ? searchJumpRequest : null

  let nextAccepted = accepted
  if (!incoming) {
    if (accepted !== null) {
      nextAccepted = null
    }
  } else if (!accepted || accepted.nonce !== incoming.nonce) {
    nextAccepted = {
      nonce: incoming.nonce,
      tabId,
      documentKey,
      effectiveMode,
      dismissed: false
    }
  } else if (
    !accepted.dismissed &&
    (accepted.tabId !== tabId ||
      accepted.documentKey !== documentKey ||
      accepted.effectiveMode !== effectiveMode)
  ) {
    nextAccepted = { ...accepted, dismissed: true }
  }

  if (nextAccepted !== accepted) {
    setAccepted(nextAccepted)
  }

  const activeJump = incoming && nextAccepted && !nextAccepted.dismissed ? incoming : null

  const dismissJump = useCallback((): void => {
    setAccepted((prev) => (prev && !prev.dismissed ? { ...prev, dismissed: true } : prev))
  }, [])

  const rawJumpHighlight = useMemo<RawJumpHighlightRequest | null>(() => {
    if (!activeJump || (effectiveMode !== 'raw' && effectiveMode !== 'split')) {
      return null
    }
    return {
      lineNumber: activeJump.lineNumber,
      columnStart: activeJump.columnStart,
      columnEnd: activeJump.columnEnd,
      nonce: activeJump.nonce
    }
  }, [activeJump, effectiveMode])

  const wysiwygJumpHighlight = useMemo<DocumentJumpHighlightTarget | null>(() => {
    if (!activeJump || effectiveMode !== 'wysiwyg') {
      return null
    }
    return toJumpTarget(activeJump)
  }, [activeJump, effectiveMode])

  const previewJumpHighlight = useMemo<PreviewJumpHighlightQuery | null>(() => {
    if (!activeJump || (effectiveMode !== 'preview' && effectiveMode !== 'split')) {
      return null
    }
    return {
      ...toJumpTarget(activeJump),
      suppressScroll: effectiveMode === 'split'
    }
  }, [activeJump, effectiveMode])

  return {
    rawJumpHighlight,
    wysiwygJumpHighlight,
    previewJumpHighlight,
    dismissJump
  }
}
