import type { BrowserWindowConstructorOptions } from 'electron'

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
