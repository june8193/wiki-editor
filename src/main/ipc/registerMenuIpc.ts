import { type MainMenuAction, MENU_IPC_CHANNELS } from '@shared/ipc'
import type { LogService } from '../logging/LogService'
import { type IpcHandlerTuple, type IpcMainLike, registerIpcHandlers } from './ipcHelpers'

export interface RegisterMenuIpcOptions {
  ipcMain: IpcMainLike
  onQuit: () => void
  onCopyBugReport: () => void
  onOpenLogFolder: () => void
  onShowVersion: () => void
  logService?: LogService
}

function isMainMenuAction(value: unknown): value is MainMenuAction {
  return (
    value === 'quit' ||
    value === 'copy-bug-report' ||
    value === 'open-log-folder' ||
    value === 'show-version'
  )
}

/**
 * Registers menu:run-action IPC handler for custom title-bar menu items backed by Electron main actions.
 */
export function registerMenuIpc({
  ipcMain,
  onQuit,
  onCopyBugReport,
  onOpenLogFolder,
  onShowVersion,
  logService
}: RegisterMenuIpcOptions): () => void {
  const handlers: readonly IpcHandlerTuple[] = [
    [
      MENU_IPC_CHANNELS.runAction,
      (_event, action) => {
        if (!isMainMenuAction(action)) {
          throw new Error('지원하지 않는 메뉴 작업입니다.')
        }
        switch (action) {
          case 'quit':
            onQuit()
            break
          case 'copy-bug-report':
            onCopyBugReport()
            break
          case 'open-log-folder':
            onOpenLogFolder()
            break
          case 'show-version':
            onShowVersion()
            break
        }
      }
    ]
  ]

  return registerIpcHandlers(ipcMain, handlers, { logService })
}
