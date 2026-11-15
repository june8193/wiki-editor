import { useEffect, useRef } from 'react'
import type { WikiApi } from '@shared/ipc'
import type { UnsavedChangesDialogRequest } from './useConfirmDialog'

export interface UseWindowCloseGuardOptions {
  wikiApi: WikiApi
  getDirtySummary: () => string | null
  saveDirtyBuffers: () => Promise<boolean>
  confirmUnsavedChanges: (request: UnsavedChangesDialogRequest) => () => void
  onBeforeShowDialog?: () => void
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
  onBeforeShowDialog
}: UseWindowCloseGuardOptions): void {
  const callbacksRef = useRef({
    getDirtySummary,
    saveDirtyBuffers,
    onBeforeShowDialog
  })
  callbacksRef.current = {
    getDirtySummary,
    saveDirtyBuffers,
    onBeforeShowDialog
  }

  const activeCancelRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const windowApi = wikiApi.window
    if (!windowApi) return

    const unsubscribe = windowApi.onCloseRequested(() => {
      const dirtySummary = callbacksRef.current.getDirtySummary()
      if (!dirtySummary) {
        activeCancelRef.current?.()
        void windowApi.resolveCloseRequest(true).catch(() => undefined)
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
          void windowApi.resolveCloseRequest(approved).catch(() => undefined)
        }
      })
    })

    return () => {
      activeCancelRef.current?.()
      unsubscribe()
    }
  }, [confirmUnsavedChanges, wikiApi])
}
