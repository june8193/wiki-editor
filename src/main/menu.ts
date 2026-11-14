import type { BaseWindow, MenuItemConstructorOptions } from 'electron'
import { type AppMenuCommand, MENU_IPC_CHANNELS } from '@shared/ipc'
import type { WebContentsLike } from './ipc/ipcHelpers'

export interface CreateApplicationMenuOptions {
  getTargetWebContents: (targetWindow?: BaseWindow) => WebContentsLike | undefined
}

/**
 * Builds the Electron application menu template and routes custom commands to the active renderer.
 */
export function createApplicationMenuTemplate({
  getTargetWebContents
}: CreateApplicationMenuOptions): MenuItemConstructorOptions[] {
  const sendCommand = (command: AppMenuCommand, targetWindow?: BaseWindow): void => {
    const target = getTargetWebContents(targetWindow)
    if (target && !target.isDestroyed()) {
      target.send(MENU_IPC_CHANNELS.command, command)
    }
  }

  return [
    {
      label: 'File',
      submenu: [
        {
          label: '폴더 열기...',
          accelerator: 'CmdOrCtrl+O',
          click: (_menuItem, window) => sendCommand('open-folder', window)
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: '테마 전환',
          click: (_menuItem, window) => sendCommand('toggle-theme', window)
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Settings',
      submenu: [
        {
          label: '설정 패널',
          click: (_menuItem, window) => sendCommand('toggle-settings', window)
        }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }]
    }
  ]
}
