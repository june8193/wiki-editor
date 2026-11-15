import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { WikiApi } from '@shared/ipc'
import type { ConfirmDialogState } from './useConfirmDialog'

export interface UseWindowCloseGuardOptions {
  wikiApi: WikiApi
  getDirtySummary: () => string | null
  saveDirtyBuffers: () => Promise<boolean>
  setPendingDialog: Dispatch<SetStateAction<ConfirmDialogState | null>>
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
  setPendingDialog,
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

      let settled = false
      const settle = (approved: boolean): void => {
        if (settled) return
        settled = true
        activeCancelRef.current = null
        void windowApi.resolveCloseRequest(approved).catch(() => undefined)
      }
      activeCancelRef.current = () => settle(false)

      setPendingDialog({
        title: '저장하지 않은 변경 사항',
        message: `"${dirtySummary}"에 저장하지 않은 변경 사항이 있습니다. 저장하고 닫을까요?`,
        confirmLabel: '저장 후 닫기',
        secondaryLabel: '버리고 닫기',
        onConfirm: async () => {
          setPendingDialog(null)
          const saved = await callbacksRef.current.saveDirtyBuffers()
          settle(saved)
        },
        onSecondary: () => {
          setPendingDialog(null)
          settle(true)
        },
        onCancel: () => settle(false)
      })
    })

    return () => {
      activeCancelRef.current?.()
      unsubscribe()
    }
  }, [setPendingDialog, wikiApi])
}
