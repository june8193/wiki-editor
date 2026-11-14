import type { BaseWindow, MenuItemConstructorOptions, MessageBoxOptions } from 'electron'
import { type AppMenuCommand, MENU_IPC_CHANNELS } from '@shared/ipc'
import type { WebContentsLike } from './ipc/ipcHelpers'

export interface RuntimeVersions {
  electron?: string
  chrome?: string
  node?: string
}

export interface VersionDialogInput {
  appVersion: string
  versions: RuntimeVersions
}

export interface BugReportCopiedDialogInput {
  logFilePath: string
}

export interface CreateApplicationMenuOptions {
  getTargetWebContents?: (targetWindow?: BaseWindow) => WebContentsLike | undefined
  onCopyBugReport?: () => void
  onOpenLogFolder?: () => void
  onShowVersion?: () => void
}

export type ApplicationMenuDeps = CreateApplicationMenuOptions

/**
 * Builds native message box options displaying app and runtime versions.
 */
export function createVersionMessageBoxOptions({
  appVersion,
  versions
}: VersionDialogInput): MessageBoxOptions {
  const electronVersion = versions.electron ?? 'unknown'
  const chromeVersion = versions.chrome ?? 'unknown'
  const nodeVersion = versions.node ?? 'unknown'

  return {
    type: 'info',
    title: 'Wiki Editor',
    message: `Wiki Editor v${appVersion}`,
    detail: `Electron: ${electronVersion}\nChromium: ${chromeVersion}\nNode.js: ${nodeVersion}`,
    buttons: ['OK']
  }
}

/**
 * Builds native message box options confirming bug report copy and pointing to app.jsonl.
 */
export function createBugReportCopiedMessageBoxOptions({
  logFilePath
}: BugReportCopiedDialogInput): MessageBoxOptions {
  return {
    type: 'info',
    title: 'Wiki Editor',
    message: 'Bug report copied to clipboard.',
    detail: `Log file: ${logFilePath}`,
    buttons: ['OK']
  }
}

/**
 * Builds the Electron application menu template, routes custom commands to the active renderer,
 * and wires Help > Copy Bug Report, Open Log Folder, and Version actions.
 */
export function createApplicationMenuTemplate({
  getTargetWebContents,
  onCopyBugReport,
  onOpenLogFolder,
  onShowVersion
}: CreateApplicationMenuOptions): MenuItemConstructorOptions[] {
  const sendCommand = (command: AppMenuCommand, targetWindow?: BaseWindow): void => {
    const target = getTargetWebContents?.(targetWindow)
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
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Copy Bug Report',
          click: () => {
            onCopyBugReport?.()
          }
        },
        {
          label: 'Open Log Folder',
          click: () => {
            onOpenLogFolder?.()
          }
        },
        {
          label: 'Version',
          click: () => {
            onShowVersion?.()
          }
        }
      ]
    }
  ]
}
