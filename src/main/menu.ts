import type { MenuItemConstructorOptions, MessageBoxOptions } from 'electron'

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

export interface ApplicationMenuDeps {
  onCopyBugReport: () => void
  onOpenLogFolder: () => void
  onShowVersion: () => void
}

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
 * Creates the application menu template containing Help > Copy Bug Report, Open Log Folder, and Version.
 */
export function createApplicationMenuTemplate({
  onCopyBugReport,
  onOpenLogFolder,
  onShowVersion
}: ApplicationMenuDeps): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Help',
      submenu: [
        {
          label: 'Copy Bug Report',
          click: () => {
            onCopyBugReport()
          }
        },
        {
          label: 'Open Log Folder',
          click: () => {
            onOpenLogFolder()
          }
        },
        {
          label: 'Version',
          click: () => {
            onShowVersion()
          }
        }
      ]
    }
  ]
}
