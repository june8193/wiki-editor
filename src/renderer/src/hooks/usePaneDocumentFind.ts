import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentBufferSnapshot } from '@shared/documentBuffer'
import type { SearchMatchOptions } from '@shared/search'
import { getWorkspacePathKey } from '@shared/workspace'
import {
  applyCloseDocumentFind,
  applyOpenDocumentFind,
  applyQueryDocumentFind,
  applyToggleDocumentFind,
  applyToggleOptionDocumentFind,
  createDefaultDocumentFindState,
  type DocumentFindState,
  isDocumentFindShortcut
} from '../editor/documentFind'
import type { DocumentEditorFindControl } from './useDocumentEditorFind'
import { isImageDocument } from '../editor/editorModes'
import { getPaneActiveTab, type PaneId, type PaneLayoutState } from '../stores/PaneTabStore'

export interface UsePaneDocumentFindOptions {
  layout: PaneLayoutState
  buffers: DocumentBufferSnapshot
  workspaceRootPath?: string | null
  isShortcutDisabled: boolean
  shellRef: RefObject<HTMLDivElement | null>
}

type PaneFindStateMap = Record<PaneId, DocumentFindState>

function createInitialPaneFindMap(): PaneFindStateMap {
  return {
    primary: createDefaultDocumentFindState(),
    secondary: createDefaultDocumentFindState()
  }
}

/**
 * Manages independent per-pane in-document Find Bar states (`isOpen`, `query`, `options`),
 * window-level `Ctrl+F` fallback routing scoped to the owning window shell, and resets on workspace switch.
 */
