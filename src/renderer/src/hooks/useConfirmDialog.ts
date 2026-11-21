import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ConfirmActionDialogRequest,
  ConfirmDialogTone,
  UnsavedChangesPromptRequest
} from '../utils/confirmPrompts'
import type { DirtyTabCloseRequest } from './useEditorWorkspace'

export type { ConfirmDialogTone }

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

export interface UnsavedChangesDialogRequest extends UnsavedChangesPromptRequest {
  onResolve: (approved: boolean) => void
}

/**
 * Manages the window's confirm dialog state and unsaved close/action confirmation flows.
 */
export function useConfirmDialog() {
  const [pendingDialog, setPendingDialogState] = useState<ConfirmDialogState | null>(null)
  const isDialogOpenRef = useRef<boolean>(false)
  const activeSettledCancelRef = useRef<(() => void) | null>(null)
  isDialogOpenRef.current = pendingDialog !== null

  const updatePendingDialog = useCallback((next: ConfirmDialogState | null): void => {
    isDialogOpenRef.current = next !== null
    setPendingDialogState(next)
  }, [])

  const setPendingDialog = useCallback(
    (next: ConfirmDialogState | null): void => {
      activeSettledCancelRef.current?.()
      updatePendingDialog(next)
    },
    [updatePendingDialog]
  )

  const dismissDialog = useCallback((): void => {
    if (activeSettledCancelRef.current) {
      activeSettledCancelRef.current()
      return
    }
    updatePendingDialog(null)
  }, [updatePendingDialog])

  useEffect(() => {
    return () => {
      activeSettledCancelRef.current?.()
    }
  }, [])

  const openSettledConfirmDialog = useCallback(
    (
      buildState: (settle: (approved: boolean) => void) => ConfirmDialogState,
      onResolve: (approved: boolean) => void
    ): (() => void) => {
      activeSettledCancelRef.current?.()
      let settled = false
      const settle = (approved: boolean): void => {
        if (settled) return
        settled = true
        if (activeSettledCancelRef.current === cancel) {
          activeSettledCancelRef.current = null
        }
        onResolve(approved)
      }
      const cancel = (): void => {
        updatePendingDialog(null)
        settle(false)
      }
      activeSettledCancelRef.current = cancel
      updatePendingDialog(buildState(settle))
      return cancel
    },
    [updatePendingDialog]
  )

  const confirmCloseDirtyTab = useCallback(
    (request: DirtyTabCloseRequest): void => {
      setPendingDialog({
        title: '저장하지 않은 변경 사항',
        message: `"${request.buffer.name}"에 저장하지 않은 변경 사항이 있습니다. 저장하고 닫을까요?`,
        confirmLabel: '저장 후 닫기',
        secondaryLabel: '버리고 닫기',
        onConfirm: async () => {
          updatePendingDialog(null)
          await request.saveAndClose()
        },
        onSecondary: () => {
          updatePendingDialog(null)
          request.discardAndClose()
        }
      })
    },
    [setPendingDialog, updatePendingDialog]
  )

  const buildUnsavedDialogState = useCallback(
    (
      request: UnsavedChangesPromptRequest,
      closeDialog: () => void,
      settle: (approved: boolean) => void
    ): ConfirmDialogState => ({
      title: '저장하지 않은 변경 사항',
      message: request.message,
      confirmLabel: request.confirmLabel,
      secondaryLabel: request.secondaryLabel,
      onConfirm: async () => {
        closeDialog()
        const saved = await request.onSave()
        settle(saved)
      },
      onSecondary: () => {
        closeDialog()
        settle(true)
      },
      onCancel: () => {
        closeDialog()
        settle(false)
      }
    }),
    []
  )

  const confirmUnsavedChanges = useCallback(
    (request: UnsavedChangesDialogRequest): (() => void) =>
      openSettledConfirmDialog(
        (settle) =>
          buildUnsavedDialogState(request, () => updatePendingDialog(null), settle),
        request.onResolve
      ),
    [buildUnsavedDialogState, openSettledConfirmDialog, updatePendingDialog]
  )

  const tryOpenSettledPrompt = useCallback(
    (
      buildState: (closeDialog: () => void, settle: (approved: boolean) => void) => ConfirmDialogState
    ): Promise<boolean> => {
      if (isDialogOpenRef.current) {
        return Promise.resolve(false)
      }
      const closeDialog = (): void => updatePendingDialog(null)
      return new Promise<boolean>((resolve) => {
        openSettledConfirmDialog((settle) => buildState(closeDialog, settle), resolve)
      })
    },
    [openSettledConfirmDialog, updatePendingDialog]
  )

  const requestUnsavedChanges = useCallback(
    (request: UnsavedChangesPromptRequest): Promise<boolean> =>
      tryOpenSettledPrompt((closeDialog, settle) =>
        buildUnsavedDialogState(request, closeDialog, settle)
      ),
    [buildUnsavedDialogState, tryOpenSettledPrompt]
  )

  const requestConfirm = useCallback(
    (request: ConfirmActionDialogRequest): Promise<boolean> =>
      tryOpenSettledPrompt((closeDialog, settle) => ({
        title: request.title,
        message: request.message,
        confirmLabel: request.confirmLabel,
        confirmTone: request.confirmTone,
        onConfirm: () => {
          closeDialog()
          settle(true)
        },
        onCancel: () => {
          closeDialog()
          settle(false)
        }
      })),
    [tryOpenSettledPrompt]
  )

  return {
    pendingDialog,
    setPendingDialog,
    dismissDialog,
    isDialogOpenRef,
    confirmCloseDirtyTab,
    confirmUnsavedChanges,
    requestUnsavedChanges,
    requestConfirm
  }
}
