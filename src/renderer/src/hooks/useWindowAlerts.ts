import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirtyTabCloseRequest } from './useEditorWorkspace'
import { logRendererError, registerRendererGlobalErrorLogging } from '../logging/rendererLogger'

export interface PendingDialogState {
  title: string
  message: string
  confirmLabel: string
  secondaryLabel?: string
  onConfirm: () => Promise<void> | void
  onSecondary?: () => Promise<void> | void
  onCancel?: () => void
}

/**
 * Owns window-level error banner reporting, modal ConfirmDialog state, dirty-tab close
 * prompts, and global renderer error logging registration.
 */
export function useWindowAlerts() {
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pendingDialog, setPendingDialog] = useState<PendingDialogState | null>(null)
  const isDialogOpenRef = useRef<boolean>(false)
  isDialogOpenRef.current = pendingDialog !== null

  const tabCloseActionsRef = useRef<{
    saveAndCloseTab: (paneId: DirtyTabCloseRequest['paneId'], tabId: string) => Promise<boolean>
    forceCloseTab: (paneId: DirtyTabCloseRequest['paneId'], tabId: string) => void
  }>({
    saveAndCloseTab: async () => false,
    forceCloseTab: () => undefined
  })

  useEffect(() => {
    return registerRendererGlobalErrorLogging()
  }, [])

  const reportErrorBanner = useCallback((message: string | null, error?: unknown): void => {
    setErrorMessage(message)
    if (message) {
      logRendererError('ui', 'Error banner displayed', {
        data: { errorMessage: message },
        ...(error !== undefined ? { error } : {})
      })
    }
  }, [])

  const handleConfirmCloseDirtyTab = useCallback((request: DirtyTabCloseRequest): void => {
    setPendingDialog({
      title: '저장하지 않은 변경 사항',
      message: `"${request.buffer.name}"에 저장하지 않은 변경 사항이 있습니다. 저장하고 닫을까요?`,
      confirmLabel: '저장 후 닫기',
      secondaryLabel: '버리고 닫기',
      onConfirm: async () => {
        setPendingDialog(null)
        await tabCloseActionsRef.current.saveAndCloseTab(request.paneId, request.tabId)
      },
      onSecondary: () => {
        setPendingDialog(null)
        tabCloseActionsRef.current.forceCloseTab(request.paneId, request.tabId)
      }
    })
  }, [])

  const bindTabCloseActions = useCallback(
    (
      saveAndCloseTab: (paneId: DirtyTabCloseRequest['paneId'], tabId: string) => Promise<boolean>,
      forceCloseTab: (paneId: DirtyTabCloseRequest['paneId'], tabId: string) => void
    ): void => {
      tabCloseActionsRef.current = { saveAndCloseTab, forceCloseTab }
    },
    []
  )

  return {
    errorMessage,
    reportErrorBanner,
    pendingDialog,
    setPendingDialog,
    isDialogOpenRef,
    handleConfirmCloseDirtyTab,
    bindTabCloseActions
  }
}
