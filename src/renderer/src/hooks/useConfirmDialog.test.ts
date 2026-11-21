import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { promptUnsavedWorkspaceChanges } from '../utils/confirmPrompts'
import { useConfirmDialog } from './useConfirmDialog'

describe('useConfirmDialog & promptUnsavedWorkspaceChanges', () => {
  it('skips confirm dialog when target workspace buffers are clean and prompts/saves scoped targets when dirty', async () => {
    const getDirtySummary = vi
      .fn<(targetPaths?: readonly string[]) => string | null>()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce('notes.md')
      .mockReturnValueOnce('notes.md')
    const saveDirtyBuffers = vi
      .fn<(targetPaths?: readonly string[]) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const { result } = renderHook(() => useConfirmDialog())

    // 1. Clean target -> skips confirm dialog and resolves true immediately
    await expect(
      promptUnsavedWorkspaceChanges(
        { getDirtySummary, saveDirtyBuffers },
        result.current.requestUnsavedChanges,
        {
          targetPaths: ['C:/wiki/clean.md'],
          message: (summary) => `"${summary}" 저장?`,
          confirmLabel: '저장 후 진행',
          secondaryLabel: '저장 없이 진행'
        }
      )
    ).resolves.toBe(true)
    expect(getDirtySummary).toHaveBeenCalledWith(['C:/wiki/clean.md'])
    expect(result.current.pendingDialog).toBeNull()

    // 2. Dirty target + user chooses Save & Proceed -> saves scoped paths and resolves true
    let promptPromise!: Promise<boolean>
    act(() => {
      promptPromise = promptUnsavedWorkspaceChanges(
        { getDirtySummary, saveDirtyBuffers },
        result.current.requestUnsavedChanges,
        {
          targetPaths: ['C:/wiki/notes.md'],
          message: (summary) => `"${summary}"에 미저장 변경 사항`,
          confirmLabel: '저장 후 진행',
          secondaryLabel: '저장 없이 진행'
        }
      )
    })

    expect(result.current.pendingDialog?.message).toBe('"notes.md"에 미저장 변경 사항')
    expect(result.current.isDialogOpenRef.current).toBe(true)

    await act(async () => {
      await result.current.pendingDialog?.onConfirm()
    })
    await expect(promptPromise).resolves.toBe(true)
    expect(saveDirtyBuffers).toHaveBeenCalledWith(['C:/wiki/notes.md'])
    expect(result.current.pendingDialog).toBeNull()
    expect(result.current.isDialogOpenRef.current).toBe(false)

    // 3. Save failure resolves false
    let failedSavePromise!: Promise<boolean>
    act(() => {
      failedSavePromise = promptUnsavedWorkspaceChanges(
        { getDirtySummary, saveDirtyBuffers },
        result.current.requestUnsavedChanges,
        {
          message: (summary) => `"${summary}"에 미저장 변경 사항`,
          confirmLabel: '저장 후 이동',
          secondaryLabel: '버리고 이동'
        }
      )
    })

    await act(async () => {
      await result.current.pendingDialog?.onConfirm()
    })
    await expect(failedSavePromise).resolves.toBe(false)
  })

  it('supports chained danger confirm -> unsaved confirm, blocks concurrent prompts, and cancels pending prompts cleanly', async () => {
    const { result, unmount } = renderHook(() => useConfirmDialog())

    // 1. Open danger confirm and verify synchronous transition into chained unsaved confirm
    let dangerPromise!: Promise<boolean>
    act(() => {
      dangerPromise = result.current.requestConfirm({
        title: '전체 변경 사항 롤백',
        message: '복구 불가',
        confirmLabel: '전체 롤백',
        confirmTone: 'danger'
      })
    })
    expect(result.current.pendingDialog?.confirmTone).toBe('danger')
    expect(result.current.isDialogOpenRef.current).toBe(true)

    // Concurrent requestConfirm while already open resolves false without replacing active dialog
    await expect(
      result.current.requestConfirm({
        title: '중복',
        message: '차단됨',
        confirmLabel: '확인'
      })
    ).resolves.toBe(false)
    expect(result.current.pendingDialog?.title).toBe('전체 변경 사항 롤백')

    // Approving danger confirm synchronously clears isDialogOpenRef so a chained unsaved prompt opens cleanly
    let chainedUnsavedPromise!: Promise<boolean>
    await act(async () => {
      await result.current.pendingDialog?.onConfirm()
      expect(result.current.isDialogOpenRef.current).toBe(false)
      chainedUnsavedPromise = result.current.requestUnsavedChanges({
        message: '저장 후 진행할까요?',
        confirmLabel: '저장 후 진행',
        secondaryLabel: '저장 없이 진행',
        onSave: async () => true
      })
    })
    await expect(dangerPromise).resolves.toBe(true)
    expect(result.current.pendingDialog?.confirmLabel).toBe('저장 후 진행')

    // Secondary action ('저장 없이 진행') resolves true without calling onSave
    await act(async () => {
      await result.current.pendingDialog?.onSecondary?.()
    })
    await expect(chainedUnsavedPromise).resolves.toBe(true)

    // 2. dismissDialog settles open settled confirm with false and clears dialog
    let canceledPromise!: Promise<boolean>
    act(() => {
      canceledPromise = result.current.requestConfirm({
        title: '자동 Stage 후 커밋',
        message: '진행할까요?',
        confirmLabel: 'Stage 후 커밋'
      })
    })
    act(() => {
      result.current.dismissDialog()
    })
    await expect(canceledPromise).resolves.toBe(false)
    expect(result.current.pendingDialog).toBeNull()

    // 2b. Imperative overrides (setPendingDialog / confirmCloseDirtyTab) settle active settled confirms with false
    let overriddenByPendingPromise!: Promise<boolean>
    act(() => {
      overriddenByPendingPromise = result.current.requestConfirm({
        title: 'Stash 삭제',
        message: '영구 삭제',
        confirmLabel: 'Drop',
        confirmTone: 'danger'
      })
    })
    act(() => {
      result.current.setPendingDialog({
        title: '파일 삭제',
        message: '삭제?',
        confirmLabel: '삭제',
        onConfirm: () => undefined
      })
    })
    await expect(overriddenByPendingPromise).resolves.toBe(false)
    expect(result.current.pendingDialog?.title).toBe('파일 삭제')
    act(() => {
      result.current.dismissDialog()
    })

    let overriddenByCloseTabPromise!: Promise<boolean>
    act(() => {
      overriddenByCloseTabPromise = result.current.requestConfirm({
        title: '전체 변경 사항 롤백',
        message: '복구 불가',
        confirmLabel: '전체 롤백'
      })
    })
    act(() => {
      result.current.confirmCloseDirtyTab({
        buffer: {
          key: 'c:/wiki/a.md',
          path: 'C:/wiki/a.md',
          name: 'a.md',
          content: '',
          savedContent: 'old',
          isDirty: true,
          isReadOnly: false,
          isImage: false
        },
        saveAndClose: async () => undefined,
        discardAndClose: () => undefined
      } as never)
    })
    await expect(overriddenByCloseTabPromise).resolves.toBe(false)
    expect(result.current.pendingDialog?.confirmLabel).toBe('저장 후 닫기')

    // 3. Unmount settles any open confirm with false
    let unmountPromise!: Promise<boolean>
    act(() => {
      unmountPromise = result.current.requestConfirm({
        title: 'Stash 삭제',
        message: '영구 삭제',
        confirmLabel: 'Drop',
        confirmTone: 'danger'
      })
    })
    unmount()
    await expect(unmountPromise).resolves.toBe(false)
  })
})