export function usePaneDocumentFind({
  layout,
  buffers,
  workspaceRootPath = null,
  isShortcutDisabled,
  shellRef
}: UsePaneDocumentFindOptions) {
  const [paneStates, setPaneStates] = useState<PaneFindStateMap>(createInitialPaneFindMap)
  const focusNonceRef = useRef(0)
  const handledFocusNoncesRef = useRef<Record<PaneId, number>>({ primary: 0, secondary: 0 })
  const selectionReadersRef = useRef<Record<PaneId, (() => string | null) | null>>({
    primary: null,
    secondary: null
  })
  const layoutRef = useRef(layout)
  const buffersRef = useRef(buffers)
  const isShortcutDisabledRef = useRef(isShortcutDisabled)
  const prevWorkspaceKeyRef = useRef<string | null>(
    workspaceRootPath ? getWorkspacePathKey(workspaceRootPath) : null
  )

  layoutRef.current = layout
  buffersRef.current = buffers
  isShortcutDisabledRef.current = isShortcutDisabled

  useEffect(() => {
    const nextKey = workspaceRootPath ? getWorkspacePathKey(workspaceRootPath) : null
    const prevKey = prevWorkspaceKeyRef.current
    prevWorkspaceKeyRef.current = nextKey
    if (prevKey !== null && nextKey !== prevKey) {
      handledFocusNoncesRef.current = { primary: 0, secondary: 0 }
      setPaneStates(createInitialPaneFindMap())
    }
  }, [workspaceRootPath])

  useEffect(() => {
    setPaneStates((prev) => {
      let nextPrimary = prev.primary
      let nextSecondary = prev.secondary
      if (layout.panes.primary.tabs.length === 0 && prev.primary.isOpen) {
        nextPrimary = { ...prev.primary, isOpen: false }
      }
      if (layout.panes.secondary.tabs.length === 0 && (prev.secondary.isOpen || prev.secondary.query.length > 0)) {
        handledFocusNoncesRef.current.secondary = 0
        nextSecondary = createDefaultDocumentFindState()
      }
      if (nextPrimary === prev.primary && nextSecondary === prev.secondary) {
        return prev
      }
      return {
        primary: nextPrimary,
        secondary: nextSecondary
      }
    })
  }, [layout.panes.primary.tabs.length, layout.panes.secondary.tabs.length])

  const updatePaneState = useCallback(
    (paneId: PaneId, updater: (current: DocumentFindState) => DocumentFindState): void => {
      setPaneStates((prev) => {
        const current = prev[paneId]
        const next = updater(current)
        if (next === current) return prev
        return {
          ...prev,
          [paneId]: next
        }
      })
    },
    []
  )

  const openPaneFind = useCallback(
    (paneId: PaneId, initialQuery?: string | null): void => {
      focusNonceRef.current += 1
      const nonce = focusNonceRef.current
      updatePaneState(paneId, (current) => applyOpenDocumentFind(current, nonce, initialQuery))
    },
    [updatePaneState]
  )

  const togglePaneFind = useCallback(
    (paneId: PaneId): void => {
      focusNonceRef.current += 1
      const nonce = focusNonceRef.current
      updatePaneState(paneId, (current) => applyToggleDocumentFind(current, nonce))
    },
    [updatePaneState]
  )

  const closePaneFind = useCallback(
    (paneId: PaneId): void => {
      updatePaneState(paneId, applyCloseDocumentFind)
    },
    [updatePaneState]
  )

  const changePaneFindQuery = useCallback(
    (paneId: PaneId, nextQuery: string): void => {
      updatePaneState(paneId, (current) => applyQueryDocumentFind(current, nextQuery))
    },
    [updatePaneState]
  )

  const togglePaneFindOption = useCallback(
    (paneId: PaneId, optionKey: keyof SearchMatchOptions): void => {
      updatePaneState(paneId, (current) => applyToggleOptionDocumentFind(current, optionKey))
    },
    [updatePaneState]
  )

  const registerSelectionReader = useCallback(
    (paneId: PaneId, reader: (() => string | null) | null): void => {
      selectionReadersRef.current[paneId] = reader
    },
    []
  )

  const markFocusNonceHandled = useCallback((paneId: PaneId, nonce: number): boolean => {
    if (nonce === 0 || handledFocusNoncesRef.current[paneId] === nonce) {
      return false
    }
    handledFocusNoncesRef.current[paneId] = nonce
    return true
  }, [])

  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isShortcutDisabledRef.current) {
        return
      }
      if (!isDocumentFindShortcut(event)) {
        return
      }

      const shellEl = shellRef.current
      const targetShell =
        event.target instanceof Element ? event.target.closest('.app-shell') : null
      if (shellEl && targetShell && targetShell !== shellEl) {
        return
      }

      const activePaneId = layoutRef.current.activePaneId
      const activeTab = getPaneActiveTab(layoutRef.current.panes[activePaneId])
      if (!activeTab) {
        return
      }

      event.preventDefault()
      if (activeTab.kind === 'diff') {
        return
      }
      const activeBuffer = buffersRef.current[activeTab.bufferKey]
      if (!activeBuffer || isImageDocument(activeBuffer)) {
        return
      }

      const selectedText = selectionReadersRef.current[activePaneId]?.() ?? null
      openPaneFind(activePaneId, selectedText)
    }

    window.addEventListener('keydown', handleWindowKeyDown)
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown)
    }
  }, [openPaneFind, shellRef])

  const buildPaneFindControl = useCallback(
    (paneId: PaneId): DocumentEditorFindControl => ({
      state: paneStates[paneId],
      onOpen: (initialQuery) => openPaneFind(paneId, initialQuery),
      onToggle: () => togglePaneFind(paneId),
      onClose: () => closePaneFind(paneId),
      onChangeQuery: (query) => changePaneFindQuery(paneId, query),
      onToggleOption: (optionKey) => togglePaneFindOption(paneId, optionKey),
      onRegisterSelectionReader: (reader) => registerSelectionReader(paneId, reader),
      onConsumeFocusNonce: (nonce) => markFocusNonceHandled(paneId, nonce)
    }),
    [
      changePaneFindQuery,
      closePaneFind,
      markFocusNonceHandled,
      openPaneFind,
      paneStates,
      registerSelectionReader,
      togglePaneFind,
      togglePaneFindOption
    ]
  )

  const primaryFindControl = useMemo(
    () => buildPaneFindControl('primary'),
    [buildPaneFindControl]
  )
  const secondaryFindControl = useMemo(
    () => buildPaneFindControl('secondary'),
    [buildPaneFindControl]
  )

  const getPaneFindControl = useCallback(
    (paneId: PaneId): DocumentEditorFindControl =>
      paneId === 'secondary' ? secondaryFindControl : primaryFindControl,
    [primaryFindControl, secondaryFindControl]
  )

  return {
    getPaneFindControl
  }
}
