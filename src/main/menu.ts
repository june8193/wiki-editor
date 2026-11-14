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

export interface ApplicationMenuDeps {
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
 * Creates the application menu template containing Help > Version.
 */
export function createApplicationMenuTemplate({
  onShowVersion
}: ApplicationMenuDeps): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Help',
      submenu: [
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
