import { SHELL_IPC_CHANNELS } from '@shared/ipc'
import { normalizeAllowedHttpUrl } from '@shared/urlSecurity'
import type { LogService } from '../logging/LogService'
import { type IpcHandlerTuple, type IpcMainLike, registerIpcHandlers } from './ipcHelpers'

export interface RegisterShellIpcOptions {
  ipcMain: IpcMainLike
  openExternal: (url: string) => Promise<void>
  logService?: LogService
}

/**
 * Registers shell:* IPC handlers usable from both main and auxiliary windows,
 * validating external URLs to `http`/`https` before invoking OS `shell.openExternal`.
 */
export function registerShellIpc({
  ipcMain,
  openExternal,
  logService
}: RegisterShellIpcOptions): () => void {
  const handlers: readonly IpcHandlerTuple[] = [
    [
      SHELL_IPC_CHANNELS.openExternalUrl,
      async (_event, rawUrl) => {
        const normalizedUrl = normalizeAllowedHttpUrl(rawUrl)
        if (!normalizedUrl) {
          return false
        }
        await openExternal(normalizedUrl)
        return true
      }
    ]
  ]

  return registerIpcHandlers(ipcMain, handlers, { logService })
}
