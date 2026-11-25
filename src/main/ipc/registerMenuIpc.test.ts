import { describe, expect, it, vi } from 'vitest'
import { MENU_IPC_CHANNELS } from '@shared/ipc'
import { createFakeIpcMain } from './ipcTestHelpers'
import { registerMenuIpc } from './registerMenuIpc'

describe('registerMenuIpc', () => {
  it('dispatches valid main menu actions, rejects invalid ones, and cleans up on dispose', async () => {
    const ipcMain = createFakeIpcMain()
    const onQuit = vi.fn()
    const onCopyBugReport = vi.fn()
    const onOpenLogFolder = vi.fn()
    const onShowVersion = vi.fn()

    const dispose = registerMenuIpc({
      ipcMain,
      onQuit,
      onCopyBugReport,
      onOpenLogFolder,
      onShowVersion
    })

    expect(ipcMain.hasHandler(MENU_IPC_CHANNELS.runAction)).toBe(true)

    await ipcMain.invoke(MENU_IPC_CHANNELS.runAction, 'quit')
    await ipcMain.invoke(MENU_IPC_CHANNELS.runAction, 'copy-bug-report')
    await ipcMain.invoke(MENU_IPC_CHANNELS.runAction, 'open-log-folder')
    await ipcMain.invoke(MENU_IPC_CHANNELS.runAction, 'show-version')

    expect(onQuit).toHaveBeenCalledTimes(1)
    expect(onCopyBugReport).toHaveBeenCalledTimes(1)
    expect(onOpenLogFolder).toHaveBeenCalledTimes(1)
    expect(onShowVersion).toHaveBeenCalledTimes(1)

    await expect(ipcMain.invoke(MENU_IPC_CHANNELS.runAction, 'unknown-action')).rejects.toThrow(
      '지원하지 않는 메뉴 작업입니다.'
    )

    dispose()
    expect(ipcMain.hasHandler(MENU_IPC_CHANNELS.runAction)).toBe(false)
  })
})
