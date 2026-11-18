import { useEffect, useRef } from 'react'
import type { WikiApi } from '@shared/ipc'
import type { UnsavedChangesDialogRequest } from './useConfirmDialog'

export interface UseWindowCloseGuardOptions {
  wikiApi: WikiApi
  getDirtySummary: () => string | null
  saveDirtyBuffers: () => Promise<boolean>
  confirmUnsavedChanges: (request: UnsavedChangesDialogRequest) => () => void
  onBeforeShowDialog?: () => void
  onBeforeApproveClose?: () => Promise<void> | void
}

/**
 * Subscribes to main-process window close requests, immediately approves clean closes,
 * or presents an unsaved-changes confirmation dialog before resolving the close gate.
 */
export function useWindowCloseGuard({
  wikiApi,
  getDirtySummary,
  saveDirtyBuffers,
  confirmUnsavedChanges,
  onBeforeShowDialog,
  onBeforeApproveClose
}: UseWindowCloseGuardOptions): void {
  const callbacksRef = useRef({
    getDirtySummary,
    saveDirtyBuffers,
    onBeforeShowDialog,
    onBeforeApproveClose
  })
  callbacksRef.current = {
    getDirtySummary,
    saveDirtyBuffers,
    onBeforeShowDialog,
    onBeforeApproveClose
  }

  const activeCancelRef = useRef<(() => void) | null>(null)

  const hasCloseFlush = Boolean(onBeforeApproveClose)

  useEffect(() => {
    const windowApi = wikiApi.window
    if (!windowApi) return

    if (hasCloseFlush) {
      void windowApi.setCloseFlushEnabled?.(true).catch(() => undefined)
    }

    const resolveApprovedClose = (): void => {
      void Promise.resolve(callbacksRef.current.onBeforeApproveClose?.())
        .catch(() => undefined)
        .then(() => windowApi.resolveCloseRequest(true))
        .catch(() => undefined)
    }

    const unsubscribe = windowApi.onCloseRequested(() => {
      const dirtySummary = callbacksRef.current.getDirtySummary()
      if (!dirtySummary) {
        activeCancelRef.current?.()
        resolveApprovedClose()
        return
      }

      activeCancelRef.current?.()
      callbacksRef.current.onBeforeShowDialog?.()

      activeCancelRef.current = confirmUnsavedChanges({
        message: `"${dirtySummary}"에 저장하지 않은 변경 사항이 있습니다. 저장하고 닫을까요?`,
        confirmLabel: '저장 후 닫기',
        secondaryLabel: '버리고 닫기',
        onSave: () => callbacksRef.current.saveDirtyBuffers(),
        onResolve: (approved) => {
          activeCancelRef.current = null
          if (!approved) {
            void windowApi.resolveCloseRequest(false).catch(() => undefined)
            return
          }
          resolveApprovedClose()
        }
      })
    })

    return () => {
      activeCancelRef.current?.()
      unsubscribe()
      if (hasCloseFlush) {
        void windowApi.setCloseFlushEnabled?.(false).catch(() => undefined)
      }
    }
  }, [confirmUnsavedChanges, hasCloseFlush, wikiApi])
}
