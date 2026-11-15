import type { BrowserWindowConstructorOptions } from 'electron'

export interface NavigationGuardedWebContents {
  on(event: 'will-navigate', listener: (event: { preventDefault: () => void }, url: string) => void): unknown
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }): void
}

/**
 * Creates secure BrowserWindow options enforcing context isolation and disabled Node integration.
 */
export function createMainWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 560,
    show: false,
    title: 'Wiki Editor',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  }
}

/**
 * Blocks renderer-initiated document navigations and popups at the Electron BrowserWindow layer.
 */
export function registerWindowNavigationGuard(webContents: NavigationGuardedWebContents): void {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
}
