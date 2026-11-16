import { useCallback, useRef, useState } from 'react'
import type { DirtyTabCloseRequest } from './useEditorWorkspace'

export type ConfirmDialogTone = 'primary' | 'danger'

export interface ConfirmDialogState {
  title: string
  message: string
  confirmLabel: string
  confirmTone?: ConfirmDialogTone
  secondaryLabel?: string
  onConfirm: () => Promise<void> | void
  onSecondary?: () => Promise<void> | void
  onCancel?: () => void
}

export interface UnsavedChangesDialogRequest {
  message: string
  confirmLabel: string
  secondaryLabel: string
  onSave: () => Promise<boolean>
  onResolve: (approved: boolean) => void
}

/**
 * Manages the window's confirm dialog state and unsaved close/action confirmation flows.
 */
export function useConfirmDialog() {
  const [pendingDialog, setPendingDialog] = useState<ConfirmDialogState | null>(null)
  const isDialogOpenRef = useRef<boolean>(false)
  isDialogOpenRef.current = pendingDialog !== null

  const dismissDialog = useCallback((): void => {
    setPendingDialog(null)
  }, [])

  const confirmCloseDirtyTab = useCallback((request: DirtyTabCloseRequest): void => {
    setPendingDialog({
      title: '저장하지 않은 변경 사항',
      message: `"${request.buffer.name}"에 저장하지 않은 변경 사항이 있습니다. 저장하고 닫을까요?`,
      confirmLabel: '저장 후 닫기',
      secondaryLabel: '버리고 닫기',
      onConfirm: async () => {
        setPendingDialog(null)
        await request.saveAndClose()
      },
      onSecondary: () => {
        setPendingDialog(null)
        request.discardAndClose()
      }
    })
  }, [])

  const confirmUnsavedChanges = useCallback((request: UnsavedChangesDialogRequest): (() => void) => {
    let settled = false
    const settle = (approved: boolean): void => {
      if (settled) return
      settled = true
      request.onResolve(approved)
    }

    setPendingDialog({
      title: '저장하지 않은 변경 사항',
      message: request.message,
      confirmLabel: request.confirmLabel,
      secondaryLabel: request.secondaryLabel,
      onConfirm: async () => {
        setPendingDialog(null)
        const saved = await request.onSave()
        settle(saved)
      },
      onSecondary: () => {
        setPendingDialog(null)
        settle(true)
      },
      onCancel: () => settle(false)
    })

    return () => settle(false)
  }, [])

  return {
    pendingDialog,
    setPendingDialog,
    dismissDialog,
    isDialogOpenRef,
    confirmCloseDirtyTab,
    confirmUnsavedChanges
  }
}
